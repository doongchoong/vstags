import { Comment, lex, Tk, Token } from './lexer';
import { filterConditionals } from './preproc';
import { Def, DefKind, RefFlag } from './types';

/**
 * 휴리스틱 C 파서 (ctags/cscope 수준).
 *
 * 완전한 C 문법 파서가 아니라 "토큰 흐름 + 중괄호 깊이" 기반으로 정의와 참조를 뽑는다.
 * 알 수 없는 매크로, Pro*C 구문, 전처리 분기 등으로 문법이 깨져도 예외 없이 계속 진행하는 것이 목표.
 */

export interface ParseResult {
  defs: Def[];
  names: string[];
  refs: Int32Array;
  includes: string[];
}

type PTok = Token & { i: number };

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  '_Bool', '_Complex', '_Imaginary', '_Alignas', '_Alignof', '_Atomic', '_Generic', '_Noreturn',
  '_Static_assert', '_Thread_local', '__attribute__', '__attribute', '__inline', '__inline__', '__restrict',
  '__restrict__', '__volatile__', '__volatile', '__const', '__extension__', '__asm__', '__asm', 'asm',
  '__declspec', '__cdecl', '__stdcall', '__fastcall', 'typeof', '__typeof__', '__typeof', '__thread',
]);

/** 문장 맨 앞에 오면 지역 변수 선언으로 간주하는 키워드 */
const DECL_START_KW = new Set([
  'char', 'const', 'double', 'enum', 'extern', 'float', 'int', 'long', 'register', 'short', 'signed', 'static',
  'struct', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'auto', '_Bool', '_Complex', '_Atomic',
  '__const', '__extension__', '_Thread_local', '__thread', 'inline', '__inline', '__inline__',
]);

/** 타입 이름을 뽑을 때 건너뛰는 지정자 */
const SPEC_SKIP = new Set([
  'const', 'volatile', 'static', 'extern', 'register', 'auto', 'inline', '__inline', '__inline__', 'restrict',
  '__restrict', '__restrict__', 'typedef', '_Thread_local', '__thread', '__extension__', '_Atomic', '__const',
  '__volatile__', '__volatile', 'struct', 'union', 'enum', 'signed', 'unsigned', '__cdecl', '__stdcall',
  '__fastcall',
]);

const AGG_KW = new Set(['struct', 'union', 'enum']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '++', '--']);
const ATTR_KW = new Set(['__attribute__', '__attribute', '__declspec', '__asm__', '__asm', 'asm', '_Alignas']);

