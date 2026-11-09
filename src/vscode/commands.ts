import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { toCtags } from '../core/ctags';
import { DefKind, RefFlag, RefHit } from '../core/types';
import { IndexManager } from './indexManager';
import { resolve } from './providers';
import { kindIcon, loc, relPath, wordAt } from './util';

/** QuickPick 검색에서 쓰는 종류 접두사.  예) "f:load"  "m:MAX_"  "s:emp" */
const KIND_PREFIX: Record<string, DefKind[]> = {
  f: ['function', 'prototype'],
  m: ['macro'],
  s: ['struct', 'union', 'enum', 'typedef'],
  t: ['typedef'],
  v: ['variable', 'extern'],
  e: ['enumerator'],
  c: ['cursor'],
  mb: ['member'],
};

export function registerCommands(ctx: vscode.ExtensionContext, mgr: IndexManager): void {
  const reg = (id: string, fn: (...a: unknown[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('vstags.rebuildIndex', () => mgr.rebuild());

  reg('vstags.sync', async () => {
    await mgr.sync();
    const b = mgr.lastBuild;
    if (b) void vscode.window.showInformationMessage(`vstags: 변경 ${b.files}개 재색인, 삭제 ${b.removed}개 (${b.ms}ms)`);
  });

  reg('vstags.showStatus', async () => {
    const s = mgr.index.stats();
    const b = mgr.lastBuild;
    const msg =
      `vstags: ${s.files.toLocaleString()} files · ${s.defs.toLocaleString()} symbols · ${s.refs.toLocaleString()} references` +
      (b ? ` · 마지막 동기화 ${b.at.toLocaleTimeString()} (${b.files} files, ${b.ms}ms)` : '');
    const pick = await vscode.window.showInformationMessage(msg, 'Sync', 'Rebuild', 'Show Log');
    if (pick === 'Sync') void vscode.commands.executeCommand('vstags.sync');
    else if (pick === 'Rebuild') void mgr.rebuild();
    else if (pick === 'Show Log') {
      mgr.log.appendLine(`index file: ${mgr.storePath}`);
      mgr.log.show();
    }
  });

  reg('vstags.searchSymbol', async () => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { target?: vscode.Location }>();
    qp.placeholder = '심볼 이름 (접두사로 종류 지정: f: 함수, m: 매크로, s: 구조체/타입, v: 변수, e: 열거자, c: 커서, mb: 멤버)';
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const w = wordAt(editor.document, editor.selection.active);
      if (w) qp.value = w.word;
    }
    const update = () => {
      let q = qp.value.trim();
      let kinds: Set<DefKind> | undefined;
      const m = /^(\w+):(.*)$/.exec(q);
      if (m && KIND_PREFIX[m[1]]) {
        kinds = new Set(KIND_PREFIX[m[1]]);
        q = m[2].trim();
      }
      const hits = mgr.index.search(q, 300, kinds);
      qp.items = hits.map((h) => ({
        label: `${kindIcon(h.def.kind)} ${h.def.name}`,
        description: h.def.kind + (h.def.container ? ` · ${h.def.container}` : ''),
        detail: `${relPath(h.file.path)}:${h.def.line + 1}   ${(h.def.sig ?? '').split('\n')[0].slice(0, 120)}`,
        alwaysShow: true,
        target: loc(h.file.path, h.def.line, h.def.col, h.def.name.length),
      }));
    };
    qp.onDidChangeValue(update);
    qp.onDidAccept(async () => {
      const t = qp.selectedItems[0]?.target;
      qp.hide();
      if (t) await vscode.window.showTextDocument(t.uri, { selection: t.range });
    });
    qp.onDidHide(() => qp.dispose());
    update();
    qp.show();
  });

  /** 커서 단어를 대상으로 RefHit 목록을 peek 창으로 보여준다 */
  const showRefs = async (title: string, collect: (word: string, doc: vscode.TextDocument, pos: vscode.Position) => vscode.Location[]) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const pos = editor.selection.active;
    const w = wordAt(editor.document, pos);
    if (!w) return;
    const locs = collect(w.word, editor.document, pos);
    if (!locs.length) {
      void vscode.window.showInformationMessage(`vstags: '${w.word}' ${title} 없음`);
      return;
    }
    await vscode.commands.executeCommand('editor.action.showReferences', editor.document.uri, pos, locs);
  };
  const refLocs = (hits: RefHit[]) => hits.map((h) => loc(h.file.path, h.line, h.col, h.name.length));

  reg('vstags.findCallers', () =>
    showRefs('호출하는 곳', (word) => {
      const includePtr = vscode.workspace.getConfiguration('vstags').get<boolean>('callHierarchy.includeFunctionPointers', true);
      return refLocs(mgr.index.callers(word, includePtr, mgr.overrides()).flatMap((g) => g.hits));
    }),
  );

  reg('vstags.findCallees', async () => {
    for (const cmd of ['references-view.showOutgoingCalls', 'editor.showOutgoingCalls']) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        /* 다음 후보 */
      }
    }
  });

  reg('vstags.findAssignments', () =>
    showRefs('에 값을 대입하는 곳', (word, doc, pos) => {
      const r = resolve(mgr, doc, pos);
      if (!r || r.mode === 'include') return [];
      if (r.mode === 'local') {
        return refLocs(mgr.index.fileRefs(r.live, word, (f, enc) => enc === r.fnIdx && !!(f & RefFlag.Write)));
      }
      const member = r.mode === 'member';
      return refLocs(
        mgr.index.references(word, {
          overrides: mgr.overrides(),
          excludeShadowed: !member,
          filter: (f) => !!(f & RefFlag.Write) && !!(f & RefFlag.Member) === member,
        }),
      );
    }),
  );

  reg('vstags.findSqlHostUsages', () =>
    showRefs('의 EXEC SQL 사용처', (word) => refLocs(mgr.index.references(word, { overrides: mgr.overrides(), filter: (f) => !!(f & RefFlag.Sql) }))),
  );

  reg('vstags.findIncluders', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const name = path.basename(editor.document.uri.fsPath);
    const files = mgr.index.includers(name);
    if (!files.length) {
      void vscode.window.showInformationMessage(`vstags: '${name}' 을 include 하는 파일 없음`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: path.basename(f.path), description: relPath(f.path), path: f.path })),
      { placeHolder: `'${name}' 을 include 하는 파일 ${files.length}개` },
    );
    if (pick) await vscode.window.showTextDocument(vscode.Uri.file(pick.path));
  });

  reg('vstags.exportCtags', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder.uri, 'tags'), title: 'ctags 파일 저장' });
    if (!target) return;
    fs.writeFileSync(target.fsPath, toCtags(mgr.index.allFiles(), path.dirname(target.fsPath)));
    void vscode.window.showInformationMessage(`vstags: ${relPath(target.fsPath)} 저장됨`);
  });

}
