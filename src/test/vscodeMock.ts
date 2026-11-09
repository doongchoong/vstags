/* 테스트용 최소 vscode API 목(mock). providers 가 쓰는 부분만 구현. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from 'path';

export class Position {
  constructor(public line: number, public character: number) {}
}
export class Range {
  start: Position;
  end: Position;
  constructor(a: any, b: any, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b;
    }
  }
  union(o: Range): Range {
    const s = cmp(this.start, o.start) <= 0 ? this.start : o.start;
    const e = cmp(this.end, o.end) >= 0 ? this.end : o.end;
    return new Range(s, e);
  }
}
function cmp(a: Position, b: Position) {
  return a.line - b.line || a.character - b.character;
}
export class Uri {
  constructor(public fsPath: string, public scheme = 'file') {}
  static file(p: string) {
    return new Uri(p);
  }
  static joinPath(u: Uri, ...p: string[]) {
    return new Uri(path.join(u.fsPath, ...p));
  }
  toString() {
    return 'file://' + this.fsPath;
  }
}
export class Location {
  range: Range;
  constructor(public uri: Uri, r: Range | Position) {
    this.range = r instanceof Position ? new Range(r, r) : r;
  }
}
export enum SymbolKind {
  File = 0, Module, Namespace, Package, Class, Method, Property, Field, Constructor, Enum, Interface, Function,
  Variable, Constant, String, Number, Boolean, Array, Object, Key, Null, EnumMember, Struct, Event, Operator, TypeParameter,
}
export enum CompletionItemKind {
  Text = 0, Method, Function, Constructor, Field, Variable, Class, Interface, Module, Property, Unit, Value, Enum,
  Keyword, Snippet, Color, File, Reference, Folder, EnumMember, Constant, Struct, Event, Operator, TypeParameter,
}
export enum DocumentHighlightKind {
  Text = 0,
  Read = 1,
  Write = 2,
}
export class DocumentHighlight {
  constructor(public range: Range, public kind: DocumentHighlightKind) {}
}
export class MarkdownString {
  value = '';
  appendCodeblock(code: string, lang: string) {
    this.value += '```' + lang + '\n' + code + '\n```\n';
    return this;
  }
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
}
export class Hover {
  constructor(public contents: MarkdownString, public range?: Range) {}
}
export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(public name: string, public detail: string, public kind: SymbolKind, public range: Range, public selectionRange: Range) {}
}
export class SymbolInformation {
  constructor(public name: string, public kind: SymbolKind, public containerName: string, public location: Location) {}
}
export class CallHierarchyItem {
  constructor(public kind: SymbolKind, public name: string, public detail: string, public uri: Uri, public range: Range, public selectionRange: Range) {}
}
export class CallHierarchyIncomingCall {
  constructor(public from: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class CallHierarchyOutgoingCall {
  constructor(public to: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class CompletionItem {
  detail?: string;
  constructor(public label: any, public kind?: CompletionItemKind) {}
}
export class CompletionList {
  constructor(public items: CompletionItem[], public isIncomplete = false) {}
}
export class WorkspaceEdit {
  edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string) {
    this.edits.push({ uri, range, text });
  }
}
export class SemanticTokensLegend {
  constructor(public tokenTypes: string[], public tokenModifiers: string[]) {}
}
export class SemanticTokensBuilder {
  data: number[][] = [];
  constructor(_l?: SemanticTokensLegend) {}
  push(...a: number[]) {
    this.data.push(a);
  }
  build() {
    return { data: this.data };
  }
}
export class ThemeIcon {
  constructor(public id: string) {}
}

/** 테스트 입력 핸들러가 이 값을 돌려주면 입력 상자의 '건너뛰기' 버튼을 누른 것으로 처리 */
export const SKIP_BUTTON = '__skip_button__';

export class EventEmitter<T> {
  private ls: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.ls.push(l);
    return { dispose: () => (this.ls = this.ls.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of this.ls) l(e);
  }
  dispose() {}
}

