import * as fs from 'fs';
import * as path from 'path';
import { decode, DEFAULT_ENCODING } from '../core/fileIndexer';
import { lex, Tk } from '../core/lexer';
import { SymbolIndex } from '../core/symbolIndex';
import { Def, DefKind } from '../core/types';
import { Expr, TypeSpec } from './ast';
import type { LogConfig } from './builtins';
import { CType, MemberInfo, Unsupported } from './memory';
import { MacroDef, ParseEnv, parseMacroSig, prepareTokens, SimParser } from './parser';

const QUAL = new Set(['const', 'volatile', 'static', 'extern', 'register', 'auto', 'inline', 'typedef']);
const PRIM = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool']);
const INT_TYPEDEF = /^(u?int(8|16|32|64)_t|u?intptr_t|size_t|ssize_t|off_t|time_t|pid_t|BOOL|bool|boolean|DWORD|WORD|BYTE|UINT|ULONG|LONG|INT|SHORT|USHORT|UCHAR)$/;
const OPAQUE = new Set(['FILE', 'sql_context', 'SQL_CURSOR', 'DIR']);
const FUNCTION_ONLY: ReadonlySet<DefKind> = new Set<DefKind>(['function']);
const CHAR: CType = { k: 'int', name: 'char', size: 1 };
const INT: CType = { k: 'int', name: 'int', size: 4 };

/**
 * 시뮬레이터가 보는 "세계": 현재 파일의 정의(실시간 파싱) + 작업 영역 색인.
 * 변수 선언 타입, typedef, 구조체 멤버, 매크로, 열거자 값을 여기서 해석한다.
 */
export class SimWorld implements ParseEnv {
  private readonly macroCache = new Map<string, MacroDef | null>();
  private readonly memberCache = new Map<string, MemberInfo[]>();
  private readonly enumCache = new Map<string, number | null>();
  private readonly typedefDepth = new Set<string>();
  private readonly fileLines = new Map<string, string[] | null>();

  constructor(
    readonly index: SymbolIndex,
    readonly filePath: string,
    readonly defs: Def[],
    readonly fnIdx: number,
    /** 현재 파일 내용 (저장 안 된 편집 포함) */
    readonly src = '',
  ) {}

  get fileName(): string {
    return path.basename(this.filePath);
  }
  /** 시뮬레이션에서 무시할 함수/매크로 이름 (설정 vstags.simulator.ignore) */
  ignore: (name: string) => boolean = () => false;
  /** 회사 타입 설정 (vstags.simulator.types): 이름 -> C 타입 텍스트. 색인의 typedef 보다 우선 */
  readonly typeAliases = new Map<string, string>();
  /** 로깅 함수로 등록된 이름이면 그 설정 (설정 vstags.simulator.logFunctions) */
  logFunction: (name: string) => LogConfig | undefined = () => undefined;

  /** 로깅 매크로(LOG_ERR 등)는 펼치지 않고 그 이름으로 로그 처리 */
  isLogged(name: string): boolean {
    return !!this.logFunction(name);
  }

  isIgnored(name: string): boolean {
    return this.ignore(name);
  }

  get funcName(): string {
    return this.defs[this.fnIdx]?.name ?? '';
  }

  // ───────────── ParseEnv ─────────────

  macro(name: string): MacroDef | undefined {
    let m = this.macroCache.get(name);
    if (m === undefined) {
      const local = this.defs.find((d) => d.kind === 'macro' && d.name === name);
      const hit = local ? undefined : this.index.rankedDefinitions(name, this.filePath).find((h) => h.def.kind === 'macro');
      const def = local ?? hit?.def;
      // 색인의 sig 는 호버용으로 25줄에서 잘려 있으므로 원본 파일에서 #define 전체를 읽는다
      const text = def ? (this.defineText(local ? this.filePath : hit!.file.path, def) ?? def.sig) : undefined;
      m = (text && parseMacroSig(text)) || null;
      if (!m && name === 'NULL') m = { variadic: false, body: [{ k: Tk.Number, v: '0', line: 0, col: 0, off: 0, end: 0 }] };
      this.macroCache.set(name, m);
    }
    return m ?? undefined;
  }

