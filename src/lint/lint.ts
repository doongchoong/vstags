/**
 * 회사 C / Pro*C 코드 컨벤션 검사 (실험 기능, 기본 꺼짐). VS Code 와 무관한 본체.
 *
 * 원칙: 확실한 경우만 경고하고, 정의를 찾지 못한 타입/매크로는 추정하지 않고 넘어간다.
 * 계획/규칙 목록: docs/lint-plan.md
 */
import { Comment, lex, Tk, Token } from '../core/lexer';
import { filterConditionals } from '../core/preproc';
import { SymbolIndex } from '../core/symbolIndex';
import { Def, FileIndex, REF_STRIDE } from '../core/types';

export type Severity = 'warning' | 'information' | 'hint' | 'off';

export interface LintIssue {
  rule: string;
  severity: Exclude<Severity, 'off'>;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  /** 연달아 걸린 경고를 하나로 묶었을 때 각 위치 */
  related?: { line: number; col: number; endLine: number; endCol: number; message: string }[];
}

export interface LintOptions {
  /** 규칙 ID -> 심각도 (없으면 RULES 기본값) */
  rules?: Record<string, Severity>;
  /** 접두어 -> 타입 이름 목록 (없으면 DEFAULT_PREFIXES) */
  prefixes?: Record<string, string[]>;
  /** sqlcode 확인으로 칠 매크로/함수 이름 (자동 인식이 안 될 때) */
  sqlCheckNames?: string[];
  /** 같은 규칙이 이 줄 수 이상 연달아 걸리면 하나로 묶음 (기본 10, 0 이면 묶지 않음) */
  groupMinLines?: number;
}

/** 규칙 ID -> 기본 심각도. L1 = warning, L2 = information, 안전 검사 = warning */
export const RULES: Readonly<Record<string, Exclude<Severity, 'off'>>> = {
  'comment-line': 'warning',
  'header-guard': 'warning',
  'prefix-type': 'warning',
  'sz-plus-one': 'warning',
  'ac-no-plus-one': 'warning',
  'global-static': 'warning',
  'global-prefix': 'warning',
  'no-extern': 'warning',
  'host-prefix': 'warning',
  'sql-include': 'information',
  'camel-case': 'information',
  'struct-typedef': 'information',
  'typedef-suffix': 'information',
  'struct-param-by-value': 'information',
  'internal-static': 'information',
  'static-local': 'information',
  'if-assign': 'information',
  'sqlcode-check': 'warning',
  'memset-size': 'warning',
  'uninit-local': 'warning',
  'copy-size': 'warning',
};

/** 가이드의 접두어 표. 값은 기본 타입 분류(int, long, struct …) 또는 typedef 이름 */
export const DEFAULT_PREFIXES: Readonly<Record<string, string[]>> = {
  n: ['int', 'int32'],
  o: ['long', 'int64'],
  d: ['double'],
  c: ['char'],
  s: ['short'],
  f: ['float'],
  u: ['unsigned'],
  t: ['struct', 'union', 'VARCHAR'],
};

/** stdint 등 표준 typedef (표준이므로 추정이 아님) */
const STD_TYPES: Readonly<Record<string, string>> = {
  int8_t: 'char',
  int16_t: 'short',
  int32_t: 'int',
  int64_t: 'long',
  uint8_t: 'unsigned',
  uint16_t: 'unsigned',
  uint32_t: 'unsigned',
  uint64_t: 'unsigned',
  size_t: 'unsigned',
  ssize_t: 'long',
  intptr_t: 'long',
  uintptr_t: 'unsigned',
};

const QUALIFIERS = new Set(['typedef', 'static', 'extern', 'register', 'auto', 'const', 'volatile', 'inline', '__inline', '__inline__', '__extension__']);
const NAMING_KINDS = new Set(['variable', 'extern', 'local', 'param', 'member']);
const SQL_EXEC_WORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'FETCH', 'OPEN', 'EXECUTE', 'PREPARE', 'CALL', 'CONNECT', 'LOCK']);
const SQL_CHECK_BASE = ['sqlca', 'SQLCODE', 'sqlcode'];
const INIT_FUNCS: ReadonlySet<string> = new Set(['memset', 'bzero']);
const CHECKER_KINDS: ReadonlySet<string> = new Set(['macro', 'function']);
const INIT_KINDS: ReadonlySet<string> = new Set(['macro']);
const COPY_FUNCS = new Set(['strcpy', 'strncpy', 'memcpy', 'memmove', 'strcat', 'sprintf']);
const HEADER_RE = /\.(h|hh|hpp)$/i;

/** 안전 검사: 하나하나가 중요하므로 묶지 않고, 같은 심각도 안에서 먼저 보낸다 (VS Code 는 파일당 1000개까지만 표시) */
const SAFETY_RULES: ReadonlySet<string> = new Set(['sqlcode-check', 'memset-size', 'uninit-local', 'copy-size']);
const SEVERITY_RANK = { warning: 0, information: 1, hint: 2 };

/** 묶은 경고의 제목 */
const RULE_TITLES: Readonly<Record<string, string>> = {
  'comment-line': '// 주석',
  'header-guard': '헤더가드 없음',
  'prefix-type': '접두어가 타입과 맞지 않음',
  'sz-plus-one': 'sz 배열 크기에 + 1 없음',
  'ac-no-plus-one': 'ac 배열 크기에 + 1',
  'global-static': '전역 변수에 static 없음',
  'global-prefix': 'g_ 접두어 규칙 위반',
  'no-extern': 'extern 변수',
  'host-prefix': 'h_ 접두어 규칙 위반',
  'sql-include': 'EXEC SQL INCLUDE',
  'camel-case': 'CamelCase 아님',
  'struct-typedef': 'typedef 없는 struct',
  'typedef-suffix': '구조체 typedef 이름에 _t 없음',
  'struct-param-by-value': '구조체 값 전달',
  'internal-static': '헤더에 없는 함수에 static 없음',
  'static-local': '함수 안 static 변수',
  'if-assign': 'if 조건 안 대입',
};

interface DeclInfo {
  /** 기본 타입 분류 (int, char, struct …) 또는 접두어 표에 직접 적힌 typedef 이름. 모르면 undefined */
  cat?: string;
  letter?: string;
  isChar: boolean;
  /** typedef 까지 합친 포인터 단계 / 배열 차원 */
  ptr: number;
  dims: number;
  /** 선언 자체의 배열 크기 식 (typedef 로 온 것 제외) */
  ownDims: Token[][];
  ownPtr: number;
  /** 선언 자체의 타입 지정자 단어 */
  spec: string[];
  funcPtr: boolean;
}

