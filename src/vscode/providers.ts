import * as path from 'path';
import * as vscode from 'vscode';
import { CALLABLE_KINDS, DECLARATION_KINDS, DEFINITION_KINDS, enclosingFunction } from '../core/symbolIndex';
import { Def, DefHit, DefKind, FileIndex, REF_STRIDE, RefFlag, RefHit, SCOPED_KINDS } from '../core/types';
import { IndexManager } from './indexManager';
import { completionKind, loc, memberChain, prevWord, relPath, symbolKind, wordAt } from './util';

const AGG_KINDS: ReadonlySet<DefKind> = new Set<DefKind>(['struct', 'union', 'enum']);

export type Resolved =
  | { mode: 'include'; range: vscode.Range; files: FileIndex[] }
  | { mode: 'local'; word: string; range: vscode.Range; live: FileIndex; fnIdx: number; hit: DefHit }
  | { mode: 'member'; word: string; range: vscode.Range; hits: DefHit[] }
  | { mode: 'global'; word: string; range: vscode.Range; hits: DefHit[] };

/**
 * 커서 위치의 심볼이 무엇인지 해석한다. 모든 프로바이더가 공유.
 *   include  : #include "x.h" / EXEC SQL INCLUDE x
 *   local    : 함수 안의 지역 변수/파라미터/레이블
 *   member   : a.b / p->b 의 b
 *   global   : 그 외 (함수, 매크로, 타입, 전역 변수, 열거자, 커서 ...)
 */
