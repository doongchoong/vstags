import * as vscode from 'vscode';
import { IndexManager } from '../vscode/indexManager';
import { lintSource, LintIssue, LintOptions } from './lint';

function settings(): { enabled: boolean; opts: LintOptions } {
  const c = vscode.workspace.getConfiguration('vstags');
  return {
    enabled: c.get<boolean>('lint.enabled', false),
    opts: {
      rules: c.get<LintOptions['rules']>('lint.rules', {}),
      prefixes: c.get<LintOptions['prefixes']>('lint.prefixes', undefined),
      sqlCheckNames: c.get<string[]>('lint.sqlCheckNames', []),
    },
  };
}

const SEVERITY = {
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

function toDiagnostic(uri: vscode.Uri, i: LintIssue): vscode.Diagnostic {
  const d = new vscode.Diagnostic(new vscode.Range(i.line, i.col, i.endLine, i.endCol), i.message, SEVERITY[i.severity]);
  d.source = 'vstags';
  d.code = i.rule;
  // 묶은 경고: 문제 패널에서 하위 항목으로 각 위치 표시 (VS Code 의 파일당 개수 제한에는 하나로 셈)
  if (i.related) {
    d.relatedInformation = i.related.map(
      (r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, new vscode.Range(r.line, r.col, r.endLine, r.endCol)), r.message),
    );
  }
  return d;
}

/**
 * 코드 컨벤션 검사 (실험 기능, 기본 꺼짐).
 * 화면에 보이는 편집기의 문서만 검사하고, 안 보이게 된 문서의 결과는 지운다.
 * (탭을 닫아도 문서 닫힘 이벤트는 한참 뒤에 오거나 안 오므로 열린 문서 기준으로 하면 결과가 쌓인다)
 */
export function registerLint(ctx: vscode.ExtensionContext, mgr: IndexManager): void {
  const coll = vscode.languages.createDiagnosticCollection('vstags-lint');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** uri -> 마지막으로 검사한 문서 버전 */
  const checked = new Map<string, number>();

  const visible = () => new Map(vscode.window.visibleTextEditors.map((e) => [e.document.uri.toString(), e.document] as const));

  const check = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    const s = settings();
    if (!s.enabled || !mgr.isTracked(doc)) {
      coll.delete(doc.uri);
      checked.delete(key);
      return;
    }
    try {
      coll.set(doc.uri, lintSource(doc.uri.fsPath, doc.getText(), mgr.live(doc), mgr.index, s.opts).map((i) => toDiagnostic(doc.uri, i)));
      checked.set(key, doc.version);
    } catch (e) {
      coll.delete(doc.uri);
      checked.delete(key);
      console.error('vstags lint:', e);
    }
  };
  /** 보이는 문서만 남긴다. force 면 이미 검사한 버전도 다시 검사 */
  const refresh = (force: boolean) => {
    const vis = visible();
    coll.forEach((uri) => {
      const key = uri.toString();
      if (!vis.has(key)) {
        coll.delete(uri);
        checked.delete(key);
        clearTimeout(timers.get(key));
      }
    });
    for (const [key, doc] of vis) if (force || checked.get(key) !== doc.version) check(doc);
  };
  const later = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    if (!visible().has(key)) return;
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (visible().has(key)) check(doc);
      }, 700),
    );
  };

  ctx.subscriptions.push(
    coll,
    vscode.window.onDidChangeVisibleTextEditors(() => refresh(false)),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vstags.lint') || e.affectsConfiguration('vstags.languages')) refresh(true);
    }),
    // 색인이 갱신되면 typedef/매크로를 다시 찾을 수 있으므로 (시작 직후 등)
    mgr.onDidChange(() => {
      if (settings().enabled) refresh(true);
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
  refresh(true);
}