interface Body {
  fnIdx: number;
  open: number;
  close: number;
}

interface NameParts {
  h: boolean;
  g: boolean;
  /** g_h_ 처럼 순서가 바뀜 */
  badOrder: boolean;
  /** h_/g_ 다음의 소문자 접두어 (psz, n, at …) */
  hung: string;
  body: string;
}

const isP = (t: Token | undefined, v: string): boolean => !!t && t.k === Tk.Punct && t.v === v;

export function splitName(name: string): NameParts {
  let rest = name;
  let h = false;
  let g = false;
  let badOrder = false;
  if (rest.startsWith('g_h_')) {
    g = h = badOrder = true;
    rest = rest.slice(4);
  } else {
    if (rest.startsWith('h_')) {
      h = true;
      rest = rest.slice(2);
    }
    if (rest.startsWith('g_')) {
      g = true;
      rest = rest.slice(2);
    }
  }
  const hung = /^[a-z]*/.exec(rest)![0];
  return { h, g, badOrder, hung, body: rest.slice(hung.length) };
}

export function lintSource(path: string, src: string, fi: FileIndex, index?: SymbolIndex, opts: LintOptions = {}): LintIssue[] {
  return new Linter(path, src, fi, index, opts).run();
}

class Linter {
  private readonly issues: LintIssue[] = [];
  private readonly comments: Comment[] = [];
  private readonly raw: Token[];
  /** 전처리 지시문을 뺀 코드 토큰 (#if 는 색인과 같은 방식으로 거름) */
  private readonly code: Token[];
  private readonly tokAt = new Map<number, number>();
  private readonly lineStarts: number[] = [0];
  private readonly prefixes: Record<string, string[]>;
  private readonly letterOf = new Map<string, string>();
  private readonly charLetter: string | undefined;
  private readonly checkBase: ReadonlySet<string>;
  private readonly declMemo = new Map<Def, DeclInfo | null>();
  private readonly checkerMemo = new Map<string, boolean>();
  private readonly initFnMemo = new Map<string, boolean>();
  private readonly refNames = new WeakMap<FileIndex, Map<number, Set<string>>>();
  private bodies: Body[] = [];
  /** DECLARE SECTION 범위 [시작 off, 끝 off] */
  private sections: [number, number][] = [];
  private readonly prefixWarned = new Set<Def>();
  /** 현재 문서 정의: 이름 -> defs 인덱스, 함수 인덱스 -> 지역/파라미터 */
  private readonly byName = new Map<string, number[]>();
  private readonly byScope = new Map<number, Def[]>();

  constructor(
    private readonly path: string,
    private readonly src: string,
    private readonly fi: FileIndex,
    private readonly index: SymbolIndex | undefined,
    private readonly opts: LintOptions,
  ) {
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    this.raw = lex(src, this.comments);
    const code: Token[] = [];
    let inPP = false;
    for (const t of filterConditionals(this.raw)) {
      if (t.k === Tk.PPStart) inPP = true;
      else if (t.k === Tk.PPEnd) inPP = false;
      else if (!inPP) code.push(t);
    }
    this.code = code;
    code.forEach((t, i) => {
      if (t.k === Tk.Ident) this.tokAt.set(t.off, i);
    });
    this.prefixes = opts.prefixes && Object.keys(opts.prefixes).length ? opts.prefixes : { ...DEFAULT_PREFIXES };
    for (const [letter, types] of Object.entries(this.prefixes)) for (const ty of types) if (!this.letterOf.has(ty)) this.letterOf.set(ty, letter);
    this.charLetter = this.letterOf.get('char');
    this.checkBase = new Set([...SQL_CHECK_BASE, ...(opts.sqlCheckNames ?? [])]);
    fi.defs.forEach((d, i) => {
      const a = this.byName.get(d.name);
      if (a) a.push(i);
      else this.byName.set(d.name, [i]);
      if (d.scope !== undefined && (d.kind === 'local' || d.kind === 'param')) {
        const l = this.byScope.get(d.scope);
        if (l) l.push(d);
        else this.byScope.set(d.scope, [d]);
      }
    });
  }