  private defineText(file: string, d: Def): string | undefined {
    let lines = this.fileLines.get(file);
    if (lines === undefined) {
      try {
        const text = file === this.filePath && this.src ? this.src : decode(fs.readFileSync(file), DEFAULT_ENCODING);
        lines = text.split(/\r?\n/);
      } catch {
        lines = null;
      }
      this.fileLines.set(file, lines);
    }
    if (!lines || d.endLine === undefined) return undefined;
    const text = lines.slice(d.line, d.endLine + 1).join('\n');
    const at = text.search(/#\s*define\b/);
    return at >= 0 ? text.slice(at) : undefined;
  }

  isVariable(name: string): boolean {
    if (name === 'sqlca') return true;
    if (this.defs.some((d) => d.name === name && ((d.scope === this.fnIdx && (d.kind === 'local' || d.kind === 'param')) || (d.scope === undefined && (d.kind === 'variable' || d.kind === 'extern'))))) {
      return true;
    }
    return this.index.definitions(name).some((h) => h.def.kind === 'variable' || h.def.kind === 'extern');
  }

  isTypeName(name: string): boolean {
    if (name === 'VARCHAR' || name === 'varchar' || OPAQUE.has(name) || INT_TYPEDEF.test(name) || this.typeAliases.has(name)) return true;
    return !!this.typedefDef(name);
  }

  isFunction(name: string): boolean {
    const k = (d: Def) => d.kind === 'function' || d.kind === 'prototype';
    return this.defs.some((d) => d.name === name && k(d)) || this.index.definitions(name).some((h) => k(h.def));
  }

  private typedefDef(name: string): Def | undefined {
    return this.defs.find((d) => d.kind === 'typedef' && d.name === name) ?? this.index.rankedDefinitions(name, this.filePath).find((h) => h.def.kind === 'typedef')?.def;
  }

  // ───────────── 선언 / 타입 ─────────────

  /** 선언 텍스트(sig)에서 name 의 TypeSpec 을 얻는다:  "char h_query[512]" */
  parseSigSpec(sig: string, name: string): TypeSpec | undefined {
    const text = sig.replace(/^\s*typedef\s+/, '');
    try {
      const toks = prepareTokens(text, lex(text));
      const decls = new SimParser(toks, this).parseDeclaration(false);
      return decls.find((d) => d.name === name)?.type;
    } catch {
      return undefined;
    }
  }

  private defSpec(d: Def): TypeSpec | undefined {
    const spec = d.sig ? this.parseSigSpec(d.sig, d.name) : undefined;
    if (spec) return spec;
    // struct {…} x 처럼 sig 를 파싱할 수 없으면 색인의 타입 이름 사용
    const ptr = d.sig ? (new RegExp(`(\\*+)\\s*${d.name}\\b`).exec(d.sig)?.[1].length ?? 0) : 0;
    return { base: [d.type ?? 'int'], ptr, dims: [] };
  }

  /**
   * 변수 이름 -> 선언 타입. 함수의 지역/파라미터 우선, 그 다음 전역.
   * key: 전역 변수를 호출 스택 전체에서 공유할 때 쓰는 키 (static 이면 파일별)
   */
  varInfo(name: string, atLine: number): { spec: TypeSpec; local: boolean; key: string } | undefined {
    let best: Def | undefined;
    for (const d of this.defs) {
      if (d.name !== name || d.scope !== this.fnIdx || (d.kind !== 'local' && d.kind !== 'param')) continue;
      if (!best || (d.line <= atLine && (best.line > atLine || d.line > best.line))) best = d;
    }
    if (best) return { spec: this.defSpec(best)!, local: true, key: name };
    let file = this.filePath;
    let g = this.defs.find((d) => d.name === name && d.scope === undefined && d.kind === 'variable');
    if (!g) g = this.defs.find((d) => d.name === name && d.scope === undefined && d.kind === 'extern');
    if (!g) {
      const hits = this.index.rankedDefinitions(name, this.filePath).filter((h) => h.def.kind === 'variable' || h.def.kind === 'extern');
      let h: (typeof hits)[number] | undefined = hits.find((x) => x.def.kind === 'variable') ?? hits[0];
      if (!h) h = this.index.definitions(name).find((x) => x.def.kind === 'extern' || x.def.kind === 'variable');
      g = h?.def;
      if (h) file = h.file.path;
    }
    if (!g) return undefined;
    return { spec: this.defSpec(g)!, local: false, key: g.isStatic ? `${file}::${name}` : name };
  }

  /** 들어갈 수 있는 함수 정의 (본문이 있는 것). 현재 파일의 실시간 정의 우선 */
  functionDef(name: string): { path: string; name: string; line: number } | undefined {
    const local = this.defs.find((d) => d.kind === 'function' && d.name === name);
    if (local) return { path: this.filePath, name, line: local.line };
    const h = this.index.rankedDefinitions(name, this.filePath, FUNCTION_ONLY, this.filePath)[0];
    return h ? { path: h.file.path, name, line: h.def.line } : undefined;
  }

  resolveSpec(spec: TypeSpec): CType {
    let dims = spec.dims;
    let t = this.resolveBase(spec.base);
    if (t.k === 'struct' && t.name === 'VARCHAR' && dims.length && t.varcharLen === undefined) {
      t = { k: 'struct', name: 'VARCHAR', varcharLen: dims[0] ? this.constEval(dims[0]) : 0 };
      dims = dims.slice(1);
    }
    for (let i = 0; i < spec.ptr; i++) t = { k: 'ptr', to: t };
    if (spec.fnPtr) t = { k: 'ptr', to: { k: 'fn', name: 'fn' } };
    for (let i = dims.length - 1; i >= 0; i--) {
      const d = dims[i];
      t = { k: 'array', of: t, len: d ? this.constEval(d) : 0 };
    }
    return t;
  }

  private resolveBase(words: string[]): CType {
    const w = words.filter((x) => !QUAL.has(x));
    const agg = w.findIndex((x) => x === 'struct' || x === 'union');
    if (agg >= 0) {
      const tag = w[agg + 1] ?? '';
      return { k: 'struct', name: this.index.resolveType(tag) ?? tag };
    }
    if (w.includes('enum')) return INT;
    // 기본 타입 단어가 있으면 그것만 본다 (EXPORT char * 처럼 앞에 붙은 매크로 무시)
    const prim = w.filter((x) => PRIM.has(x));
    if (prim.length) {
      const unsigned = prim.includes('unsigned');
      const name = prim.join(' ');
      if (prim.includes('double')) return { k: 'float', name, size: 8 };
      if (prim.includes('float')) return { k: 'float', name, size: 4 };
      if (prim.includes('char')) return { k: 'int', name, size: 1, unsigned };
      if (prim.includes('short')) return { k: 'int', name, size: 2, unsigned };
      if (prim.includes('long')) return { k: 'int', name, size: 8, unsigned };
      if (prim.includes('void')) return { k: 'void' };
      if (prim.includes('_Bool')) return { k: 'int', name, size: 1, unsigned: true };
      return { k: 'int', name, size: 4, unsigned };
    }
    const n = w[w.length - 1] ?? 'int';
    // 회사 타입 설정
    const alias = this.typeAliases.get(n);
    if (alias && !this.typedefDepth.has(n)) {
      const spec = this.parseSigSpec(`${alias} __vstags_t`, '__vstags_t');
      if (spec) {
        this.typedefDepth.add(n);
        try {
          return this.resolveSpec(spec);
        } finally {
          this.typedefDepth.delete(n);
        }
      }
    }
    if (n === 'VARCHAR' || n === 'varchar') return { k: 'struct', name: 'VARCHAR' };
    if (OPAQUE.has(n)) return { k: 'struct', name: n };
    const td = this.typedefDef(n);
    if (td && !this.typedefDepth.has(n)) {
      const container = this.index.resolveType(td.type ?? n);
      if (container && this.index.members(container).length) {
        const stars = td.sig ? (new RegExp(`(\\*+)\\s*${n}\\b`).exec(td.sig)?.[1].length ?? 0) : 0;
        let t: CType = { k: 'struct', name: container };
        for (let i = 0; i < stars; i++) t = { k: 'ptr', to: t };
        return t;
      }
      const spec = td.sig ? this.parseSigSpec(td.sig, n) : undefined;
      if (spec) {
        this.typedefDepth.add(n);
        try {
          return this.resolveSpec(spec);
        } finally {
          this.typedefDepth.delete(n);
        }
      }
    }
    if (INT_TYPEDEF.test(n)) return { k: 'int', name: n, size: /64|size_t|intptr|off_t|time_t/.test(n) ? 8 : 4, unsigned: /^u|^U|DWORD|WORD|BYTE|size_t/.test(n) };
    if (this.index.members(n).length) return { k: 'struct', name: n };
    // 정의를 모르는 타입: 크기를 가정하지 않는다 (값을 자르지 않음)
    return { k: 'int', name: n, size: 8, guessed: true };
  }

  /** 함수의 선언된 반환 타입 (현재 파일 우선, 다음 색인의 정의/프로토타입). 선언을 못 찾으면 undefined */
  returnType(name: string): CType | undefined {
    const isFn = (d: Def) => (d.kind === 'function' || d.kind === 'prototype') && d.name === name;
    const d = this.defs.find(isFn) ?? this.index.definitions(name).find((h) => isFn(h.def))?.def;
    if (!d?.sig) return undefined;
    const at = d.sig.search(new RegExp(`\\b${name}\\s*\\(`));
    if (at < 0) return undefined;
    const prefix = d.sig.slice(0, at);
    const ptr = (prefix.match(/\*/g) ?? []).length;
    const base = prefix.replace(/\*/g, ' ').split(/\s+/).filter((x) => /^[A-Za-z_]\w*$/.test(x));
    if (!base.length) return INT; // 암시적 int (K&R)
    try {
      return this.resolveSpec({ base, ptr, dims: [] });
    } catch {
      return undefined;
    }
  }

  membersOf(t: CType & { k: 'struct' }): MemberInfo[] {
    if (t.name === 'VARCHAR') {
      return [
        { name: 'len', type: { k: 'int', name: 'unsigned short', size: 2, unsigned: true } },
        { name: 'arr', type: { k: 'array', of: { k: 'int', name: 'unsigned char', size: 1, unsigned: true }, len: t.varcharLen ?? 0 } },
      ];
    }
    let ms = this.memberCache.get(t.name);
    if (ms) return ms;
    if (t.name === 'sqlca') {
      ms = [
        { name: 'sqlcaid', type: { k: 'array', of: CHAR, len: 8 } },
        { name: 'sqlabc', type: INT },
        { name: 'sqlcode', type: INT },
        { name: 'sqlerrm', type: { k: 'struct', name: 'sqlerrm' } },
        { name: 'sqlerrp', type: { k: 'array', of: CHAR, len: 8 } },
        { name: 'sqlerrd', type: { k: 'array', of: INT, len: 6 } },
        { name: 'sqlwarn', type: { k: 'array', of: CHAR, len: 8 } },
      ];
    } else if (t.name === 'sqlerrm') {
      ms = [
        { name: 'sqlerrml', type: { k: 'int', name: 'short', size: 2 } },
        { name: 'sqlerrmc', type: { k: 'array', of: CHAR, len: 70 } },
      ];
    } else {
      ms = [];
      this.memberCache.set(t.name, ms); // 재귀 구조체 방지
      const seen = new Set<string>();
      for (const h of this.index.members(t.name)) {
        if (h.def.kind !== 'member' || seen.has(h.def.name)) continue;
        seen.add(h.def.name);
        const spec = this.defSpec(h.def);
        let type: CType;
        try {
          type = spec ? this.resolveSpec(spec) : INT;
        } catch {
          type = INT;
        }
        ms.push({ name: h.def.name, type });
      }
    }
    this.memberCache.set(t.name, ms);
    return ms;
  }

  sizeOf(t: CType, depth = 0): number {
    switch (t.k) {
      case 'int':
      case 'float':
        return t.size;
      case 'ptr':
      case 'fn':
        return 8;
      case 'void':
        return 1;
      case 'array':
        return t.len * this.sizeOf(t.of, depth);
      case 'struct':
        if (t.name === 'VARCHAR') return 2 + (t.varcharLen ?? 0);
        if (depth > 8) return 0;
        return this.membersOf(t).reduce((s, m) => s + this.sizeOf(m.type, depth + 1), 0);
    }
  }

  // ───────────── 상수 ─────────────

  /** 열거자 값 (명시값 또는 이전 값 + 1) */
  enumValue(name: string): number | undefined {
    const c = this.enumCache.get(name);
    if (c !== undefined) return c ?? undefined;
    this.enumCache.set(name, null); // 순환 방지
    const local = this.defs.find((d) => d.kind === 'enumerator' && d.name === name);
    let list: Def[];
    if (local) list = this.defs.filter((d) => d.kind === 'enumerator' && d.container === local.container);
    else {
      const h = this.index.definitions(name).find((x) => x.def.kind === 'enumerator');
      if (!h) return undefined;
      list = h.file.defs.filter((d) => d.kind === 'enumerator' && d.container === h.def.container);
    }
    let v = -1;
    for (const d of list) {
      const m = d.sig ? /^\s*\w+\s*=\s*([\s\S]+)$/.exec(d.sig) : null;
      if (m) {
        try {
          const toks = prepareTokens(m[1], lex(m[1]));
          v = this.constEval(new SimParser(toks, this).parseAssign());
        } catch {
          v = NaN;
        }
      } else v = v + 1;
      this.enumCache.set(d.name, Number.isNaN(v) ? null : v);
    }
    const r = this.enumCache.get(name);
    return r ?? undefined;
  }

  /** 변수 없이 계산되는 상수식 (배열 크기, case 값, 열거자) */
  constEval(e: Expr): number {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'unary': {
        const v = this.constEval(e.e);
        if (e.op === '-') return -v;
        if (e.op === '+') return v;
        if (e.op === '~') return ~v;
        if (e.op === '!') return v ? 0 : 1;
        break;
      }
      case 'binary': {
        const a = this.constEval(e.l);
        const b = this.constEval(e.r);
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b ? Math.trunc(a / b) : NaN;
          case '%': return b ? a % b : NaN;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          case '==': return +(a === b);
          case '!=': return +(a !== b);
          case '<': return +(a < b);
          case '>': return +(a > b);
          case '<=': return +(a <= b);
          case '>=': return +(a >= b);
          case '&&': return +(!!a && !!b);
          case '||': return +(!!a || !!b);
        }
        break;
      }
      case 'cond':
        return this.constEval(e.c) ? this.constEval(e.t) : this.constEval(e.f);
      case 'cast':
        return this.constEval(e.e);
      case 'sizeof':
        if (e.type) return this.sizeOf(this.resolveSpec(e.type));
        break;
      case 'ident': {
        const v = this.enumValue(e.name);
        if (v !== undefined) return v;
        throw new Unsupported(`상수 '${e.name}' 의 값을 모릅니다`);
      }
    }
    throw new Unsupported('상수식으로 계산할 수 없습니다');
  }
}