export function resolve(mgr: IndexManager, doc: vscode.TextDocument, pos: vscode.Position): Resolved | undefined {
  const lineText = doc.lineAt(pos.line).text;
  const inc = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(lineText) ?? /\bEXEC\s+SQL\s+INCLUDE\s+["']?([\w./\\-]+)/i.exec(lineText);
  if (inc) {
    const start = lineText.indexOf(inc[1], inc.index);
    if (pos.character >= start && pos.character <= start + inc[1].length) {
      return { mode: 'include', range: new vscode.Range(pos.line, start, pos.line, start + inc[1].length), files: mgr.index.findFilesByName(inc[1]) };
    }
  }

  const w = wordAt(doc, pos);
  if (!w) return undefined;
  const { word, range } = w;
  const live = mgr.live(doc);
  const idx = mgr.index;

  const mc = memberChain(lineText, range.start.character);
  if (mc.isMember) {
    let baseType: string | undefined;
    if (mc.chain.length) {
      const l = findLocal(live, mc.chain[0], pos.line);
      baseType = l?.def.type ?? live.defs.find((d) => d.name === mc.chain[0] && (d.kind === 'variable' || d.kind === 'extern'))?.type;
    }
    return { mode: 'member', word, range, hits: idx.resolveMember(baseType, mc.chain, word) };
  }

  const local = findLocal(live, word, pos.line);
  if (local) return { mode: 'local', word, range, live, fnIdx: local.def.scope!, hit: local };

  const kinds = AGG_KINDS.has((prevWord(lineText, range.start.character) ?? '') as DefKind) ? AGG_KINDS : undefined;
  const here = doc.uri.fsPath;
  const liveHits: DefHit[] = [];
  const liveDecls: DefHit[] = [];
  live.defs.forEach((d, i) => {
    if (d.name !== word || SCOPED_KINDS.has(d.kind) || d.kind === 'member') return;
    if (kinds && !kinds.has(d.kind)) return;
    if (DEFINITION_KINDS.has(d.kind)) liveHits.push({ file: live, def: d, index: i });
    else if (DECLARATION_KINDS.has(d.kind)) liveDecls.push({ file: live, def: d, index: i });
  });
  let hits = liveHits;
  if (!hits.length) hits = idx.rankedDefinitions(word, here, kinds, here);
  if (!hits.length) hits = liveDecls;
  return { mode: 'global', word, range, hits };
}

/** 줄 line 에서 보이는 지역 변수/파라미터/레이블 */
export function findLocal(live: FileIndex, name: string, line: number): DefHit | undefined {
  const fn = enclosingFunction(live.defs, line);
  if (fn < 0) return undefined;
  let best: DefHit | undefined;
  live.defs.forEach((d, i) => {
    if (d.scope !== fn || d.name !== name) return;
    if (d.kind === 'label' || d.line <= line) {
      if (!best || d.line >= best.def.line) best = { file: live, def: d, index: i };
    }
  });
  return best;
}

function defLoc(h: DefHit): vscode.Location {
  return loc(h.file.path, h.def.line, h.def.col, h.def.name.length);
}
function refLoc(h: RefHit): vscode.Location {
  return loc(h.file.path, h.line, h.col, h.name.length);
}

function hitsToLocations(r: Resolved | undefined): vscode.Location[] | undefined {
  if (!r) return undefined;
  switch (r.mode) {
    case 'include':
      return r.files.map((f) => new vscode.Location(vscode.Uri.file(f.path), new vscode.Position(0, 0)));
    case 'local':
      return [defLoc(r.hit)];
    default:
      return r.hits.map(defLoc);
  }
}

export class CProviders
  implements
    vscode.DefinitionProvider,
    vscode.DeclarationProvider,
    vscode.ReferenceProvider,
    vscode.HoverProvider,
    vscode.DocumentSymbolProvider,
    vscode.WorkspaceSymbolProvider,
    vscode.CallHierarchyProvider,
    vscode.CompletionItemProvider,
    vscode.DocumentHighlightProvider,
    vscode.RenameProvider
{
  constructor(private readonly mgr: IndexManager) {}

  private get cfg() {
    return vscode.workspace.getConfiguration('vstags');
  }

  // ───────── 정의 / 선언 ─────────

  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location[] | undefined {
    return hitsToLocations(resolve(this.mgr, doc, pos));
  }

  provideDeclaration(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location[] | undefined {
    const w = wordAt(doc, pos);
    if (!w) return undefined;
    const decls = this.mgr.index.declarations(w.word);
    return decls.length ? decls.map(defLoc) : this.provideDefinition(doc, pos);
  }

  // ───────── 참조 ─────────

  /** 커서 심볼의 참조 위치 (references / highlight / rename 공용) */
  referencesOf(r: Resolved, includeDeclaration: boolean, doc: vscode.TextDocument): vscode.Location[] {
    const idx = this.mgr.index;
    const out: vscode.Location[] = [];
    if (r.mode === 'include') return out;
    if (r.mode === 'local') {
      if (includeDeclaration) out.push(defLoc(r.hit));
      for (const h of idx.fileRefs(r.live, r.word, (f, enc) => enc === r.fnIdx && !(f & RefFlag.Member))) out.push(refLoc(h));
      return out;
    }
    const overrides = this.mgr.overrides();
    if (r.mode === 'member') {
      if (includeDeclaration) out.push(...r.hits.map(defLoc));
      for (const h of idx.references(r.word, { overrides, filter: (f) => !!(f & RefFlag.Member) })) out.push(refLoc(h));
      return out;
    }
    const fileOnly = r.hits.length > 0 && r.hits.every((h) => h.def.kind === 'cursor');
    if (includeDeclaration) {
      for (const h of idx.definitions(r.word)) {
        if (h.def.kind === 'member' || (fileOnly && h.file.path !== doc.uri.fsPath)) continue;
        out.push(defLoc(h));
      }
    }
    for (const h of idx.references(r.word, { overrides, excludeShadowed: true, filter: (f) => !(f & RefFlag.Member) })) {
      if (fileOnly && h.file.path !== doc.uri.fsPath) continue;
      out.push(refLoc(h));
    }
    return dedupe(out);
  }

  provideReferences(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.ReferenceContext): vscode.Location[] | undefined {
    const r = resolve(this.mgr, doc, pos);
    if (!r) return undefined;
    return this.referencesOf(r, ctx.includeDeclaration, doc);
  }

  provideDocumentHighlights(doc: vscode.TextDocument, pos: vscode.Position): vscode.DocumentHighlight[] | undefined {
    const r = resolve(this.mgr, doc, pos);
    if (!r || r.mode === 'include') return undefined;
    const live = this.mgr.live(doc);
    const idx = this.mgr.index;
    const out: vscode.DocumentHighlight[] = [];
    const add = (line: number, col: number, write: boolean) =>
      out.push(new vscode.DocumentHighlight(new vscode.Range(line, col, line, col + r.word.length), write ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
    let filter: (f: number, enc: number) => boolean;
    if (r.mode === 'local') {
      add(r.hit.def.line, r.hit.def.col, true);
      filter = (f, enc) => enc === r.fnIdx && !(f & RefFlag.Member);
    } else if (r.mode === 'member') {
      filter = (f) => !!(f & RefFlag.Member);
    } else {
      filter = (f, enc) => !(f & RefFlag.Member) && !idx.isShadowed(live, enc, r.word);
      for (const d of live.defs) if (d.name === r.word && !SCOPED_KINDS.has(d.kind) && d.kind !== 'member') add(d.line, d.col, true);
    }
    if (r.mode === 'member') for (const d of live.defs) if (d.name === r.word && d.kind === 'member') add(d.line, d.col, true);
    for (const h of idx.fileRefs(live, r.word, filter)) add(h.line, h.col, !!(h.flags & RefFlag.Write));
    return out;
  }

  // ───────── 이름 바꾸기 ─────────

  prepareRename(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range {
    const r = resolve(this.mgr, doc, pos);
    if (!r || r.mode === 'include') throw new Error('vstags: 이름을 바꿀 수 있는 심볼이 아닙니다.');
    if (r.mode !== 'local' && !r.hits.length) throw new Error(`vstags: '${r.word}' 의 정의를 색인에서 찾지 못했습니다 (외부 심볼?).`);
    return r.range;
  }

  provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string): vscode.WorkspaceEdit | undefined {
    const r = resolve(this.mgr, doc, pos);
    if (!r || r.mode === 'include') return undefined;
    const edit = new vscode.WorkspaceEdit();
    for (const l of this.referencesOf(r, true, doc)) edit.replace(l.uri, l.range, newName);
    return edit;
  }

  // ───────── 호버 ─────────

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.cfg.get<boolean>('enableHover', true)) return undefined;
    const r = resolve(this.mgr, doc, pos);
    if (!r || r.mode === 'include') return undefined;
    const hits = r.mode === 'local' ? [r.hit] : r.hits;
    if (!hits.length) return undefined;
    const md = new vscode.MarkdownString();
    for (const h of hits.slice(0, 3)) {
      md.appendCodeblock(this.hoverCode(h.def), 'c');
      const docText = this.docOf(h.def);
      if (docText) md.appendMarkdown(docText.split('\n').map(mdEscape).join('  \n') + '\n\n');
      const where = h.file.path === doc.uri.fsPath ? `line ${h.def.line + 1}` : `${relPath(h.file.path)}:${h.def.line + 1}`;
      const extra = h.def.container && (h.def.kind === 'member' || h.def.kind === 'enumerator') ? ` · ${h.def.container}` : '';
      md.appendMarkdown(`*${h.def.kind}*${extra} — ${where}\n\n`);
    }
    if (hits.length > 3) md.appendMarkdown(`…외 ${hits.length - 3}개 정의\n`);
    return new vscode.Hover(md, r.range);
  }

  /** 정의의 주석. typedef 에 주석이 없으면 가리키는 구조체의 주석 */
  private docOf(d: Def): string | undefined {
    if (d.doc) return d.doc;
    if (d.kind !== 'typedef') return undefined;
    const tag = this.mgr.index.resolveType(d.type ?? d.name);
    return tag ? this.mgr.index.definitions(tag).find((h) => AGG_KINDS.has(h.def.kind) && h.def.doc)?.def.doc : undefined;
  }

  private hoverCode(d: Def): string {
    const idx = this.mgr.index;
    let code = d.sig ?? d.name;
    if (d.kind === 'function') code = code.replace(/\s*\{?\s*$/, '');
    // 구조체/열거형이면 멤버 목록
    let container: string | undefined;
    if (AGG_KINDS.has(d.kind)) container = d.name;
    else if (d.kind === 'typedef') container = idx.resolveType(d.type ?? d.name);
    if (container) {
      const members = idx.members(container);
      if (members.length) {
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const m of members) {
          if (seen.has(m.def.name)) continue;
          seen.add(m.def.name);
          const note = m.def.doc ? '  // ' + m.def.doc.split('\n')[0] : '';
          lines.push('    ' + (m.def.sig ?? m.def.name) + (m.def.kind === 'enumerator' ? ',' : ';') + note);
          if (lines.length >= 40) {
            lines.push('    …');
            break;
          }
        }
        code += ' {\n' + lines.join('\n') + '\n}';
      }
    }
    return code;
  }

  // ───────── 심볼 (Outline / Ctrl+Shift+O / Ctrl+T) ─────────

  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const live = this.mgr.live(doc);
    const top: vscode.DocumentSymbol[] = [];
    const parents = new Map<string, vscode.DocumentSymbol>();
    const lastLine = Math.max(0, doc.lineCount - 1);
    const mk = (d: Def, detail: string) => {
      const end = Math.min(d.endLine ?? d.line, lastLine);
      const endCol = end === d.line ? d.col + d.name.length : doc.lineAt(end).text.length;
      const sel = new vscode.Range(d.line, d.col, d.line, d.col + d.name.length);
      return new vscode.DocumentSymbol(d.name, detail, symbolKind(d.kind), new vscode.Range(d.line, d.line === end ? d.col : 0, end, endCol).union(sel), sel);
    };
    const children: Def[] = [];
    for (const d of live.defs) {
      if (SCOPED_KINDS.has(d.kind)) continue;
      if (d.kind === 'member' || d.kind === 'enumerator') {
        children.push(d);
        continue;
      }
      const s = mk(d, d.kind === 'function' || d.kind === 'macro' ? '' : d.kind);
      if (d.kind === 'prototype') s.detail = 'prototype';
      top.push(s);
      if (AGG_KINDS.has(d.kind) || ((d.kind === 'typedef' || d.kind === 'variable') && !parents.has(d.name))) parents.set(d.name, s);
    }
    for (const d of children) {
      const p = d.container ? parents.get(d.container) : undefined;
      const s = mk(d, d.kind === 'member' ? (d.type ?? '') : '');
      if (p) p.children.push(s);
      else top.push(s);
    }
    return top;
  }

  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    if (!query) return [];
    return this.mgr.index.search(query, 500).map(
      (h) =>
        new vscode.SymbolInformation(
          h.def.name,
          symbolKind(h.def.kind),
          h.def.container ?? (h.def.kind === 'prototype' || h.def.kind === 'extern' ? h.def.kind : ''),
          defLoc(h),
        ),
    );
  }

  // ───────── Call Hierarchy (cscope 의 "이 함수를 호출하는 함수들") ─────────

  private callItem(h: DefHit): vscode.CallHierarchyItem {
    const d = h.def;
    const end = d.endLine ?? d.line;
    const sel = new vscode.Range(d.line, d.col, d.line, d.col + d.name.length);
    const kind = d.kind === 'macro' ? vscode.SymbolKind.Constant : d.kind === 'variable' ? vscode.SymbolKind.Variable : vscode.SymbolKind.Function;
    const detail = `${relPath(h.file.path)}:${d.line + 1}${d.kind === 'function' ? '' : ' (' + d.kind + ')'}`;
    return new vscode.CallHierarchyItem(kind, d.name, detail, vscode.Uri.file(h.file.path), new vscode.Range(d.line, 0, end, 0).union(sel), sel);
  }

  prepareCallHierarchy(doc: vscode.TextDocument, pos: vscode.Position): vscode.CallHierarchyItem[] | undefined {
    const r = resolve(this.mgr, doc, pos);
    if (!r || r.mode !== 'global') return undefined;
    let hits = r.hits.filter((h) => CALLABLE_KINDS.has(h.def.kind));
    if (!hits.length) {
      // 정의가 색인에 없는 외부 함수(printf 등)도 호출자 검색은 가능하게
      const word = r.word;
      const sel = r.range;
      return [new vscode.CallHierarchyItem(vscode.SymbolKind.Function, word, '(external)', doc.uri, sel, sel)];
    }
    // 정의가 있으면 프로토타입은 숨김
    const defs = hits.filter((h) => h.def.kind !== 'prototype');
    if (defs.length) hits = defs;
    return hits.map((h) => this.callItem(h));
  }

  /** CallHierarchyItem -> 색인의 (파일, 정의 인덱스) */
  private itemDef(item: vscode.CallHierarchyItem): DefHit | undefined {
    const p = item.uri.fsPath;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p);
    const fi = doc ? this.mgr.live(doc) : this.mgr.index.getFile(p);
    if (!fi) return undefined;
    const line = item.selectionRange.start.line;
    const i = fi.defs.findIndex((d) => d.name === item.name && d.line === line);
    if (i < 0) return undefined;
    let h: DefHit = { file: fi, def: fi.defs[i], index: i };
    if (h.def.kind === 'prototype') {
      const f = this.mgr.index.rankedDefinitions(item.name, p, CALLABLE_KINDS).find((x) => x.def.kind === 'function' || x.def.kind === 'macro');
      if (f) h = f;
    }
    return h;
  }

  provideCallHierarchyIncomingCalls(item: vscode.CallHierarchyItem): vscode.CallHierarchyIncomingCall[] {
    const includePtr = this.cfg.get<boolean>('callHierarchy.includeFunctionPointers', true);
    const out: vscode.CallHierarchyIncomingCall[] = [];
    for (const g of this.mgr.index.callers(item.name, includePtr, this.mgr.overrides())) {
      const ranges = g.hits.map((h) => new vscode.Range(h.line, h.col, h.line, h.col + h.name.length));
      let from: vscode.CallHierarchyItem;
      if (g.from && (g.from.def.kind === 'function' || g.from.def.kind === 'macro' || g.from.def.kind === 'variable')) {
        from = this.callItem(g.from);
      } else {
        // 파일 최상위 (전역 초기화식 등)
        from = new vscode.CallHierarchyItem(vscode.SymbolKind.File, path.basename(g.file.path), relPath(g.file.path) + ' (file scope)', vscode.Uri.file(g.file.path), ranges[0], ranges[0]);
      }
      out.push(new vscode.CallHierarchyIncomingCall(from, ranges));
    }
    return out;
  }

  provideCallHierarchyOutgoingCalls(item: vscode.CallHierarchyItem): vscode.CallHierarchyOutgoingCall[] {
    const h = this.itemDef(item);
    if (!h) return [];
    const out: vscode.CallHierarchyOutgoingCall[] = [];
    for (const g of this.mgr.index.callees(h.file, h.index)) {
      const target = this.mgr.index.rankedDefinitions(g.name, h.file.path, CALLABLE_KINDS)[0];
      if (!target) continue; // 라이브러리 함수 등 색인 밖
      const ranges = g.hits.map((x) => new vscode.Range(x.line, x.col, x.line, x.col + x.name.length));
      out.push(new vscode.CallHierarchyOutgoingCall(this.callItem(target), ranges));
    }
    return out;
  }

  // ───────── 자동완성 ─────────

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionList | undefined {
    if (!this.cfg.get<boolean>('enableCompletion', true)) return undefined;
    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, pos.character);
    const m = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(before);
    const prefix = m ? m[0] : '';
    const wordStart = pos.character - prefix.length;
    const idx = this.mgr.index;
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (d: Def, file: string) => {
      if (seen.has(d.name)) return;
      seen.add(d.name);
      const it = new vscode.CompletionItem({ label: d.name, description: d.kind === 'member' ? d.type : path.basename(file) }, completionKind(d.kind));
      it.detail = d.sig?.split('\n')[0];
      if (d.doc) it.documentation = d.doc;
      items.push(it);
    };

    const mc = memberChain(lineText, wordStart);
    if (mc.isMember) {
      const live = this.mgr.live(doc);
      let baseType: string | undefined;
      if (mc.chain.length) baseType = findLocal(live, mc.chain[0], pos.line)?.def.type;
      // 마지막 멤버 이름 대신 빈 이름으로 타입만 해석
      let type = baseType ?? (mc.chain.length ? idx.definitions(mc.chain[0]).find((h) => h.def.kind === 'variable' || h.def.kind === 'extern')?.def.type : undefined);
      type = idx.resolveType(type);
      for (let i = 1; type && i < mc.chain.length; i++) type = idx.resolveType(idx.members(type).find((h) => h.def.name === mc.chain[i])?.def.type);
      if (type) for (const h of idx.members(type)) if (h.def.kind === 'member') add(h.def, h.file.path);
      return new vscode.CompletionList(items, false);
    }
    if (prefix.length < 2) return undefined;

    const live = this.mgr.live(doc);
    const fn = enclosingFunction(live.defs, pos.line);
    for (const d of live.defs) {
      if (!d.name.startsWith(prefix) && !d.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      if (SCOPED_KINDS.has(d.kind) ? d.scope === fn : d.kind !== 'member') add(d, doc.uri.fsPath);
    }
    for (const h of idx.namesWithPrefix(prefix, 300)) add(h.def, h.file.path);
    return new vscode.CompletionList(items, true);
  }
}