  run(): LintIssue[] {
    this.findBodies();
    this.findSections();
    this.lineComments();
    this.headerGuard();
    this.naming();
    this.structs();
    this.functions();
    this.statements();
    this.sqlcode();
    this.locals();
    const byLine = (a: LintIssue, b: LintIssue) => a.line - b.line || a.col - b.col;
    const out = this.group(this.issues.sort(byLine));
    // VS Code 는 심각도 순으로 받은 순서대로 1000개까지만 남기므로, 같은 심각도 안에서 안전 검사를 먼저
    return out.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        Number(!SAFETY_RULES.has(a.rule)) - Number(!SAFETY_RULES.has(b.rule)) ||
        byLine(a, b),
    );
  }

  /**
   * 같은 규칙이 연달아(사이에 빈 줄/주석 줄만 있는) groupMinLines 줄 이상 걸리면 블록 하나로 묶는다.
   * 각 위치는 related 로 남긴다. 안전 검사는 묶지 않는다.
   */
  private group(issues: LintIssue[]): LintIssue[] {
    const min = this.opts.groupMinLines ?? 10;
    if (min <= 0) return issues;
    const codeLines = new Set<number>();
    for (const t of this.raw) for (let l = this.pos(t.off).line, e = this.pos(t.end).line; l <= e; l++) codeLines.add(l);
    const adjacent = (a: number, b: number) => {
      for (let l = a + 1; l < b; l++) if (codeLines.has(l)) return false;
      return true;
    };
    const runs = new Map<string, LintIssue[][]>();
    for (const i of issues) {
      if (SAFETY_RULES.has(i.rule)) continue;
      const list = runs.get(i.rule) ?? [];
      const last = list[list.length - 1];
      const prev = last?.[last.length - 1];
      if (prev && adjacent(prev.endLine, i.line)) last.push(i);
      else list.push([i]);
      runs.set(i.rule, list);
    }
    const grouped = new Set<LintIssue>();
    const out: LintIssue[] = [];
    for (const [rule, list] of runs) {
      for (const run of list) {
        const lines = new Set(run.map((i) => i.line)).size;
        if (lines < min) continue;
        for (const i of run) grouped.add(i);
        const a = run[0];
        const b = run[run.length - 1];
        out.push({
          rule,
          severity: a.severity,
          line: a.line,
          col: a.col,
          endLine: b.endLine,
          endCol: b.endCol,
          message: `${RULE_TITLES[rule] ?? rule}: ${run.length}건 (${a.line + 1}~${b.endLine + 1}행, 각 위치는 관련 정보 목록)`,
          related: run.map(({ line, col, endLine, endCol, message }) => ({ line, col, endLine, endCol, message })),
        });
      }
    }
    for (const i of issues) if (!grouped.has(i)) out.push(i);
    return out;
  }

  // ───────────────────────── 공통 ─────────────────────────

  private severity(rule: string): Exclude<Severity, 'off'> | undefined {
    const s = this.opts.rules?.[rule] ?? RULES[rule];
    return s === 'off' ? undefined : s;
  }

  private add(rule: string, line: number, col: number, endLine: number, endCol: number, message: string): void {
    const severity = this.severity(rule);
    if (severity) this.issues.push({ rule, severity, line, col, endLine, endCol, message });
  }

  private addAtDef(rule: string, d: Def, message: string): void {
    this.add(rule, d.line, d.col, d.line, d.col + d.name.length, message);
  }

  private addAtTok(rule: string, a: Token, b: Token, message: string): void {
    const s = this.pos(a.off);
    const e = this.pos(b.end);
    this.add(rule, s.line, s.col, e.line, e.col, message);
  }

  private pos(off: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: off - this.lineStarts[lo] };
  }

  private defTok(d: Def): number | undefined {
    const start = this.lineStarts[d.line];
    return start === undefined ? undefined : this.tokAt.get(start + d.col);
  }

  private matchClose(ts: Token[], open: number, limit = ts.length): number {
    const o = ts[open].v;
    const c = o === '(' ? ')' : o === '[' ? ']' : '}';
    let depth = 0;
    for (let j = open; j < limit; j++) {
      const t = ts[j];
      if (t.k !== Tk.Punct) continue;
      if (t.v === o) depth++;
      else if (t.v === c && --depth === 0) return j;
    }
    return -1;
  }

  private bodyOf(ti: number): Body | undefined {
    return this.bodies.find((b) => b.open < ti && ti < b.close);
  }

  /** 정의 찾기: 현재 문서가 먼저, 그다음 색인(같은 파일의 옛 색인은 제외) */
  private findDef(name: string, kinds: ReadonlySet<string>): { fi: FileIndex; def: Def; index: number } | undefined {
    const i = this.byName.get(name)?.find((k) => kinds.has(this.fi.defs[k].kind));
    if (i !== undefined) return { fi: this.fi, def: this.fi.defs[i], index: i };
    const h = this.index?.definitions(name).find((x) => kinds.has(x.def.kind) && x.file.path !== this.path);
    return h ? { fi: h.file, def: h.def, index: h.index } : undefined;
  }

  // ───────────────────────── 선언 분석 ─────────────────────────

  /** 선언 텍스트(sig)에서 타입 지정자 / 포인터 / 배열 크기를 읽는다 */
  private parseSig(sig: string, name: string): { spec: string[]; ptr: number; dims: Token[][]; funcPtr: boolean } | undefined {
    const ts = lex(sig);
    let depth = 0;
    let ni = -1;
    for (let j = 0; j < ts.length; j++) {
      const t = ts[j];
      if (isP(t, '{')) depth++;
      else if (isP(t, '}')) depth--;
      else if (depth === 0 && t.k === Tk.Ident && t.v === name) {
        ni = j;
        break;
      }
    }
    if (ni < 0) return undefined;
    const spec: string[] = [];
    let ptr = 0;
    let funcPtr = false;
    depth = 0;
    for (let j = 0; j < ni; j++) {
      const t = ts[j];
      if (isP(t, '{')) depth++;
      else if (isP(t, '}')) depth--;
      else if (depth > 0) continue;
      else if (isP(t, '*')) ptr++;
      else if (isP(t, '(')) funcPtr = true;
      else if (t.k === Tk.Ident) spec.push(t.v);
    }
    if (isP(ts[ni + 1], ')')) funcPtr = true;
    const dims: Token[][] = [];
    let j = ni + 1;
    while (isP(ts[j], '[')) {
      const c = this.matchClose(ts, j);
      if (c < 0) break;
      dims.push(ts.slice(j + 1, c));
      j = c + 1;
    }
    return { spec, ptr, dims, funcPtr };
  }

  /** 타입 지정자 단어 -> 분류. typedef 는 따라가며 포인터/배열을 더한다 */
  private resolveSpec(spec: string[], depth = 0): { cat?: string; ptr: number; dims: number } {
    const words = spec.filter((w) => !QUALIFIERS.has(w));
    const has = (w: string) => words.includes(w);
    if (has('struct')) return { cat: 'struct', ptr: 0, dims: 0 };
    if (has('union')) return { cat: 'union', ptr: 0, dims: 0 };
    if (has('enum')) return { cat: 'enum', ptr: 0, dims: 0 };
    if (words.some((w) => w.toUpperCase() === 'VARCHAR')) return { cat: 'VARCHAR', ptr: 0, dims: 0 };
    if (has('unsigned')) return { cat: 'unsigned', ptr: 0, dims: 0 };
    for (const base of ['float', 'double', 'char', 'short', 'long', 'int', 'void']) if (has(base)) return { cat: base, ptr: 0, dims: 0 };
    if (has('signed')) return { cat: 'int', ptr: 0, dims: 0 };
    const name = words[words.length - 1];
    if (!name) return { ptr: 0, dims: 0 };
    if (this.letterOf.has(name)) return { cat: name, ptr: 0, dims: 0 };
    if (depth < 8) {
      const td = this.findDef(name, new Set(['typedef']));
      if (td && td.def.sig) {
        const p = this.parseSig(td.def.sig, name);
        if (p && !p.funcPtr) {
          const r = this.resolveSpec(p.spec, depth + 1);
          return { cat: r.cat, ptr: r.ptr + p.ptr, dims: r.dims + p.dims.length };
        }
        return { ptr: 0, dims: 0 };
      }
    }
    if (STD_TYPES[name]) return { cat: STD_TYPES[name], ptr: 0, dims: 0 };
    return { ptr: 0, dims: 0 };
  }

  private declOf(d: Def): DeclInfo | undefined {
    const memo = this.declMemo.get(d);
    if (memo !== undefined) return memo ?? undefined;
    let info: DeclInfo | null = null;
    const p = d.sig ? this.parseSig(d.sig, d.name) : undefined;
    if (p) {
      const r = this.resolveSpec(p.spec);
      const letter = r.cat ? this.letterOf.get(r.cat) ?? this.letterOf.get(r.cat.toUpperCase()) : undefined;
      const varchar = r.cat === 'VARCHAR';
      info = {
        cat: r.cat,
        letter,
        isChar: !!letter && letter === this.charLetter,
        ptr: p.ptr + r.ptr,
        dims: varchar ? 0 : p.dims.length + r.dims,
        ownDims: varchar ? [] : p.dims,
        ownPtr: p.ptr,
        spec: p.spec,
        funcPtr: p.funcPtr,
      };
    }
    this.declMemo.set(d, info);
    return info ?? undefined;
  }

  /** 접두어 후보 (h_/g_ 다음 부분). 2차원 이상 배열의 a 는 하나로 줄여서 비교 */
  private expectedPrefixes(info: DeclInfo): string[] | undefined {
    const L = info.letter;
    if (!L) return undefined;
    const base = info.isChar ? (info.ptr > 0 ? ['sz', 'ac', L] : info.dims > 0 ? ['sz', 'ac'] : [L]) : [L];
    if (info.ptr > 0) {
      const p = 'p'.repeat(info.ptr);
      return base.map((b) => (info.dims > 0 ? 'a' : '') + p + b);
    }
    if (info.dims > 0) return info.isChar ? (info.dims > 1 ? base.map((b) => 'a' + b) : base) : ['a' + L];
    return base;
  }

  // ───────────────────────── 구조 파악 ─────────────────────────

  private findBodies(): void {
    const ts = this.code;
    this.fi.defs.forEach((d, fnIdx) => {
      if (d.kind !== 'function') return;
      const ti = this.defTok(d);
      if (ti === undefined) return;
      let j = ti + 1;
      if (!isP(ts[j], '(')) return;
      j = this.matchClose(ts, j);
      if (j < 0) return;
      for (j++; j < ts.length && !isP(ts[j], '{'); j++) if (isP(ts[j], '}')) return;
      if (j >= ts.length) return;
      const close = this.matchClose(ts, j);
      if (close > 0) this.bodies.push({ fnIdx, open: j, close });
    });
  }

  private sqlText(t: Token): string {
    return this.src.slice(t.off, t.end).replace(/\s+/g, ' ').toUpperCase();
  }

  private findSections(): void {
    let start = -1;
    for (const t of this.code) {
      if (t.k !== Tk.SqlStmt) continue;
      const s = this.sqlText(t);
      if (/^EXEC SQL BEGIN DECLARE SECTION/.test(s)) start = t.end;
      else if (/^EXEC SQL END DECLARE SECTION/.test(s) && start >= 0) {
        this.sections.push([start, t.off]);
        start = -1;
      }
    }
  }

  private inSection(d: Def): boolean {
    const off = (this.lineStarts[d.line] ?? 0) + d.col;
    return this.sections.some(([a, b]) => a <= off && off < b);
  }

  // ───────────────────────── L1: 주석 / 헤더가드 ─────────────────────────

  private lineComments(): void {
    for (const c of this.comments) {
      if (c.block) continue;
      this.add('comment-line', c.line, c.col, c.line, c.col + 2 + c.text.length, '// 주석 대신 /* */ 를 사용하세요');
    }
  }

  private headerGuard(): void {
    if (!HEADER_RE.test(this.path)) return;
    const ts = this.raw;
    if (!ts.length) return;
    const t0 = ts[0];
    const directives = ts.filter((t) => t.k === Tk.PPStart);
    const last = directives[directives.length - 1];
    let ok = false;
    if (t0.k === Tk.PPStart) {
      if (t0.v === 'pragma' && /^#\s*pragma\s+once\b/.test(this.src.slice(t0.off, t0.off + 40))) ok = true;
      else if ((t0.v === 'ifndef' || (t0.v === 'if' && isP(ts[1], '!') && ts[2]?.v === 'defined')) && directives[1]?.v === 'define' && last?.v === 'endif') ok = true;
    }
    if (!ok) this.add('header-guard', 0, 0, 0, Math.max(1, (this.src.split('\n', 1)[0] ?? '').replace(/\r$/, '').length), '헤더가드가 없습니다 (#ifndef X / #define X … #endif)');
  }

  // ───────────────────────── L1/L2: 이름 ─────────────────────────

  private naming(): void {
    for (const d of this.fi.defs) {
      if (!NAMING_KINDS.has(d.kind)) continue;
      const info = this.declOf(d);
      if (info?.funcPtr) continue;
      const parts = splitName(d.name);
      this.prefixRule(d, info, parts);
      this.sizeRules(d, info, parts);
      this.scopeRules(d, parts);
      if (!this.prefixWarned.has(d) && !/^[A-Z][A-Za-z0-9]*$/.test(parts.body)) {
        this.addAtDef('camel-case', d, `'${d.name}': 접두어 다음은 대문자로 시작하는 CamelCase (밑줄 없이)`);
      }
    }
  }

  private prefixRule(d: Def, info: DeclInfo | undefined, parts: NameParts): void {
    if (!info) return;
    const alts = this.expectedPrefixes(info);
    if (!alts) return;
    const hung = info.dims > 1 ? parts.hung.replace(/^a+/, 'a') : parts.hung;
    if (alts.includes(hung)) return;
    const what = `${info.cat}${info.dims ? ' 배열' : ''}${info.ptr ? ' 포인터'.repeat(Math.min(info.ptr, 2)) : ''}`;
    const hint = info.isChar && info.dims > 0 && !info.ptr ? ' (NUL 로 끝나면 sz, 아니면 ac)' : '';
    this.prefixWarned.add(d);
    this.addAtDef('prefix-type', d, `'${d.name}': ${what} 은(는) '${alts.join("' / '")}' 접두어${hint} (현재 '${parts.hung || '없음'}')`);
  }

  /** sz 는 [N + 1], ac 는 + 1 없이 */
  private sizeRules(d: Def, info: DeclInfo | undefined, parts: NameParts): void {
    if (!info || d.kind === 'param' || !info.isChar || info.ownPtr || !info.ownDims.length) return;
    const last = info.ownDims[info.ownDims.length - 1];
    if (!last.length) return;
    const core = parts.hung.replace(/^a+(?=sz|ac)/, '');
    const plus = this.endsPlusOne(last, 0);
    if (core === 'sz' && plus === false) this.addAtDef('sz-plus-one', d, `'${d.name}': sz 배열은 NUL 자리를 위해 크기를 [길이 + 1] 로 선언`);
    if (core === 'ac' && plus === true) this.addAtDef('ac-no-plus-one', d, `'${d.name}': ac(NUL 없는 고정길이) 배열 크기에 + 1 을 붙이지 않음`);
  }

  /** 크기 식이 + 1 로 끝나는지. 매크로는 본문을 따라감. 판단할 수 없으면 undefined */
  private endsPlusOne(ts: Token[], depth: number): boolean | undefined {
    while (ts.length >= 2 && isP(ts[0], '(') && this.matchClose(ts, 0) === ts.length - 1) ts = ts.slice(1, -1);
    if (!ts.length || ts.some((t) => t.v === 'sizeof')) return undefined;
    const n = ts.length;
    if (n >= 2 && isP(ts[n - 2], '+') && ts[n - 1].k === Tk.Number && /^1[uUlL]*$/.test(ts[n - 1].v)) return true;
    if (n === 1 && ts[0].k === Tk.Ident) {
      const body = depth < 8 ? this.macroBody(ts[0].v) : undefined;
      return body ? this.endsPlusOne(body, depth + 1) : undefined;
    }
    if (ts[n - 1].k === Tk.Ident) return undefined;
    return false;
  }

  private scopeRules(d: Def, parts: NameParts): void {
    const isGlobal = d.kind === 'variable' || d.kind === 'extern';
    if (d.kind === 'extern') this.addAtDef('no-extern', d, `'${d.name}': 파일 간 전역 변수(extern)는 쓰지 않습니다. 해당 모듈에 Getter/Setter 를 만드세요`);
    else if (d.kind === 'variable' && !d.isStatic) this.addAtDef('global-static', d, `'${d.name}': 전역 변수는 파일 안에서만 쓰도록 static 을 붙입니다`);
    if (d.kind === 'local' && d.isStatic) this.addAtDef('static-local', d, `'${d.name}': 함수 안 static 변수는 권장하지 않습니다`);

    const needG = d.kind === 'variable' || (d.kind === 'local' && !!d.isStatic);
    if (needG && !parts.g) this.addAtDef('global-prefix', d, `'${d.name}': ${isGlobal ? '전역' : 'static'} 변수는 g_ 접두어`);
    if (!needG && !isGlobal && parts.g) this.addAtDef('global-prefix', d, `'${d.name}': g_ 는 전역(static) 변수에만 붙입니다`);

    if (d.kind === 'param' || d.kind === 'member') {
      if (parts.h) this.addAtDef('host-prefix', d, `'${d.name}': h_ 는 DECLARE SECTION 안의 호스트 변수에만 붙입니다`);
      return;
    }
    const inSec = this.inSection(d);
    if (inSec && !parts.h) this.addAtDef('host-prefix', d, `'${d.name}': DECLARE SECTION 안의 호스트 변수는 h_ 접두어`);
    else if (!inSec && parts.h) this.addAtDef('host-prefix', d, `'${d.name}': h_ 는 DECLARE SECTION 안의 호스트 변수에만 붙입니다`);
    else if (parts.badOrder) this.addAtDef('host-prefix', d, `'${d.name}': 순서는 h_g_ (바인드를 가장 바깥에)`);
  }

  // ───────────────────────── L2: 구조체 / 함수 ─────────────────────────

  private structs(): void {
    const ts = this.code;
    let depth = 0;
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      if (isP(t, '{')) depth++;
      else if (isP(t, '}')) depth--;
      if (depth !== 0 || t.k !== Tk.Ident || (t.v !== 'struct' && t.v !== 'union')) continue;
      const next = ts[k + 1]?.k === Tk.Ident ? ts[k + 2] : ts[k + 1];
      if (!isP(next, '{')) continue;
      let typedef = false;
      for (let j = k - 1; j >= 0; j--) {
        const p = ts[j];
        if (p.k === Tk.SqlStmt || isP(p, ';') || isP(p, '}') || isP(p, '{')) break;
        if (p.v === 'typedef') typedef = true;
      }
      if (!typedef) this.addAtTok('struct-typedef', t, ts[k + 1], `${t.v} 는 typedef 와 함께 정의합니다`);
    }
    for (const d of this.fi.defs) {
      if (d.kind !== 'typedef' || d.name.endsWith('_t')) continue;
      const p = d.sig ? this.parseSig(d.sig, d.name) : undefined;
      if (p && !p.ptr && !p.funcPtr && (p.spec.includes('struct') || p.spec.includes('union'))) {
        this.addAtDef('typedef-suffix', d, `'${d.name}': 구조체 typedef 이름은 _t 로 끝냅니다`);
      }
    }
  }

  private functions(): void {
    const header = HEADER_RE.test(this.path);
    for (const d of this.fi.defs) {
      if (d.kind === 'param') {
        const info = this.declOf(d);
        if (info && (info.cat === 'struct' || info.cat === 'union') && !info.ptr && !info.dims) {
          this.addAtDef('struct-param-by-value', d, `'${d.name}': 구조체는 포인터로 전달합니다`);
        }
      }
      if (d.kind !== 'function' || d.isStatic || header || d.name === 'main' || !this.index) continue;
      const inHeader = this.index.definitions(d.name).some((h) => h.def.kind === 'prototype' && HEADER_RE.test(h.file.path));
      if (!inHeader) this.addAtDef('internal-static', d, `'${d.name}': 헤더에 선언이 없는 내부 함수는 static 을 붙입니다`);
    }
  }

  // ───────────────────────── 문장 단위 ─────────────────────────

  private statements(): void {
    const ts = this.code;
    for (const b of this.bodies) {
      for (let k = b.open + 1; k < b.close; k++) {
        const t = ts[k];
        if (t.k !== Tk.Ident || !isP(ts[k + 1], '(') || isP(ts[k - 1], '.') || isP(ts[k - 1], '->')) continue;
        const close = this.matchClose(ts, k + 1, b.close);
        if (close < 0) continue;
        if (t.v === 'if') {
          for (let j = k + 2; j < close; j++) {
            if (isP(ts[j], '=')) {
              this.addAtTok('if-assign', ts[j], ts[j], 'if 조건 안에서 대입하지 않습니다 (실수 방지)');
              break;
            }
          }
        } else if (t.v === 'memset') {
          this.memsetSize(b, k, this.splitArgs(k + 1, close));
        } else if (COPY_FUNCS.has(t.v)) {
          this.copySize(b, k, this.splitArgs(k + 1, close));
        }
      }
    }
    for (const t of this.code) {
      if (t.k === Tk.SqlInclude) this.addAtTok('sql-include', t, t, 'EXEC SQL INCLUDE 대신 #include 를 사용합니다 (pc 라인이 어긋나 로그 추적이 어려움)');
    }
  }

  private splitArgs(open: number, close: number): Token[][] {
    const out: Token[][] = [[]];
    let depth = 0;
    for (let j = open + 1; j < close; j++) {
      const t = this.code[j];
      if (t.k === Tk.Punct) {
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
        else if (t.v === ',' && depth === 0) {
          out.push([]);
          continue;
        }
      }
      out[out.length - 1].push(t);
    }
    return out;
  }

  /** 맨 앞의 (타입 *) 캐스트와 바깥 괄호를 벗긴다 */
  private stripCast(ts: Token[]): Token[] {
    for (;;) {
      if (!isP(ts[0], '(')) return ts;
      const c = this.matchClose(ts, 0);
      if (c === ts.length - 1) {
        ts = ts.slice(1, -1);
        continue;
      }
      const inner = ts.slice(1, c);
      if (c > 0 && inner.length && inner.every((t) => t.k === Tk.Ident || isP(t, '*'))) {
        ts = ts.slice(c + 1);
        continue;
      }
      return ts;
    }
  }

  private text(ts: Token[]): string {
    return ts.map((t) => (t.k === Tk.Str ? this.src.slice(t.off, t.end) : t.v)).join('');
  }

  /** 이름이 가리키는 변수 정의: 함수의 지역/파라미터 -> 파일 전역 -> 색인 */
  private lookupVar(name: string, b: Body | undefined, line: number): Def | undefined {
    if (b) {
      let best: Def | undefined;
      for (const d of this.byScope.get(b.fnIdx) ?? []) if (d.name === name && d.line <= line) best = d;
      if (best) return best;
    }
    return this.findDef(name, new Set(['variable', 'extern']))?.def;
  }

  private memsetSize(b: Body, k: number, args: Token[][]): void {
    if (args.length < 3) return;
    const sz = args[2];
    if (sz[0]?.v !== 'sizeof') return;
    let s = sz.slice(1);
    if (isP(s[0], '(') && this.matchClose(s, 0) === s.length - 1) s = s.slice(1, -1);
    if (!s.length) return;
    let dst = this.stripCast(args[0]);
    const amp = isP(dst[0], '&');
    if (amp) dst = this.stripCast(dst.slice(1));
    if (!dst.length) return;
    const dT = this.text(dst);
    const sT = this.text(s);
    const line = this.pos(this.code[k].off).line;
    if (sT === dT) {
      if (!amp && dst.length === 1 && dst[0].k === Tk.Ident) {
        const v = this.lookupVar(dst[0].v, b, line);
        const info = v && this.declOf(v);
        if (info && info.ptr > 0 && info.dims === 0) {
          this.addAtTok('memset-size', sz[0], sz[sz.length - 1], `sizeof(${sT}) 는 포인터 크기입니다. 가리키는 대상의 크기는 sizeof(*${sT})`);
        }
      }
      return;
    }
    if (sT === '*' + dT || dT === sT + '[0]') return;
    const varLike = (ts: Token[]) => ts[0].k === Tk.Ident && ts.every((t) => t.k === Tk.Ident || t.k === Tk.Number || ['.', '->', '[', ']'].includes(t.v));
    if (!varLike(s) || !varLike(dst)) return;
    if (!this.lookupVar(s[0].v, b, line) || !this.lookupVar(dst[0].v, b, line)) return;
    this.addAtTok('memset-size', sz[0], sz[sz.length - 1], `memset 대상(${dT})과 크기(sizeof(${sT}))의 변수가 다릅니다`);
  }

  // ───────────────────────── sz / ac 복사 ─────────────────────────

  /** a.b[i]->c 같은 식이 가리키는 변수/멤버 정의와 남은 바이트 크기 */
  private exprInfo(ts: Token[], b: Body | undefined, line: number): { def: Def; name: string; core: string; charArr: boolean; bytes?: number } | undefined {
    ts = this.stripCast(ts);
    if (isP(ts[0], '&')) {
      // &x[0] 만 x 와 같게 본다
      const n = ts.length;
      if (n >= 5 && isP(ts[n - 3], '[') && ts[n - 2].v === '0' && isP(ts[n - 1], ']')) ts = ts.slice(1, n - 3);
      else return undefined;
    }
    const chain: { name: string; subs: number }[] = [];
    let j = 0;
    while (j < ts.length) {
      if (ts[j].k !== Tk.Ident) return undefined;
      const el = { name: ts[j].v, subs: 0 };
      j++;
      while (isP(ts[j], '[')) {
        const c = this.matchClose(ts, j);
        if (c < 0) return undefined;
        el.subs++;
        j = c + 1;
      }
      chain.push(el);
      if (j >= ts.length) break;
      if (!isP(ts[j], '.') && !isP(ts[j], '->')) return undefined;
      j++;
    }
    if (!chain.length) return undefined;
    let def = this.lookupVar(chain[0].name, b, line);
    for (let i = 1; def && i < chain.length; i++) def = this.memberOf(def, chain[i].name);
    if (!def) return undefined;
    const last = chain[chain.length - 1];
    const info = this.declOf(def);
    const charArr = !!info && info.isChar && info.ptr === 0 && info.dims > last.subs;
    let bytes: number | undefined;
    if (charArr && info!.ownDims.length === info!.dims) {
      bytes = 1;
      for (const dim of info!.ownDims.slice(last.subs)) {
        const v = this.evalConst(dim, 0, b, line);
        if (v === undefined) {
          bytes = undefined;
          break;
        }
        bytes *= v;
      }
    }
    return { def, name: last.name, core: splitName(last.name).hung.replace(/^a+(?=sz|ac)/, ''), charArr, bytes };
  }

  private memberOf(owner: Def, member: string): Def | undefined {
    let type = owner.type;
    for (let i = 0; type && i < 8; i++) {
      const local = this.byName.get(member)?.find((k) => this.fi.defs[k].kind === 'member' && this.fi.defs[k].container === type);
      if (local !== undefined) return this.fi.defs[local];
      const remote = this.index?.members(type).find((h) => h.def.name === member && h.file.path !== this.path);
      if (remote) return remote.def;
      const td = this.findDef(type, new Set(['typedef']));
      if (!td || !td.def.type || td.def.type === type) return undefined;
      type = td.def.type;
    }
    return undefined;
  }

  /** 문자열 상수의 바이트 수 (NUL 제외). 한글 등은 EUC-KR 기준 2바이트 */
  private literalBytes(ts: Token[]): number | undefined {
    if (!ts.length || !ts.every((t) => t.k === Tk.Str)) return undefined;
    let n = 0;
    for (const t of ts) {
      const s = this.src.slice(t.off, t.end);
      if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return undefined;
      const body = s.slice(1, -1);
      for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (c === 92) {
          const e = body[i + 1];
          if (e === 'x') {
            i += 1;
            while (/[0-9a-fA-F]/.test(body[i + 1] ?? '')) i++;
          } else if (/[0-7]/.test(e ?? '')) {
            let k = 0;
            while (k < 3 && /[0-7]/.test(body[i + 1] ?? '')) {
              i++;
              k++;
            }
          } else i++;
          n++;
        } else n += c > 0x7f ? 2 : 1;
      }
    }
    return n;
  }

  private copySize(b: Body, k: number, args: Token[][]): void {
    const fn = this.code[k];
    const line = this.pos(fn.off).line;
    if (args.length < 2 || !args[0].length) return;
    const dst = this.exprInfo(args[0], b, line);
    const dName = this.text(args[0]);
    const at = (msg: string) => this.addAtTok('copy-size', fn, args[0][args[0].length - 1], msg);
    if (dst?.charArr && dst.core === 'ac' && (fn.v === 'strcpy' || fn.v === 'strcat' || fn.v === 'sprintf')) {
      at(`${fn.v}: ac(NUL 없는 고정길이) 대상 '${dName}' 에 NUL 이 들어갑니다 (memcpy 사용)`);
      return;
    }
    if (fn.v === 'strcpy') {
      const lit = this.literalBytes(args[1]);
      if (lit !== undefined) {
        if (dst?.bytes !== undefined && lit + 1 > dst.bytes) at(`strcpy: 문자열(${lit}바이트) + NUL 이 '${dName}'(${dst.bytes}바이트)보다 큽니다`);
        return;
      }
      const src = args[1].length ? this.exprInfo(args[1], b, line) : undefined;
      if (src?.charArr && src.core === 'ac') {
        at(`strcpy: 원본 '${this.text(args[1])}' 은(는) ac(NUL 없음)라 끝을 알 수 없습니다 (memcpy 사용)`);
        return;
      }
      if (src?.bytes !== undefined && dst?.bytes !== undefined && src.bytes > dst.bytes) {
        at(`strcpy: 원본 '${this.text(args[1])}'(${src.bytes}바이트)이 대상 '${dName}'(${dst.bytes}바이트)보다 커서 넘칠 수 있습니다`);
      }
      return;
    }
    if ((fn.v === 'strncpy' || fn.v === 'memcpy' || fn.v === 'memmove') && args.length >= 3 && dst?.bytes !== undefined) {
      const nT = args[2];
      const n = this.evalConst(nT, 0, b, line);
      if (n !== undefined && n > dst.bytes) {
        at(`${fn.v}: 길이(${n})가 '${dName}'(${dst.bytes}바이트)보다 큽니다`);
        return;
      }
      if (fn.v === 'strncpy' && dst.core === 'sz' && n === dst.bytes) {
        at(`strncpy: sz '${dName}' 에 크기 전체를 복사하면 NUL 자리가 없습니다 (sizeof - 1)`);
      }
    }
  }

  // ───────────────────────── 상수식 ─────────────────────────

  /** 객체형 매크로 본문 토큰. 함수형이거나 못 찾으면 undefined */
  private macroBody(name: string): Token[] | undefined {
    const m = this.findDef(name, new Set(['macro']));
    if (!m?.def.sig) return undefined;
    const ts = lex(m.def.sig);
    const ni = ts.findIndex((t) => t.k === Tk.Ident && t.v === name);
    if (ni < 0) return undefined;
    if (isP(ts[ni + 1], '(') && ts[ni + 1].off === ts[ni].end) return undefined;
    return ts.slice(ni + 1).filter((t) => t.k !== Tk.PPEnd);
  }

  /** 정수 상수식 계산 (숫자, 매크로, sizeof(char 배열), + - * / %). 모르면 undefined */
  private evalConst(ts: Token[], depth: number, b: Body | undefined, line: number): number | undefined {
    const FAIL = {};
    let p = 0;
    const primary = (): number => {
      const t = ts[p++];
      if (!t) throw FAIL;
      if (t.k === Tk.Number) {
        const s = t.v.replace(/[uUlL]+$/, '');
        if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
        if (/^0[0-7]*$/.test(s)) return parseInt(s, 8);
        if (/^[1-9][0-9]*$/.test(s)) return parseInt(s, 10);
        throw FAIL;
      }
      if (isP(t, '(')) {
        const v = sum();
        if (!isP(ts[p++], ')')) throw FAIL;
        return v;
      }
      if (isP(t, '-')) return -primary();
      if (isP(t, '+')) return primary();
      if (t.k === Tk.Ident && t.v === 'sizeof') {
        let inner: Token[];
        if (isP(ts[p], '(')) {
          const c = this.matchClose(ts, p);
          if (c < 0) throw FAIL;
          inner = ts.slice(p + 1, c);
          p = c + 1;
        } else {
          inner = [];
          while (p < ts.length && (ts[p].k === Tk.Ident || ['.', '->'].includes(ts[p].v))) inner.push(ts[p++]);
        }
        if (inner.length === 1 && inner[0].v === 'char') return 1;
        const v = this.exprInfo(inner, b, line)?.bytes;
        if (v === undefined) throw FAIL;
        return v;
      }
      if (t.k === Tk.Ident && depth < 8) {
        const body = this.macroBody(t.v);
        const v = body && this.evalConst(body, depth + 1, b, line);
        if (v === undefined) throw FAIL;
        return v;
      }
      throw FAIL;
    };
    const product = (): number => {
      let v = primary();
      while (isP(ts[p], '*') || isP(ts[p], '/') || isP(ts[p], '%')) {
        const op = ts[p++].v;
        const r = primary();
        if (op === '*') v *= r;
        else {
          if (r === 0) throw FAIL;
          v = op === '/' ? Math.trunc(v / r) : v % r;
        }
      }
      return v;
    };
    const sum = (): number => {
      let v = product();
      while (isP(ts[p], '+') || isP(ts[p], '-')) {
        const op = ts[p++].v;
        const r = product();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    };
    try {
      const v = sum();
      return p === ts.length ? v : undefined;
    } catch (e) {
      if (e === FAIL) return undefined;
      throw e;
    }
  }

  // ───────────────────────── sqlcode 확인 ─────────────────────────

  private namesUsedBy(fi: FileIndex, defIdx: number): Set<string> {
    let m = this.refNames.get(fi);
    if (!m) {
      m = new Map();
      for (let i = 0; i < fi.refs.length; i += REF_STRIDE) {
        const enc = fi.refs[i + 4];
        if (enc < 0) continue;
        let s = m.get(enc);
        if (!s) m.set(enc, (s = new Set()));
        s.add(fi.names[fi.refs[i]]);
      }
      this.refNames.set(fi, m);
    }
    return m.get(defIdx) ?? new Set();
  }

  /** 이름 자체, 또는 그 정의(매크로/함수) 본문이 base 이름을 쓰는지. 4단계까지 따라감 */
  private usesName(name: string, memo: Map<string, boolean>, base: ReadonlySet<string>, kinds: ReadonlySet<string>): boolean {
    if (base.has(name)) return true;
    const m = memo.get(name);
    if (m !== undefined) return m;
    const seen = new Set([name]);
    let frontier = [name];
    let r = false;
    for (let depth = 0; depth < 4 && frontier.length && !r; depth++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const d of this.defsNamed(n, kinds)) {
          for (const used of this.namesUsedBy(d.fi, d.index)) {
            if (base.has(used) || memo.get(used) === true) r = true;
            else if (!seen.has(used)) {
              seen.add(used);
              next.push(used);
            }
          }
        }
      }
      frontier = next;
    }
    memo.set(name, r);
    return r;
  }

  private defsNamed(name: string, kinds: ReadonlySet<string>): { fi: FileIndex; index: number }[] {
    const out: { fi: FileIndex; index: number }[] = [];
    for (const i of this.byName.get(name) ?? []) if (kinds.has(this.fi.defs[i].kind)) out.push({ fi: this.fi, index: i });
    if (!out.length && this.index) {
      for (const h of this.index.definitions(name)) if (kinds.has(h.def.kind) && h.file.path !== this.path) out.push({ fi: h.file, index: h.index });
    }
    return out;
  }

  private isChecker(name: string): boolean {
    return this.usesName(name, this.checkerMemo, this.checkBase, CHECKER_KINDS);
  }

  private isInitFn(name: string): boolean {
    return this.usesName(name, this.initFnMemo, INIT_FUNCS, INIT_KINDS);
  }

  /** 실행되는 SQL 이면 첫 단어, 아니면 undefined */
  private execWord(t: Token): string | undefined {
    const m = /^EXEC SQL (.*)$/.exec(this.sqlText(t));
    if (!m) return undefined;
    const w = m[1].split(/[\s(;]+/).filter(Boolean);
    let i = 0;
    if (w[i] === 'AT') i += 2;
    if (w[i] === 'FOR') i += 2;
    return SQL_EXEC_WORDS.has(w[i]) ? w[i] : undefined;
  }

  private sqlcode(): void {
    const ts = this.code;
    let handled = false;
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      if (t.k !== Tk.SqlStmt) continue;
      const s = this.sqlText(t);
      const w = /^EXEC SQL WHENEVER SQLERROR (\S+)/.exec(s);
      if (w) {
        handled = w[1].replace(/;$/, '') !== 'CONTINUE';
        continue;
      }
      if (handled || !this.execWord(t)) continue;
      const b = this.bodyOf(k);
      if (!b) continue;
      let ok = false;
      for (let j = k + 1; j < b.close && !ok; j++) {
        const u = ts[j];
        if (u.k === Tk.SqlStmt && this.execWord(u)) break;
        if (u.k === Tk.Ident && this.isChecker(u.v)) ok = true;
      }
      if (!ok) {
        const st = this.pos(t.off);
        const lineEnd = this.src.indexOf('\n', t.off);
        const end = this.pos(Math.min(t.end, lineEnd < 0 ? t.end : lineEnd));
        this.add('sqlcode-check', st.line, st.col, end.line, Math.max(end.col, st.col + 1), 'EXEC SQL 실행 후 sqlca.sqlcode 확인이 없습니다');
      }
    }
  }

  // ───────────────────────── 초기화 전 사용 ─────────────────────────

  private locals(): void {
    const ts = this.code;
    for (const b of this.bodies) {
      (this.byScope.get(b.fnIdx) ?? []).forEach((d) => {
        if (d.kind !== 'local' || d.isStatic) return;
        const info = this.declOf(d);
        if (!info || info.ptr) return;
        const isStruct = info.cat === 'struct' || info.cat === 'union' || info.cat === 'VARCHAR';
        const isSz = info.isChar && info.dims > 0 && splitName(d.name).hung.endsWith('sz');
        if (!isStruct && !isSz) return;
        const ti = this.defTok(d);
        if (ti === undefined) return;
        let j = ti + 1;
        while (isP(ts[j], '[')) {
          const c = this.matchClose(ts, j, b.close);
          if (c < 0) return;
          j = c + 1;
        }
        if (isP(ts[j], '=')) return;
        let end = j;
        let depth = 0;
        for (; end < b.close; end++) {
          const t = ts[end];
          if (isP(t, '(') || isP(t, '[') || isP(t, '{')) depth++;
          else if (isP(t, ')') || isP(t, ']') || isP(t, '}')) depth--;
          else if (depth <= 0 && isP(t, ';')) break;
        }
        for (let u = end + 1; u < b.close; u++) {
          const t = ts[u];
          if ((t.k !== Tk.Ident && t.k !== Tk.SqlHost) || t.v !== d.name || isP(ts[u - 1], '.') || isP(ts[u - 1], '->')) continue;
          if (!this.isInitUse(u, b, isStruct)) {
            const what = isStruct ? '구조체를' : 'sz 배열을';
            const how = isStruct ? 'memset 또는 = {0}' : 'memset, = "" 또는 [0] = 0x00';
            this.addAtDef('uninit-local', d, `'${d.name}': ${what} 초기화(${how})하기 전에 사용합니다 (${this.pos(t.off).line + 1}행)`);
          }
          break;
        }
      });
    }
  }

  private isInitUse(u: number, b: Body, isStruct: boolean): boolean {
    const ts = this.code;
    const t = ts[u];
    if (t.k === Tk.SqlHost) return false;
    // memset(&x, …) / INIT_MACRO(x) 의 첫 인자
    let depth = 0;
    for (let k = u - 1; k > b.open; k--) {
      const p = ts[k];
      if (isP(p, ')')) depth++;
      else if (isP(p, '(')) {
        if (depth === 0) {
          const callee = ts[k - 1];
          if (callee?.k === Tk.Ident && this.isInitFn(callee.v)) return true;
          break;
        }
        depth--;
      } else if (depth === 0 && (isP(p, ',') || isP(p, ';') || isP(p, '{') || isP(p, '}'))) break;
    }
    if (isStruct) return isP(ts[u + 1], '=');
    // sz[0] = … / *sz = …
    if (isP(ts[u + 1], '[') && ts[u + 2]?.v === '0' && isP(ts[u + 3], ']') && isP(ts[u + 4], '=')) return true;
    return isP(ts[u - 1], '*') && isP(ts[u + 1], '=');
  }
}