/** 주석 본문 정리: 기호(/* * //)와 장식 줄(*****, ----) 제거, 앞부분만 */
function cleanComment(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*+\s?/, '').replace(/\s*\*+\s*$/, '').trimEnd())
    .filter((l) => !/^\s*[-=*#~_+/\\]{3,}\s*$/.test(l))
    .map((l) => l.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const s = lines.join('\n');
  return s.length > 600 ? s.slice(0, 600) + ' …' : s;
}

/**
 * 정의에 주석 붙이기.
 *  - 위: 정의가 시작하는 줄 바로 위에서 빈 줄 없이 이어진, 자기 줄에 있는 주석들
 *  - 옆: 같은 줄 오른쪽 주석 -> 그 줄에서 주석보다 앞에 있는 정의 중 가장 오른쪽 것
 */
function attachDocs(defs: Def[], comments: Comment[], startLines: Map<number, number>): void {
  if (!comments.length) return;
  const ownByEnd = new Map<number, Comment>();
  const trailing = new Map<number, Comment[]>();
  for (const c of comments) {
    if (c.ownLine) ownByEnd.set(c.endLine, c);
    else {
      const arr = trailing.get(c.line) ?? [];
      arr.push(c);
      trailing.set(c.line, arr);
    }
  }
  const docs: string[][] = defs.map(() => []);
  defs.forEach((d, i) => {
    if (d.kind === 'label') return;
    const block: string[] = [];
    for (let c = ownByEnd.get((startLines.get(i) ?? d.line) - 1); c; c = ownByEnd.get(c.line - 1)) block.unshift(cleanComment(c.text));
    if (block.some(Boolean)) docs[i].push(block.filter(Boolean).join('\n'));
  });
  const byLine = new Map<number, number[]>();
  defs.forEach((d, i) => {
    if (d.kind === 'label' || !trailing.has(d.line)) return;
    const arr = byLine.get(d.line) ?? [];
    arr.push(i);
    byLine.set(d.line, arr);
  });
  for (const [line, cs] of trailing) {
    for (const c of cs) {
      let best = -1;
      for (const i of byLine.get(line) ?? []) if (defs[i].col < c.col && (best < 0 || defs[i].col > defs[best].col)) best = i;
      const t = cleanComment(c.text);
      if (best >= 0 && t) docs[best].push(t);
    }
  }
  defs.forEach((d, i) => {
    if (docs[i].length) d.doc = docs[i].join('\n');
  });
}

function isP(t: Token | undefined, v: string): boolean {
  return !!t && t.k === Tk.Punct && t.v === v;
}
function isName(t: Token | undefined): boolean {
  return !!t && t.k === Tk.Ident && !KEYWORDS.has(t.v);
}

interface Declarator {
  name: PTok;
  isFunc: boolean;
  /** 함수 선언자의 파라미터 괄호 [open, close] (piece 기준 인덱스가 아니라 토큰) */
  paramToks?: PTok[];
  sig: string;
}

interface Declaration {
  typeName?: string;
  isTypedef: boolean;
  isExtern: boolean;
  isStatic: boolean;
  decls: Declarator[];
}

interface AggOuter {
  placeholder: string;
  memberIdxs: number[];
}

let aggCounter = 0;

export function parseSource(src: string): ParseResult {
  const parser = new Parser(src);
  parser.parseTop();
  return parser.result();
}

class Parser {
  private readonly toks: PTok[];
  private p = 0;
  private readonly defs: Def[] = [];
  private readonly names: string[] = [];
  private readonly nameIdx = new Map<string, number>();
  private readonly refs: number[] = [];
  private readonly includes: string[] = [];

  constructor(private readonly src: string) {
    const toks = filterConditionals(lex(src, this.comments)) as PTok[];
    for (let i = 0; i < toks.length; i++) toks[i].i = i;
    this.toks = toks;
  }

  result(): ParseResult {
    attachDocs(this.defs, this.comments, this.startLines);
    return { defs: this.defs, names: this.names, refs: Int32Array.from(this.refs), includes: this.includes };
  }

  // ───────────────────────── helpers ─────────────────────────

  private addRef(t: Token, flags: number, enclosing: number): void {
    let ni = this.nameIdx.get(t.v);
    if (ni === undefined) {
      ni = this.names.length;
      this.names.push(t.v);
      this.nameIdx.set(t.v, ni);
    }
    this.refs.push(ni, t.line, t.col, flags, enclosing);
  }

  /** 정의를 시작하는 줄 (위쪽 주석을 찾을 때: static int / foo(...) 처럼 이름보다 앞 줄에서 시작할 수 있음) */
  private readonly startLines = new Map<number, number>();
  private readonly comments: Comment[] = [];

  private addDef(d: Def, start?: number): number {
    if (start !== undefined && start < d.line) this.startLines.set(this.defs.length, start);
    this.defs.push(d);
    return this.defs.length - 1;
  }

  /** 토큰 배열 arr 의 k 번째 식별자에 대한 참조 플래그 */
  private flagsAt(arr: Token[], k: number): number {
    const prev = arr[k - 1];
    const next = arr[k + 1];
    let f = 0;
    if (prev && prev.k === Tk.Punct) {
      if (prev.v === '.' || prev.v === '->') f |= RefFlag.Member;
      else if (prev.v === '++' || prev.v === '--') f |= RefFlag.Write;
      else if (prev.v === '&') {
        const pp = arr[k - 2];
        if (!pp || !(pp.k === Tk.Ident || pp.k === Tk.Number || isP(pp, ')') || isP(pp, ']'))) f |= RefFlag.Addr;
      }
    }
    if (next && next.k === Tk.Punct) {
      if (next.v === '(') f |= RefFlag.Call;
      else if (ASSIGN_OPS.has(next.v)) f |= RefFlag.Write;
    }
    return f;
  }

  private refTok(t: PTok, enclosing: number, extra = 0): void {
    this.addRef(t, this.flagsAt(this.toks, t.i) | extra, enclosing);
  }

  /** 소스 구간을 한 줄로 정리한 텍스트 (주석 제거, 공백 압축) */
  private text(a: Token, b: Token, max = 300): string {
    let s = this.src.slice(a.off, b.end);
    s = s
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > max) s = s.slice(0, max) + ' …';
    return s;
  }

  private matchClose(arr: Token[], open: number): number {
    const o = arr[open].v;
    const c = o === '(' ? ')' : o === '[' ? ']' : '}';
    let depth = 0;
    for (let j = open; j < arr.length; j++) {
      const t = arr[j];
      if (t.k !== Tk.Punct) continue;
      if (t.v === o) depth++;
      else if (t.v === c) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return arr.length - 1;
  }

  /** __attribute__((..)), __declspec(..) 제거 */
  private stripAttrs(arr: PTok[]): PTok[] {
    const out: PTok[] = [];
    for (let j = 0; j < arr.length; j++) {
      const t = arr[j];
      if (t.k === Tk.Ident && ATTR_KW.has(t.v)) {
        if (isP(arr[j + 1], '(')) j = this.matchClose(arr, j + 1);
        continue;
      }
      out.push(t);
    }
    return out;
  }

  private hasAssignAtDepth0(arr: Token[]): boolean {
    let d = 0;
    for (const t of arr) {
      if (t.k !== Tk.Punct) continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') d++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') d--;
      else if (t.v === '=' && d === 0) return true;
    }
    return false;
  }

  /** 지정자 토큰들에서 기본 타입 이름 추출: `const struct foo *` -> foo */
  private typeNameOf(spec: Token[]): string | undefined {
    for (let j = spec.length - 1; j >= 0; j--) {
      const t = spec[j];
      if (t.k === Tk.Punct) {
        if (t.v === ')') {
          // __attribute__((..)) 같은 그룹 건너뛰기
          let d = 0;
          for (; j >= 0; j--) {
            if (isP(spec[j], ')')) d++;
            else if (isP(spec[j], '(')) {
              d--;
              if (d === 0) break;
            }
          }
          j--; // 그룹 앞의 식별자(__attribute__ 등)
        }
        continue;
      }
      if (t.k !== Tk.Ident) continue;
      if (SPEC_SKIP.has(t.v) || ATTR_KW.has(t.v)) continue;
      return t.v;
    }
    return undefined;
  }

  // ───────────────────────── declarations ─────────────────────────

  /**
   * 함수 정의 헤더에서 이름 후보 찾기.
   * 첫 ';' 이전(K&R 파라미터 선언 이전)의 깊이 0 괄호 그룹 중, 앞에 타입 지정자가 있는 마지막 후보를 고른다.
   *   DEFINE_X(a) int foo(void)  -> foo
   *   main(argc, argv) int argc; -> main (암시적 int)
   */
  private findFuncName(stmt: PTok[]): { name: number; open: number; close: number } | null {
    const cands: { name: number; open: number }[] = [];
    let depth = 0;
    for (let j = 0; j < stmt.length; j++) {
      const t = stmt[j];
      if (t.k !== Tk.Punct) continue;
      if (t.v === ';' && depth === 0) break;
      if (t.v === '(') {
        if (depth === 0) {
          const prev = stmt[j - 1];
          if (isName(prev)) {
            if (isP(stmt[j + 1], '(') && j >= 2 && isName(stmt[j - 2])) cands.push({ name: j - 2, open: j });
            else cands.push({ name: j - 1, open: j });
          } else if (isP(stmt[j + 1], '*') && isName(stmt[j + 2]) && isP(stmt[j + 3], '(')) {
            // 함수 포인터를 반환하는 함수: void (*getfn(int))(int)
            cands.push({ name: j + 2, open: j + 3 });
          }
        }
        depth++;
      } else if (t.v === ')') depth--;
    }
    if (!cands.length) return null;
    let pick = cands[cands.length - 1];
    for (let c = cands.length - 1; c >= 0; c--) {
      if (cands[c].name > 0) {
        pick = cands[c];
        break;
      }
    }
    return { ...pick, close: this.matchClose(stmt, pick.open) };
  }

  /** 깊이 0 의 ',' 로 분할 */
  private splitCommas(arr: PTok[]): PTok[][] {
    const out: PTok[][] = [];
    let cur: PTok[] = [];
    let d = 0;
    for (const t of arr) {
      if (t.k === Tk.Punct) {
        if (t.v === '(' || t.v === '[' || t.v === '{') d++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') d--;
        else if (t.v === ',' && d === 0) {
          out.push(cur);
          cur = [];
          continue;
        }
      }
      cur.push(t);
    }
    out.push(cur);
    return out;
  }

  /**
   * 선언자 하나에서 이름을 찾는다.
   * @returns 이름 인덱스, 함수 여부, 선언자 시작 인덱스
   */
  private findDeclName(
    piece: PTok[],
    first: boolean,
  ): { idx: number; isFunc: boolean; open?: number; start: number } | null {
    // 초기화식(=) / 비트필드(:) 이전까지만 본다
    let lim = piece.length;
    let d = 0;
    for (let j = 0; j < piece.length; j++) {
      const t = piece[j];
      if (t.k !== Tk.Punct) continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') d++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') d--;
      else if ((t.v === '=' || t.v === ':') && d === 0) {
        lim = j;
        break;
      }
    }
    const declStart = (idx: number): number => {
      let s = idx;
      while (s > 0 && (isP(piece[s - 1], '*') || isP(piece[s - 1], '(') || piece[s - 1].v === 'const' || piece[s - 1].v === 'volatile')) s--;
      return s;
    };

    // 함수 포인터 / 함수 선언자
    d = 0;
    for (let j = 0; j < lim; j++) {
      const t = piece[j];
      if (t.k !== Tk.Punct) continue;
      if (t.v === '(') {
        if (d === 0) {
          let k = j + 1;
          while (k < lim && (isP(piece[k], '*') || isP(piece[k], '^') || piece[k].v === 'const' || piece[k].v === '__cdecl' || piece[k].v === '__stdcall')) k++;
          if (k > j + 1 && isName(piece[k])) {
            // (*fp)(params) -> 파라미터 이름은 참조에서 제외하도록 open 을 알려줌
            const close = this.matchClose(piece, j);
            const open = isP(piece[close + 1], '(') ? close + 1 : undefined;
            return { idx: k, isFunc: false, open, start: declStart(j) };
          }
          const prev = piece[j - 1];
          if (isName(prev)) {
            let ni = j - 1;
            if (isP(piece[j + 1], '(') && j >= 2 && isName(piece[j - 2])) ni = j - 2; // NAME PROTO((..))
            if (!first || ni > 0) return { idx: ni, isFunc: true, open: j, start: declStart(ni) };
          }
        }
        d++;
      } else if (t.v === ')' || t.v === '[') {
        if (t.v === ')') d--;
        else d++;
      } else if (t.v === ']') d--;
    }

    // 일반 선언자: 깊이 0 의 마지막 식별자
    d = 0;
    for (let j = lim - 1; j >= 0; j--) {
      const t = piece[j];
      if (t.k === Tk.Punct) {
        if (t.v === ')' || t.v === ']') d++;
        else if (t.v === '(' || t.v === '[') d--;
        continue;
      }
      if (d !== 0 || !isName(t)) continue;
      if (j > 0 && piece[j - 1].k === Tk.Ident && AGG_KW.has(piece[j - 1].v)) return null; // struct foo; (태그만)
      if (first && j === 0) return null; // 타입 없는 식별자 하나 -> 선언 아님
      return { idx: j, isFunc: false, start: declStart(j) };
    }
    return null;
  }

  /** 선언문(';' 제외)을 분석한다. specifiers + 선언자 목록 */
  private parseDeclaration(stmt: PTok[], noSpecifiers = false): Declaration {
    const pieces = this.splitCommas(stmt);
    const res: Declaration = { isTypedef: false, isExtern: false, isStatic: false, decls: [] };
    let spec: PTok[] = [];
    let specText = '';
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi];
      if (!piece.length) continue;
      const first = pi === 0 && !noSpecifiers;
      const found = this.findDeclName(piece, first);
      if (!found) {
        if (pi === 0) return res;
        continue;
      }
      if (pi === 0) {
        spec = piece.slice(0, found.start);
        for (const t of spec) {
          if (t.v === 'typedef') res.isTypedef = true;
          else if (t.v === 'extern') res.isExtern = true;
          else if (t.v === 'static') res.isStatic = true;
        }
        res.typeName = this.typeNameOf(spec);
        specText = spec.length ? this.text(spec[0], spec[spec.length - 1], 200) : '';
      }
      let declEnd = piece.length - 1;
      for (let j = found.idx; j < piece.length; j++) {
        if ((isP(piece[j], '=') || isP(piece[j], ':')) && j > found.idx) {
          declEnd = j - 1;
          break;
        }
      }
      const declText = this.text(piece[found.start], piece[declEnd], 300);
      const decl: Declarator = {
        name: piece[found.idx],
        isFunc: found.isFunc,
        sig: specText ? specText + ' ' + declText : declText,
      };
      if (found.open !== undefined) {
        const close = this.matchClose(piece, found.open);
        decl.paramToks = piece.slice(found.open + 1, close);
      }
      res.decls.push(decl);
    }
    return res;
  }

  /** 파라미터 목록에서 각 파라미터의 이름 토큰과 타입 */
  private paramDecls(inner: PTok[]): { name: PTok; type?: string; sig: string }[] {
    const out: { name: PTok; type?: string; sig: string }[] = [];
    // PROTO((int a, int b)) 의 이중 괄호 벗기기
    while (inner.length >= 2 && isP(inner[0], '(') && this.matchClose(inner, 0) === inner.length - 1) inner = inner.slice(1, -1);
    if (!inner.length) return out;
    for (const piece of this.splitCommas(inner)) {
      if (!piece.length) continue;
      if (piece.length === 1 && (piece[0].v === 'void' || piece[0].v === '...')) continue;
      const found = this.findDeclName(piece, true);
      if (!found || found.isFunc) continue;
      out.push({
        name: piece[found.idx],
        type: this.typeNameOf(piece.slice(0, found.start)),
        sig: this.text(piece[0], piece[piece.length - 1], 200),
      });
    }
    return out;
  }

  // ───────────────────────── top level ─────────────────────────

  parseTop(): void {
    const toks = this.toks;
    const N = toks.length;
    let stmt: PTok[] = [];
    while (this.p < N) {
      const t = toks[this.p];
      switch (t.k) {
        case Tk.PPStart:
          this.directive(-1);
          continue;
        case Tk.PPEnd:
          this.p++;
          continue;
        case Tk.SqlStmt:
          if (stmt.length) this.topDecl(stmt);
          stmt = [];
          this.p++;
          continue;
        case Tk.SqlHost:
        case Tk.SqlCall:
        case Tk.SqlGoto:
        case Tk.SqlCursorDef:
        case Tk.SqlCursorRef:
        case Tk.SqlInclude:
          this.sqlToken(t, -1);
          this.p++;
          continue;
        case Tk.Punct:
          if (t.v === ';') {
            if (this.isKRHeader(stmt)) {
              stmt.push(t);
              this.p++;
              continue;
            }
            this.topDecl(stmt);
            stmt = [];
            this.p++;
            continue;
          }
          if (t.v === '{') {
            if (this.topBrace(stmt)) continue;
            stmt = [];
            continue;
          }
          if (t.v === '}') {
            // extern "C" { } 의 닫는 괄호, 또는 깨진 코드
            if (stmt.length) this.topDecl(stmt);
            stmt = [];
            this.p++;
            continue;
          }
      }
      stmt.push(t);
      this.p++;
    }
    if (stmt.length) this.topDecl(stmt);
  }

  /** `int foo(a, b) int a; char *b; {` 형태의 K&R 함수 헤더 진행 중인지 */
  private isKRHeader(stmt: PTok[]): boolean {
    if (stmt.length < 4) return false;
    const f = this.findFuncName(stmt);
    if (!f) return false;
    if (this.hasAssignAtDepth0(stmt)) return false;
    const inner = stmt.slice(f.open + 1, f.close);
    if (!inner.length) return false;
    const params = new Set<string>();
    for (const t of inner) {
      if (isName(t)) params.add(t.v);
      else if (!isP(t, ',')) return false;
    }
    const after = stmt.slice(f.close + 1);
    return after.some((t) => t.k === Tk.Ident && params.has(t.v));
  }

  /** 최상위에서 '{' 를 만났을 때. true 를 반환하면 stmt 를 계속 이어간다(초기화식). */
  private topBrace(stmt: PTok[]): boolean {
    if (stmt.length && this.hasAssignAtDepth0(stmt)) {
      this.collectBalanced(stmt, -1);
      return true;
    }
    if (stmt.length === 2 && stmt[0].v === 'extern' && stmt[1].k === Tk.Str) {
      this.p++; // extern "C" {
      return false;
    }
    if (this.aggIndex(stmt) >= 0) {
      this.aggregate(stmt, null);
      return false;
    }
    const f = this.findFuncName(stmt);
    if (f && !KEYWORDS.has(stmt[f.name].v)) {
      this.functionDef(stmt, f);
      return false;
    }
    // 알 수 없는 블록: 참조만 수집
    for (const t of stmt) if (isName(t)) this.refTok(t, -1);
    this.body(-1);
    return false;
  }

  /** stmt 가 `[typedef] struct [tag]` 로 끝나면 키워드 인덱스, 아니면 -1 */
  private aggIndex(stmt: PTok[]): number {
    for (let j = stmt.length - 1; j >= 0; j--) {
      const t = stmt[j];
      if (t.k === Tk.Ident && AGG_KW.has(t.v)) {
        const tail = this.stripAttrs(stmt.slice(j + 1));
        if (tail.length <= 2 && tail.every((x) => x.k === Tk.Ident)) return j;
        // enum foo : int {
        if (t.v === 'enum' && tail.some((x) => isP(x, ':'))) return j;
        return -1;
      }
    }
    return -1;
  }

  /** '{' 부터 짝이 맞는 '}' 까지 토큰을 into 에 담는다 (초기화식) */
  private collectBalanced(into: PTok[], enclosing: number): void {
    const toks = this.toks;
    let depth = 0;
    while (this.p < toks.length) {
      const t = toks[this.p];
      if (t.k === Tk.PPStart) {
        this.directive(enclosing);
        continue;
      }
      if (t.k === Tk.PPEnd) {
        this.p++;
        continue;
      }
      if (t.k >= Tk.SqlHost) {
        this.sqlToken(t, enclosing);
        this.p++;
        continue;
      }
      into.push(t);
      this.p++;
      if (t.k === Tk.Punct) {
        if (t.v === '{') depth++;
        else if (t.v === '}') {
          depth--;
          if (depth <= 0) return;
        }
      }
    }
  }

  /** ';' 로 끝난 최상위 선언문 */
  private topDecl(stmt: PTok[]): void {
    if (!stmt.length) return;
    const decl = this.parseDeclaration(stmt);
    const declIdx: { off: number; idx: number }[] = [];
    const skip = new Set<PTok>();
    for (const d of decl.decls) {
      let kind: DefKind;
      if (decl.isTypedef) kind = 'typedef';
      else if (d.isFunc) kind = 'prototype';
      else if (decl.isExtern) kind = 'extern';
      else kind = 'variable';
      const def: Def = { name: d.name.v, kind, line: d.name.line, col: d.name.col, sig: d.sig };
      if (decl.typeName) def.type = decl.typeName;
      if (decl.isStatic) def.isStatic = true;
      declIdx.push({ off: d.name.off, idx: this.addDef(def, stmt[0].line) });
      skip.add(d.name);
      if (d.paramToks) for (const pd of this.paramDecls(d.paramToks)) skip.add(pd.name);
    }
    for (const t of stmt) {
      if (!isName(t) || skip.has(t)) continue;
      let enc = -1;
      for (const di of declIdx) if (di.off < t.off) enc = di.idx;
      this.refTok(t, enc);
    }
  }

  // ───────────────────────── functions ─────────────────────────

  private functionDef(stmt: PTok[], f: { name: number; open: number; close: number }): void {
    const nameTok = stmt[f.name];
    const last = stmt[stmt.length - 1];
    const spec = stmt.slice(0, f.name);
    const def: Def = {
      name: nameTok.v,
      kind: 'function',
      line: nameTok.line,
      col: nameTok.col,
      sig: this.text(stmt[0], last, 400),
    };
    const ty = this.typeNameOf(spec);
    if (ty) def.type = ty;
    if (spec.some((t) => t.v === 'static')) def.isStatic = true;
    const fnIdx = this.addDef(def, stmt[0].line);

    const skip = new Set<PTok>([nameTok]);
    const inner = stmt.slice(f.open + 1, f.close);
    const after = stmt.slice(f.close + 1);
    const isKR = after.length > 0 && inner.length > 0 && inner.every((t) => isName(t) || isP(t, ','));
    if (isKR) {
      // K&R: 이름 목록 + 이후 선언
      const declared = new Map<string, { tok: PTok; type?: string; sig: string }>();
      let cur: PTok[] = [];
      const flush = () => {
        if (!cur.length) return;
        const d = this.parseDeclaration(cur);
        for (const x of d.decls) declared.set(x.name.v, { tok: x.name, type: d.typeName, sig: x.sig });
        cur = [];
      };
      for (const t of after) {
        if (isP(t, ';')) flush();
        else cur.push(t);
      }
      flush();
      for (const t of inner) {
        if (!isName(t)) continue;
        const d = declared.get(t.v);
        const p: Def = { name: t.v, kind: 'param', line: t.line, col: t.col, scope: fnIdx, sig: d ? d.sig : 'int ' + t.v };
        p.type = d ? d.type : 'int';
        this.addDef(p);
        skip.add(t);
        if (d) skip.add(d.tok);
      }
    } else {
      for (const pd of this.paramDecls(inner)) {
        const p: Def = { name: pd.name.v, kind: 'param', line: pd.name.line, col: pd.name.col, scope: fnIdx, sig: pd.sig };
        if (pd.type) p.type = pd.type;
        this.addDef(p);
        skip.add(pd.name);
      }
    }
    for (const t of stmt) if (isName(t) && !skip.has(t)) this.refTok(t, fnIdx);

    def.endLine = this.body(fnIdx);
  }

  /**
   * '{' 위치에서 시작해 짝이 맞는 '}' 까지 함수 본문을 걷는다.
   * 지역 변수/레이블 정의와 식별자 참조를 수집한다. 반환: 닫는 괄호의 줄.
   */
  private body(fnIdx: number): number {
    const toks = this.toks;
    const N = toks.length;
    let depth = 0;
    let paren = 0;
    let stmt: PTok[] = [];
    // 각 중괄호 레벨이 struct/union 본문인지 (그 안에서는 지역 변수 판정 안 함)
    const aggStack: boolean[] = [];
    let lastLine = toks[this.p] ? toks[this.p].line : 0;
    const flush = () => {
      if (stmt.length) this.flushStmt(stmt, fnIdx, !aggStack[aggStack.length - 1]);
      stmt = [];
    };
    while (this.p < N) {
      const t = toks[this.p];
      lastLine = t.line;
      switch (t.k) {
        case Tk.PPStart:
          this.directive(fnIdx);
          continue;
        case Tk.PPEnd:
          this.p++;
          continue;
        case Tk.SqlStmt:
          flush();
          this.p++;
          continue;
        case Tk.SqlHost:
        case Tk.SqlCall:
        case Tk.SqlGoto:
        case Tk.SqlCursorDef:
        case Tk.SqlCursorRef:
        case Tk.SqlInclude:
          this.sqlToken(t, fnIdx);
          this.p++;
          continue;
        case Tk.Punct:
          if (t.v === '(') paren++;
          else if (t.v === ')') {
            if (paren > 0) paren--;
          } else if (t.v === '{') {
            const isAgg = this.aggIndex(stmt) >= 0 && !this.hasAssignAtDepth0(stmt);
            flush();
            aggStack.push(isAgg);
            depth++;
            paren = 0;
            this.p++;
            continue;
          } else if (t.v === '}') {
            flush();
            aggStack.pop();
            depth--;
            paren = 0;
            this.p++;
            if (depth <= 0) return t.line;
            continue;
          } else if (t.v === ';' && paren === 0) {
            flush();
            this.p++;
            continue;
          }
      }
      stmt.push(t);
      this.p++;
    }
    flush();
    return lastLine;
  }

  /** 함수 본문 안의 한 문장(또는 문장 조각) 처리 */
  private flushStmt(stmt: PTok[], fnIdx: number, allowDecl: boolean): void {
    let s = 0;
    // 레이블:  err_exit:
    if (fnIdx >= 0 && stmt.length >= 2 && isName(stmt[0]) && isP(stmt[1], ':')) {
      this.addDef({ name: stmt[0].v, kind: 'label', line: stmt[0].line, col: stmt[0].col, scope: fnIdx });
      s = 2;
    }
    const declNames = new Set<PTok>();
    if (allowDecl && fnIdx >= 0 && s < stmt.length) {
      let declToks: PTok[] | null = null;
      if (stmt[s].v === 'for' && isP(stmt[s + 1], '(')) {
        const part: PTok[] = [];
        for (let j = s + 2; j < stmt.length && !isP(stmt[j], ';'); j++) part.push(stmt[j]);
        if (this.looksLikeLocalDecl(part, 0)) declToks = part;
      } else if (this.looksLikeLocalDecl(stmt, s)) {
        declToks = s ? stmt.slice(s) : stmt;
      }
      if (declToks) {
        const d = this.parseDeclaration(declToks);
        for (const x of d.decls) {
          if (x.isFunc) continue;
          const def: Def = { name: x.name.v, kind: 'local', line: x.name.line, col: x.name.col, scope: fnIdx, sig: x.sig };
          if (d.typeName) def.type = d.typeName;
          if (d.isStatic) def.isStatic = true;
          this.addDef(def);
          declNames.add(x.name);
        }
      }
    }
    for (let j = s; j < stmt.length; j++) {
      const t = stmt[j];
      if (isName(t) && !declNames.has(t)) this.refTok(t, fnIdx);
    }
  }

  private looksLikeLocalDecl(stmt: PTok[], s: number): boolean {
    const t0 = stmt[s];
    const t1 = stmt[s + 1];
    if (!t0 || t0.k !== Tk.Ident) return false;
    if (DECL_START_KW.has(t0.v)) return true;
    if (KEYWORDS.has(t0.v) || !t1) return false;
    // TypeName var / TypeName const var
    if (t1.k === Tk.Ident) {
      if (!KEYWORDS.has(t1.v)) return true;
      return t1.v === 'const' || t1.v === 'volatile';
    }
    // TypeName *var [= ...]
    if (isP(t1, '*')) {
      let k = s + 1;
      while (k < stmt.length && (isP(stmt[k], '*') || stmt[k].v === 'const')) k++;
      const nt = stmt[k];
      if (!isName(nt)) return false;
      const after = stmt[k + 1];
      return !after || isP(after, '=') || isP(after, ',') || isP(after, '[') || isP(after, ';');
    }
    return false;
  }

  // ───────────────────────── aggregates ─────────────────────────

  /** p 는 '{' 위치. struct/union/enum 본문과 뒤따르는 선언자까지 처리한다. */
  private aggregate(stmt: PTok[], outer: AggOuter | null): void {
    const ki = this.aggIndex(stmt);
    const kwTok = stmt[ki];
    const kind = kwTok.v as 'struct' | 'union' | 'enum';
    const tail = this.stripAttrs(stmt.slice(ki + 1)).filter((t) => !isP(t, ':'));
    const tagTok = tail.length && isName(tail[0]) ? tail[0] : null;
    const isTypedef = !outer && stmt.slice(0, ki).some((t) => t.v === 'typedef');
    const isExtern = stmt.slice(0, ki).some((t) => t.v === 'extern');
    const isStatic = stmt.slice(0, ki).some((t) => t.v === 'static');
    const placeholder = `\0agg${++aggCounter}`;
    const memberIdxs: number[] = [];

    let aggIdx = -1;
    if (tagTok) {
      aggIdx = this.addDef({ name: tagTok.v, kind, line: tagTok.line, col: tagTok.col, sig: `${kind} ${tagTok.v}` }, stmt[0].line);
    }

    this.p++; // '{'
    const closeLine = kind === 'enum' ? this.enumBody(placeholder, memberIdxs, aggIdx) : this.structBody(placeholder, memberIdxs, aggIdx);
    if (aggIdx >= 0) this.defs[aggIdx].endLine = closeLine;

    // 뒤따르는 선언자:  } a, *b = {...};
    const trailing: PTok[] = [];
    const toks = this.toks;
    while (this.p < toks.length) {
      const t = toks[this.p];
      if (t.k === Tk.PPStart) {
        this.directive(-1);
        continue;
      }
      if (t.k === Tk.PPEnd) {
        this.p++;
        continue;
      }
      if (isP(t, ';')) {
        this.p++;
        break;
      }
      if (isP(t, '}')) break; // ';' 없이 끝남 (깨진 코드)
      if (isP(t, '{')) {
        this.collectBalanced(trailing, -1);
        continue;
      }
      if (t.k >= Tk.SqlHost) break;
      trailing.push(t);
      this.p++;
    }
    const decl = trailing.length ? this.parseDeclaration(trailing, true) : null;
    const decls = decl ? decl.decls : [];

    let containerName: string;
    if (tagTok) containerName = tagTok.v;
    else if (decls.length) containerName = decls[0].name.v;
    else if (outer) containerName = outer.placeholder; // C11 익명 멤버: 바깥 구조체 소속
    else containerName = '(anonymous)';

    for (const mi of memberIdxs) {
      if (this.defs[mi].container === placeholder) this.defs[mi].container = containerName;
    }
    if (outer && containerName === outer.placeholder) outer.memberIdxs.push(...memberIdxs);

    const kwText = tagTok ? `${kind} ${tagTok.v}` : `${kind} {…}`;
    const declIdx: { off: number; idx: number }[] = [];
    for (const d of decls) {
      let def: Def;
      if (outer) {
        def = { name: d.name.v, kind: 'member', line: d.name.line, col: d.name.col, container: outer.placeholder, type: containerName, sig: `${kwText} ${d.sig}` };
        const idx = this.addDef(def);
        outer.memberIdxs.push(idx);
        declIdx.push({ off: d.name.off, idx });
        continue;
      }
      const k: DefKind = isTypedef ? 'typedef' : isExtern ? 'extern' : 'variable';
      def = { name: d.name.v, kind: k, line: d.name.line, col: d.name.col, type: containerName, sig: `${isTypedef ? 'typedef ' : ''}${kwText} ${d.sig}` };
      if (isStatic) def.isStatic = true;
      declIdx.push({ off: d.name.off, idx: this.addDef(def) });
    }
    const declToks = new Set(decls.map((d) => d.name));
    for (const t of trailing) {
      if (!isName(t) || declToks.has(t)) continue;
      let enc = -1;
      for (const di of declIdx) if (di.off < t.off) enc = di.idx;
      this.refTok(t, enc);
    }
  }

  private structBody(placeholder: string, memberIdxs: number[], aggIdx: number): number {
    const toks = this.toks;
    let mstmt: PTok[] = [];
    while (this.p < toks.length) {
      const t = toks[this.p];
      if (t.k === Tk.PPStart) {
        this.directive(-1);
        continue;
      }
      if (t.k === Tk.PPEnd || t.k >= Tk.SqlHost) {
        this.p++;
        continue;
      }
      if (t.k === Tk.Punct) {
        if (t.v === '}') {
          this.memberDecl(mstmt, placeholder, memberIdxs, aggIdx);
          this.p++;
          return t.line;
        }
        if (t.v === ';') {
          this.memberDecl(mstmt, placeholder, memberIdxs, aggIdx);
          mstmt = [];
          this.p++;
          continue;
        }
        if (t.v === '{') {
          if (this.aggIndex(mstmt) >= 0) {
            this.aggregate(mstmt, { placeholder, memberIdxs });
          } else {
            const junk: PTok[] = [];
            this.collectBalanced(junk, aggIdx);
          }
          mstmt = [];
          continue;
        }
      }
      mstmt.push(t);
      this.p++;
    }
    return toks.length ? toks[toks.length - 1].line : 0;
  }

  private memberDecl(mstmt: PTok[], placeholder: string, memberIdxs: number[], aggIdx: number): void {
    if (!mstmt.length) return;
    const d = this.parseDeclaration(mstmt);
    const skip = new Set<PTok>();
    for (const x of d.decls) {
      const def: Def = { name: x.name.v, kind: 'member', line: x.name.line, col: x.name.col, container: placeholder, sig: x.sig };
      if (d.typeName) def.type = d.typeName;
      memberIdxs.push(this.addDef(def, mstmt[0].line));
      skip.add(x.name);
      if (x.paramToks) for (const pd of this.paramDecls(x.paramToks)) skip.add(pd.name);
    }
    for (const t of mstmt) if (isName(t) && !skip.has(t)) this.refTok(t, aggIdx);
  }

  private enumBody(placeholder: string, memberIdxs: number[], aggIdx: number): number {
    const toks = this.toks;
    let piece: PTok[] = [];
    let depth = 0;
    const flush = () => {
      if (piece.length && isName(piece[0])) {
        const e = piece[0];
        const idx = this.addDef({
          name: e.v,
          kind: 'enumerator',
          line: e.line,
          col: e.col,
          container: placeholder,
          sig: this.text(piece[0], piece[piece.length - 1], 200),
        });
        memberIdxs.push(idx);
        for (let j = 1; j < piece.length; j++) if (isName(piece[j])) this.refTok(piece[j], aggIdx);
      }
      piece = [];
    };
    while (this.p < toks.length) {
      const t = toks[this.p];
      if (t.k === Tk.PPStart) {
        this.directive(-1);
        continue;
      }
      if (t.k === Tk.PPEnd || t.k >= Tk.SqlHost) {
        this.p++;
        continue;
      }
      if (t.k === Tk.Punct) {
        if (depth === 0 && t.v === '}') {
          flush();
          this.p++;
          return t.line;
        }
        if (depth === 0 && t.v === ',') {
          flush();
          this.p++;
          continue;
        }
        if (depth === 0 && t.v === ';') {
          // 깨진 코드: enum 이 닫히지 않음
          flush();
          return t.line;
        }
        if (t.v === '(' || t.v === '{' || t.v === '[') depth++;
        else if (t.v === ')' || t.v === '}' || t.v === ']') depth--;
      }
      piece.push(t);
      this.p++;
    }
    flush();
    return toks.length ? toks[toks.length - 1].line : 0;
  }

  // ───────────────────────── preprocessor & SQL ─────────────────────────

  /** p 는 PPStart. PPEnd 다음까지 소비한다. */
  private directive(enclosing: number): void {
    const toks = this.toks;
    const start = toks[this.p];
    const d: PTok[] = [];
    this.p++;
    while (this.p < toks.length && toks[this.p].k !== Tk.PPEnd) d.push(toks[this.p++]);
    const endTok = toks[this.p];
    if (this.p < toks.length) this.p++;

    switch (start.v) {
      case 'define': {
        const nameTok = d[0];
        if (!nameTok || nameTok.k !== Tk.Ident) return;
        const params = new Set<string>();
        let bodyStart = 1;
        if (isP(d[1], '(') && d[1].off === nameTok.end) {
          let j = 2;
          for (; j < d.length && !isP(d[j], ')'); j++) {
            if (d[j].k === Tk.Ident) params.add(d[j].v);
            else if (isP(d[j], '...')) params.add('__VA_ARGS__');
          }
          bodyStart = j + 1;
        }
        const lastTok = d[d.length - 1];
        let sig = this.src.slice(start.off, lastTok.end);
        const lines = sig.split(/\r?\n/);
        if (lines.length > 25) sig = lines.slice(0, 25).join('\n') + '\n…';
        if (sig.length > 2000) sig = sig.slice(0, 2000) + ' …';
        const idx = this.addDef({
          name: nameTok.v,
          kind: 'macro',
          line: nameTok.line,
          col: nameTok.col,
          endLine: endTok ? endTok.line : lastTok.line,
          sig,
        });
        for (let j = bodyStart; j < d.length; j++) {
          const t = d[j];
          if (!isName(t) || params.has(t.v)) continue;
          if (isP(d[j - 1], '##') || isP(d[j + 1], '##') || isP(d[j - 1], '#')) continue;
          this.addRef(t, this.flagsAt(d, j), idx);
        }
        return;
      }
      case 'undef':
        if (d[0] && d[0].k === Tk.Ident) this.addRef(d[0], RefFlag.PP, enclosing);
        return;
      case 'include':
      case 'include_next':
      case 'import':
        if (d[0] && d[0].k === Tk.Str && d[0].v) this.includes.push(d[0].v);
        return;
      case 'if':
      case 'ifdef':
      case 'ifndef':
      case 'elif':
        for (const t of d) if (isName(t) && t.v !== 'defined') this.addRef(t, RefFlag.PP, enclosing);
        return;
    }
  }

  private sqlToken(t: PTok, enclosing: number): void {
    switch (t.k) {
      case Tk.SqlHost:
      case Tk.SqlGoto:
      case Tk.SqlCursorRef:
        this.addRef(t, RefFlag.Sql, enclosing);
        return;
      case Tk.SqlCall:
        this.addRef(t, RefFlag.Sql | RefFlag.Call, enclosing);
        return;
      case Tk.SqlCursorDef:
        this.addDef({ name: t.v, kind: 'cursor', line: t.line, col: t.col, isStatic: true, sig: `EXEC SQL DECLARE ${t.v} CURSOR` });
        return;
      case Tk.SqlInclude:
        this.includes.push(t.v);
        return;
    }
  }
}
