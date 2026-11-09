import * as vscode from 'vscode';
import { DefKind } from '../core/types';

export const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;

export function wordAt(doc: vscode.TextDocument, pos: vscode.Position): { word: string; range: vscode.Range } | undefined {
  const range = doc.getWordRangeAtPosition(pos, WORD_RE);
  if (!range) return undefined;
  const word = doc.getText(range);
  if (/^\d/.test(word)) return undefined;
  return { word, range };
}

export function loc(path: string, line: number, col: number, len: number): vscode.Location {
  return new vscode.Location(vscode.Uri.file(path), new vscode.Range(line, col, line, col + len));
}

/**
 * 커서 단어 앞의 멤버 접근 경로.  `a.b[i]->c` 에서 c 위치면 { isMember: true, chain: ['a', 'b'] }
 * 경로를 해석할 수 없으면 chain 은 빈 배열.
 */
export function memberChain(text: string, wordStart: number): { isMember: boolean; chain: string[] } {
  let i = wordStart - 1;
  const ws = () => {
    while (i >= 0 && /\s/.test(text[i])) i--;
  };
  const accessor = (): boolean => {
    ws();
    if (text[i] === '.') {
      i--;
      return true;
    }
    if (text[i] === '>' && text[i - 1] === '-') {
      i -= 2;
      return true;
    }
    return false;
  };
  if (!accessor()) return { isMember: false, chain: [] };
  const chain: string[] = [];
  for (;;) {
    ws();
    while (text[i] === ']') {
      let d = 0;
      for (; i >= 0; i--) {
        if (text[i] === ']') d++;
        else if (text[i] === '[' && --d === 0) break;
      }
      i--;
      ws();
    }
    const end = i + 1;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) i--;
    const name = text.slice(i + 1, end);
    if (!name || /^\d/.test(name)) return { isMember: true, chain: [] };
    chain.unshift(name);
    if (!accessor()) break;
  }
  return { isMember: true, chain };
}

/** 커서 단어 바로 앞의 단어 (struct/union/enum 판정용) */
export function prevWord(text: string, wordStart: number): string | undefined {
  const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, wordStart));
  return m?.[1];
}

export function symbolKind(k: DefKind): vscode.SymbolKind {
  switch (k) {
    case 'function':
    case 'prototype':
      return vscode.SymbolKind.Function;
    case 'macro':
      return vscode.SymbolKind.Constant;
    case 'struct':
    case 'union':
      return vscode.SymbolKind.Struct;
    case 'enum':
      return vscode.SymbolKind.Enum;
    case 'enumerator':
      return vscode.SymbolKind.EnumMember;
    case 'typedef':
      return vscode.SymbolKind.TypeParameter;
    case 'member':
      return vscode.SymbolKind.Field;
    case 'cursor':
      return vscode.SymbolKind.Event;
    case 'label':
      return vscode.SymbolKind.Key;
    default:
      return vscode.SymbolKind.Variable;
  }
}

export function completionKind(k: DefKind): vscode.CompletionItemKind {
  switch (k) {
    case 'function':
    case 'prototype':
      return vscode.CompletionItemKind.Function;
    case 'macro':
      return vscode.CompletionItemKind.Constant;
    case 'struct':
    case 'union':
      return vscode.CompletionItemKind.Struct;
    case 'enum':
      return vscode.CompletionItemKind.Enum;
    case 'enumerator':
      return vscode.CompletionItemKind.EnumMember;
    case 'typedef':
      return vscode.CompletionItemKind.TypeParameter;
    case 'member':
      return vscode.CompletionItemKind.Field;
    default:
      return vscode.CompletionItemKind.Variable;
  }
}

export function kindIcon(k: DefKind): string {
  switch (k) {
    case 'function':
    case 'prototype':
      return '$(symbol-method)';
    case 'macro':
      return '$(symbol-constant)';
    case 'struct':
    case 'union':
      return '$(symbol-structure)';
    case 'enum':
      return '$(symbol-enum)';
    case 'enumerator':
      return '$(symbol-enum-member)';
    case 'typedef':
      return '$(symbol-type-parameter)';
    case 'member':
      return '$(symbol-field)';
    case 'cursor':
      return '$(database)';
    default:
      return '$(symbol-variable)';
  }
}

export function relPath(p: string): string {
  return vscode.workspace.asRelativePath(p, true);
}
