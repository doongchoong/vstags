import * as vscode from 'vscode';
import { SymbolIndex } from '../core/symbolIndex';
import { SimDebugAdapter, SimLaunchArgs } from './debugAdapter';
import { registerSnapshotView } from './snapshotView';

export const SIM_DEBUG_TYPE = 'vstags-sim';

function enabled(): boolean {
  return vscode.workspace.getConfiguration('vstags').get<boolean>('simulator.enabled', false);
}

/** 블록 시뮬레이터 (실험 기능, 기본 꺼짐). 명령을 실행할 때만 동작하며 색인/탐색에는 관여하지 않는다 */
export function registerSimulator(ctx: vscode.ExtensionContext, getIndex: () => SymbolIndex): void {
  registerSnapshotView(ctx, SIM_DEBUG_TYPE);
  ctx.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(SIM_DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new SimDebugAdapter(getIndex)),
    }),
    vscode.debug.registerDebugConfigurationProvider(SIM_DEBUG_TYPE, {
      // launch.json 이나 F5 로 시작한 경우: 현재 편집기 커서/선택으로 채움
      resolveDebugConfiguration(_folder, config) {
        const ed = vscode.window.activeTextEditor;
        if (!config.file && ed) Object.assign(config, { type: SIM_DEBUG_TYPE, request: 'launch', name: config.name || 'vstags 블록 시뮬레이션' }, selectionArgs(ed));
        return config.file ? config : undefined;
      },
    }),
    vscode.commands.registerCommand('vstags.sim.start', async () => {
      if (!enabled()) {
        const pick = await vscode.window.showInformationMessage('vstags: 블록 시뮬레이터(실험 기능)가 꺼져 있습니다. 설정 vstags.simulator.enabled', '켜기');
        if (pick !== '켜기') return;
        await vscode.workspace.getConfiguration('vstags').update('simulator.enabled', true, vscode.ConfigurationTarget.Global);
      }
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(ed.document.uri), {
        type: SIM_DEBUG_TYPE,
        request: 'launch',
        name: 'vstags 블록 시뮬레이션',
        ...selectionArgs(ed),
      });
    }),
    vscode.commands.registerCommand('vstags.sim.jumpToCursor', async () => {
      const s = vscode.debug.activeDebugSession;
      const ed = vscode.window.activeTextEditor;
      if (s?.type !== SIM_DEBUG_TYPE || !ed) return;
      try {
        await s.customRequest('vstagsJump', { line: ed.selection.active.line });
      } catch (e) {
        void vscode.window.showWarningMessage(`vstags: ${e instanceof Error ? e.message : e}`);
      }
    }),
    vscode.commands.registerCommand('vstags.sim.skip', () => {
      const s = vscode.debug.activeDebugSession;
      if (s?.type === SIM_DEBUG_TYPE) void s.customRequest('vstagsSkip');
    }),
  );
}

function selectionArgs(ed: vscode.TextEditor): SimLaunchArgs {
  const sel = ed.selection;
  let end = sel.isEmpty ? -1 : sel.end.line;
  // 다음 줄 맨 앞까지 선택한 경우 그 줄은 제외
  if (!sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line) end--;
  return { file: ed.document.uri.fsPath, startLine: sel.start.line, endLine: end };
}