const noopEvent = () => ({ dispose() {} });

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

/** 테스트에서 직접 발생시킬 수 있는 이벤트 */
export const events = {
  windowState: new EventEmitter<{ focused: boolean }>(),
  watcherChange: new EventEmitter<Uri>(),
};

export const window = {
  createOutputChannel: () => ({ lines: [] as string[], appendLine(l: string) { this.lines.push(l); }, show() {}, dispose() {} }),
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
  onDidChangeWindowState: events.windowState.event,
  withProgress: (_o: unknown, fn: (p: { report(): void }) => Promise<unknown>) => fn({ report() {} }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  /** 테스트에서 바꿔 끼우는 입력 핸들러 */
  quickPick: (async () => undefined) as (items: any[], opts: any) => Promise<any>,
  inputBox: (async () => undefined) as (opts: any) => Promise<string | undefined>,
  showQuickPick(items: any[], opts: any) {
    return this.quickPick(items, opts);
  },
  showInputBox(opts: any) {
    return this.inputBox(opts);
  },
  createInputBox() {
    const win = this;
    const ls: Record<'accept' | 'button' | 'hide', (() => void)[]> = { accept: [], button: [], hide: [] };
    const on = (k: 'accept' | 'button' | 'hide') => (f: () => void) => {
      ls[k].push(f);
      return { dispose() {} };
    };
    const box: any = {
      title: '', prompt: '', placeholder: '', value: '', ignoreFocusOut: false, buttons: [], validationMessage: undefined,
      onDidAccept: on('accept'), onDidTriggerButton: on('button'), onDidHide: on('hide'),
      hide: () => ls.hide.forEach((f) => f()),
      dispose() {},
      show() {
        void win.inputBox({ title: box.title, prompt: box.prompt }).then((v) => {
          if (v === SKIP_BUTTON) ls.button.forEach((f) => f());
          else if (v === undefined) ls.hide.forEach((f) => f());
          else {
            box.value = v;
            ls.accept.forEach((f) => f());
          }
        });
      },
    };
    return box;
  },
};

export const workspace = {
  /** findFiles 가 뒤질 루트 (테스트에서 지정) */
  _root: '',
  findFilesCalls: 0,
  textDocuments: [] as any[],
  getConfiguration: () => ({ get: (_k: string, d: any) => d }),
  asRelativePath: (p: string) => path.basename(p),
  onDidChangeConfiguration: noopEvent,
  onDidChangeWorkspaceFolders: noopEvent,
  onDidCloseTextDocument: noopEvent,
  createFileSystemWatcher: () => ({ onDidCreate: noopEvent, onDidChange: events.watcherChange.event, onDidDelete: noopEvent, dispose() {} }),
  async openTextDocument(u: Uri) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return makeDoc(u.fsPath, require('fs').readFileSync(u.fsPath, 'utf8'));
  },
  async findFiles(): Promise<Uri[]> {
    this.findFilesCalls++;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const out: Uri[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(c|h|pc|pcc)$/i.test(e.name)) out.push(Uri.file(p));
      }
    };
    walk(this._root);
    return out;
  },
};

/** 문자열로 TextDocument 흉내 */
export function makeDoc(fsPath: string, text: string): any {
  const lines = text.split(/\r?\n/);
  return {
    uri: Uri.file(fsPath),
    version: 1,
    isDirty: false,
    languageId: 'c',
    lineCount: lines.length,
    getText: (r?: Range) => {
      if (!r) return text;
      return lines[r.start.line].slice(r.start.character, r.end.character);
    },
    lineAt: (l: number) => ({ text: lines[l] }),
    getWordRangeAtPosition: (p: Position, re: RegExp) => {
      const t = lines[p.line];
      const g = new RegExp(re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = g.exec(t))) {
        if (m.index <= p.character && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length);
      }
      return undefined;
    },
  };
}
