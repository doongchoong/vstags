import * as vscode from 'vscode';
import { registerLint } from './lint/register';
import { registerSimulator } from './sim/register';
import { registerCommands } from './vscode/commands';
import { IndexManager } from './vscode/indexManager';
import { CProviders, SEMANTIC_LEGEND, SemanticTokens } from './vscode/providers';

let manager: IndexManager | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const mgr = new IndexManager(ctx);
  manager = mgr;
  ctx.subscriptions.push(mgr);

  const providers = new CProviders(mgr);
  const selector: vscode.DocumentFilter[] = mgr.languages.flatMap((language) => [
    { language, scheme: 'file' },
    { language, scheme: 'untitled' },
  ]);
  const L = vscode.languages;
  ctx.subscriptions.push(
    L.registerDefinitionProvider(selector, providers),
    L.registerDeclarationProvider(selector, providers),
    L.registerReferenceProvider(selector, providers),
    L.registerHoverProvider(selector, providers),
    L.registerDocumentSymbolProvider(selector, providers, { label: 'vstags' }),
    L.registerWorkspaceSymbolProvider(providers),
    L.registerCallHierarchyProvider(selector, providers),
    L.registerDocumentHighlightProvider(selector, providers),
    L.registerRenameProvider(selector, providers),
    L.registerCompletionItemProvider(selector, providers, '.', '>'),
  );

  // 시맨틱 하이라이트: auto 면 .pc 는 항상, .c 는 C/C++ 확장이 없을 때만
  const sem = vscode.workspace.getConfiguration('vstags').get<string>('semanticHighlighting', 'auto');
  if (sem !== 'off') {
    const hasCpptools = !!vscode.extensions.getExtension('ms-vscode.cpptools');
    const langs = sem === 'all' || !hasCpptools ? mgr.languages : mgr.languages.filter((l) => l !== 'c' && l !== 'cpp');
    if (langs.length) {
      ctx.subscriptions.push(
        L.registerDocumentSemanticTokensProvider(
          langs.map((language) => ({ language })),
          new SemanticTokens(mgr),
          SEMANTIC_LEGEND,
        ),
      );
    }
  }

  registerCommands(ctx, mgr);
  registerSimulator(ctx, () => mgr.index);
  registerLint(ctx, mgr);
  void mgr.start();
}

export async function deactivate(): Promise<void> {
  await manager?.save();
}
