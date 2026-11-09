import * as fs from 'fs';
import * as vscode from 'vscode';
import { listSnapshots, saveSnapshot, Snapshot, snapshotPath } from './snapshot';

/**
 * 실행 및 디버그 패널의 "vstags 변수값 모음".
 * 지금 멈춘 함수의 스냅샷을 위에 추천하고, 누르면 그 값으로 변수를 덮어쓴다.
 */

type Saved = Snapshot & { path: string };
type Node = { kind: 'group'; label: string; items: Saved[]; current: boolean } | { kind: 'snap'; s: Saved };

export function registerSnapshotView(ctx: vscode.ExtensionContext, debugType: string): void {
  let current: { fn: string; file: string } | undefined;
  const emitter = new vscode.EventEmitter<void>();

  const rootFor = (file?: string): string | undefined => {
    const f = file ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) : undefined;
    return (f ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
  };
  const all = (): Saved[] => {
    const root = rootFor(current?.file);
    return root ? listSnapshots(root) : [];
  };
  const session = (): vscode.DebugSession | undefined => {
    const s = vscode.debug.activeDebugSession;
    return s?.type === debugType ? s : undefined;
  };

  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: emitter.event,
    getTreeItem(n) {
      if (n.kind === 'group') {
        const it = new vscode.TreeItem(n.label, n.current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon('symbol-function');
        it.description = `${n.items.length}개`;
        return it;
      }
      const s = n.s;
      const keys = Object.keys(s.values);
      const it = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
      it.iconPath = new vscode.ThemeIcon('history');
      it.description = `${keys.length}개 값 · ${s.saved}`;
      it.tooltip = new vscode.MarkdownString(
        ['**' + s.name + '** (' + s.function + ')', '', '```', ...keys.slice(0, 20).map((k) => `${k} = ${s.values[k]}`), keys.length > 20 ? '…' : '', '```', '', '클릭하면 지금 함수의 변수에 덮어씁니다'].join('\n'),
      );
      it.contextValue = 'snapshot';
      it.command = { command: 'vstags.sim.snapshot.apply', title: '변수값 적용', arguments: [n] };
      return it;
    },
    getChildren(n) {
      if (n) return n.kind === 'group' ? n.items.map((s) => ({ kind: 'snap', s }) as Node) : [];
      const snaps = all();
      const byFn = new Map<string, Saved[]>();
      for (const s of snaps) {
        const arr = byFn.get(s.function) ?? [];
        arr.push(s);
        byFn.set(s.function, arr);
      }
      const groups: Node[] = [];
      const cur = current?.fn;
      if (cur) groups.push({ kind: 'group', label: `${cur}  (지금 함수)`, items: byFn.get(cur) ?? [], current: true });
      for (const [fn, items] of byFn) if (fn !== cur) groups.push({ kind: 'group', label: fn, items, current: false });
      // 저장된 게 하나도 없으면 빈 목록 -> 안내 문구(viewsWelcome). 지금 함수 그룹은 비어 있어도 보여줌
      return snaps.length ? groups : [];
    },
  };

  const apply = async (s: Saved) => {
    const ses = session();
    if (!ses) return void vscode.window.showInformationMessage('vstags: 시뮬레이션이 멈춰 있을 때 적용할 수 있습니다');
    try {
      const res = (await ses.customRequest('vstagsSnapshotApply', { values: s.values, name: s.name })) as { applied: string[]; failed: { path: string; reason: string }[] };
      const other = current && s.function !== current.fn ? ` (다른 함수 ${s.function} 의 값 - 이름이 같은 변수에만 적용)` : '';
      if (res.failed.length) {
        void vscode.window.showWarningMessage(`vstags: '${s.name}' ${res.applied.length}개 적용, ${res.failed.length}개 적용 못 함: ${res.failed.map((f) => f.path).join(', ')}${other}`);
      } else {
        vscode.window.setStatusBarMessage(`vstags: '${s.name}' 변수값 ${res.applied.length}개 적용${other}`, 4000);
      }
    } catch (e) {
      void vscode.window.showWarningMessage(`vstags: ${e instanceof Error ? e.message : e}`);
    }
  };

  ctx.subscriptions.push(
    emitter,
    vscode.window.createTreeView('vstags.snapshots', { treeDataProvider: provider }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== debugType || e.event !== 'vstagsFrame') return;
      const b = e.body as { function: string; file: string };
      if (current?.fn !== b.function || current?.file !== b.file) {
        current = { fn: b.function, file: b.file };
        emitter.fire();
      }
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.type === debugType) current = undefined;
    }),
    vscode.commands.registerCommand('vstags.sim.snapshot.refresh', () => emitter.fire()),
    vscode.commands.registerCommand('vstags.sim.snapshot.save', async () => {
      const ses = session();
      if (!ses) return void vscode.window.showInformationMessage('vstags: 시뮬레이션이 멈춰 있을 때 저장할 수 있습니다');
      let res: { function: string; file: string; values: Record<string, string> };
      try {
        res = await ses.customRequest('vstagsSnapshotCollect');
      } catch (e) {
        return void vscode.window.showWarningMessage(`vstags: ${e instanceof Error ? e.message : e}`);
      }
      const n = Object.keys(res.values).length;
      if (!n) return void vscode.window.showInformationMessage('vstags: 저장할 값이 없습니다 (아직 정해진 변수값이 없음)');
      const root = rootFor(res.file);
      if (!root) return;
      const now = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      const name = await vscode.window.showInputBox({
        title: `변수값 저장: ${res.function} (${n}개 값)`,
        prompt: '이름 (예: 정상 1건, 데이터 없음)',
        value: `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : '이름을 입력하세요'),
      });
      if (!name) return;
      if (fs.existsSync(snapshotPath(root, res.function, name.trim()))) {
        const ok = await vscode.window.showWarningMessage(`'${name.trim()}' 이(가) 이미 있습니다. 덮어쓸까요?`, { modal: true }, '덮어쓰기');
        if (ok !== '덮어쓰기') return;
      }
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      saveSnapshot(root, { name: name.trim(), function: res.function, file: vscode.workspace.asRelativePath(res.file), saved: date, values: res.values });
      emitter.fire();
      vscode.window.setStatusBarMessage(`vstags: '${name.trim()}' 저장 (${res.function}, ${n}개 값)`, 4000);
    }),
    vscode.commands.registerCommand('vstags.sim.snapshot.apply', async (n?: Node) => {
      if (n?.kind === 'snap') return apply(n.s);
      // 명령 팔레트: 목록에서 고르기 (지금 함수 것 먼저)
      const snaps = all().sort((a, b) => Number(b.function === current?.fn) - Number(a.function === current?.fn));
      if (!snaps.length) return void vscode.window.showInformationMessage('vstags: 저장된 변수값이 없습니다');
      const pick = await vscode.window.showQuickPick(
        snaps.map((s) => ({ label: s.name, description: s.function + (s.function === current?.fn ? '  (지금 함수)' : ''), detail: `${Object.keys(s.values).length}개 값 · ${s.saved}`, s })),
        { title: '변수값 적용 (지금 함수의 변수에 덮어쓰기)' },
      );
      if (pick) await apply(pick.s);
    }),
    vscode.commands.registerCommand('vstags.sim.snapshot.open', async (n?: Node) => {
      if (n?.kind === 'snap') await vscode.window.showTextDocument(vscode.Uri.file(n.s.path));
    }),
    vscode.commands.registerCommand('vstags.sim.snapshot.delete', async (n?: Node) => {
      if (n?.kind !== 'snap') return;
      const ok = await vscode.window.showWarningMessage(`'${n.s.name}' (${n.s.function}) 를 삭제할까요?`, { modal: true }, '삭제');
      if (ok !== '삭제') return;
      fs.unlinkSync(n.s.path);
      emitter.fire();
    }),
  );
}