/** 주석을 마크다운에 그대로 보이게 (특수문자 이스케이프) */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (ch) => '\\' + ch);
}

function dedupe(locs: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${l.uri.fsPath}:${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ───────── Semantic Tokens: 매크로/타입/열거자/전역변수 등을 구분해서 색칠 ─────────

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
  ['macro', 'function', 'type', 'struct', 'enum', 'enumMember', 'variable', 'parameter', 'property', 'label'],
  ['declaration', 'static', 'global', 'readonly'],
);
const TT = Object.fromEntries(SEMANTIC_LEGEND.tokenTypes.map((t, i) => [t, i])) as Record<string, number>;
const MOD = { declaration: 1, static: 2, global: 4, readonly: 8 };

export class SemanticTokens implements vscode.DocumentSemanticTokensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.emitter.event;

  constructor(private readonly mgr: IndexManager) {
    mgr.onDidChange(() => this.emitter.fire());
  }

  private classify(kind: DefKind): [number, number] | undefined {
    switch (kind) {
      case 'macro':
        return [TT.macro, 0];
      case 'function':
      case 'prototype':
        return [TT.function, 0];
      case 'typedef':
        return [TT.type, 0];
      case 'struct':
      case 'union':
        return [TT.struct, 0];
      case 'enum':
        return [TT.enum, 0];
      case 'enumerator':
        return [TT.enumMember, MOD.readonly];
      case 'variable':
      case 'extern':
        return [TT.variable, MOD.global];
      case 'cursor':
        return [TT.variable, MOD.readonly];
      case 'member':
        return [TT.property, 0];
      case 'param':
        return [TT.parameter, 0];
      case 'local':
        return [TT.variable, 0];
      case 'label':
        return [TT.label, 0];
    }
    return undefined;
  }

  provideDocumentSemanticTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
    const live = this.mgr.live(doc);
    const idx = this.mgr.index;
    const toks: number[][] = [];
    const localKind = new Map<string, DefKind>(); // `${scope}:${name}`
    const fileKind = new Map<string, DefKind>();
    for (const d of live.defs) {
      if (d.scope !== undefined) localKind.set(`${d.scope}:${d.name}`, d.kind);
      else if (d.kind !== 'member' && !fileKind.has(d.name)) fileKind.set(d.name, d.kind);
      const c = this.classify(d.kind);
      if (c) toks.push([d.line, d.col, d.name.length, c[0], c[1] | MOD.declaration | (d.isStatic ? MOD.static : 0)]);
    }
    const globalKind = new Map<string, DefKind | null>();
    const kindOf = (name: string): DefKind | undefined => {
      const fk = fileKind.get(name);
      if (fk) return fk;
      let g = globalKind.get(name);
      if (g === undefined) {
        const hits = idx.definitions(name).filter((h) => h.def.kind !== 'member');
        g = (hits.find((h) => DEFINITION_KINDS.has(h.def.kind)) ?? hits[0])?.def.kind ?? null;
        globalKind.set(name, g);
      }
      return g ?? undefined;
    };
    const r = live.refs;
    for (let k = 0; k < r.length; k += REF_STRIDE) {
      const name = live.names[r[k]];
      const flags = r[k + 3];
      const enc = r[k + 4];
      let kind: DefKind | undefined;
      if (flags & RefFlag.Member) kind = 'member';
      else kind = localKind.get(`${enc}:${name}`) ?? kindOf(name);
      if (!kind) continue;
      const c = this.classify(kind);
      if (c) toks.push([r[k + 1], r[k + 2], name.length, c[0], c[1]]);
    }
    toks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const b = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
    let pl = -1;
    let pc = -1;
    for (const t of toks) {
      if (t[0] === pl && t[1] === pc) continue;
      b.push(t[0], t[1], t[2], t[3], t[4]);
      pl = t[0];
      pc = t[1];
    }
    return b.build();
  }
}
