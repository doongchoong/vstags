import { lex, Tk, Token } from '../core/lexer';
import { Declarator, Expr, SqlHost, Stmt, TypeSpec, WheneverAction } from './ast';

/**
 * 시뮬레이터용 C 문장/식 파서.
 * 색인기 파서와 달리 식 구조까지 만든다. 함수 본문만 대상으로 하며,
 * 해석할 수 없는 문장은 'unsupported' 노드로 남기고 다음 ';' 부터 계속한다.
 * 매크로는 색인의 #define 정의로 토큰 단위 전개한다.
 */

/** raw: 문자열/문자 리터럴 원문, hide: 재전개 금지 매크로 이름 */
export type PT = Token & { raw?: string; hide?: Set<string> };

export interface MacroDef {
  params?: string[];
  variadic: boolean;
  body: PT[];
}

export interface ParseEnv {
  isTypeName(name: string): boolean;
  isVariable(name: string): boolean;
  macro(name: string): MacroDef | undefined;
  fileName: string;
  funcName: string;
  /** 무시 목록에 있는 매크로는 호출째로 없앤다 (PRINT_STRUCT(x); -> ;) */
  isIgnored?(name: string): boolean;
  /** 로깅 함수로 등록된 매크로는 펼치지 않는다 (그 이름으로 로그 출력) */
  isLogged?(name: string): boolean;
}

export class ParseError extends Error {}

/** 위치 정보를 뺀 문장 (union 에 분배되는 Omit) */
type StmtBody = Stmt extends unknown ? (Stmt extends infer S ? (S extends Stmt ? Omit<S, 'id' | 'line' | 'endLine'> : never) : never) : never;

let nextId = 1;
const newId = () => nextId++;

const TYPE_KW = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'struct', 'union', 'enum',
  'const', 'volatile', '_Bool', 'static', 'register', 'extern', 'auto', 'typedef', 'inline',
]);
const STMT_KW = new Set([
  'if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'sizeof',
]);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};
const SQL_TOKENS = new Set([Tk.SqlHost, Tk.SqlCall, Tk.SqlGoto, Tk.SqlCursorDef, Tk.SqlCursorRef, Tk.SqlInclude, Tk.SqlStmt]);

/** 렉서 토큰에 리터럴 원문을 붙이고 전처리 지시문 토큰을 제거 */
export function prepareTokens(src: string, toks: Token[]): PT[] {
  const out: PT[] = [];
  let inPP = false;
  for (const t of toks) {
    if (t.k === Tk.PPStart) {
      inPP = true;
      continue;
    }
    if (t.k === Tk.PPEnd) {
      inPP = false;
      continue;
    }
    if (inPP) continue;
    const pt: PT = { ...t };
    if (t.k === Tk.Str || t.k === Tk.Chr) pt.raw = src.slice(t.off, t.end);
    out.push(pt);
  }
  return out;
}

/** `#define NAME(a, b) body` 원문 -> MacroDef */
export function parseMacroSig(sig: string): MacroDef | undefined {
  const toks = lex(sig);
  // [PPStart define] [Ident NAME] ...
  let i = 0;
  if (toks[i]?.k !== Tk.PPStart || toks[i].v !== 'define') return undefined;
  i++;
  const name = toks[i++];
  if (!name || name.k !== Tk.Ident) return undefined;
  const def: MacroDef = { variadic: false, body: [] };
  if (toks[i] && toks[i].k === Tk.Punct && toks[i].v === '(' && toks[i].off === name.end) {
    def.params = [];
    i++;
    for (; i < toks.length && !(toks[i].k === Tk.Punct && toks[i].v === ')'); i++) {
      if (toks[i].k === Tk.Ident) def.params.push(toks[i].v);
      else if (toks[i].v === '...') def.variadic = true;
    }
    i++;
  }
  const bodyToks: Token[] = [];
  for (; i < toks.length && toks[i].k !== Tk.PPEnd; i++) bodyToks.push(toks[i]);
  def.body = bodyToks.map((t) => (t.k === Tk.Str || t.k === Tk.Chr ? { ...t, raw: sig.slice(t.off, t.end) } : { ...t }));
  return def;
}

function tokText(t: PT): string {
  return t.raw ?? t.v;
}

export function unescapeC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      default: return e;
    }
  });
}

function stripLiteral(raw: string, q: string): string {
  const s = raw.replace(/^(?:L|u8|u|U)/, '');
  const body = s.startsWith(q) ? s.slice(1, s.endsWith(q) && s.length > 1 ? -1 : undefined) : s;
  return unescapeC(body);
}

export function parseNumber(s: string): { v: number; float: boolean } {
  const isHex = /^0[xX]/.test(s);
  if (!isHex && (/[.eE]/.test(s) || /[fF]$/.test(s))) return { v: parseFloat(s.replace(/[fFlL]+$/, '')), float: true };
  const t = s.replace(/[uUlL]+$/, '');
  if (isHex) return { v: parseInt(t.slice(2), 16), float: false };
  if (/^0[bB]/.test(t)) return { v: parseInt(t.slice(2), 2), float: false };
  if (/^0[0-7]+$/.test(t)) return { v: parseInt(t, 8), float: false };
  return { v: parseInt(t, 10), float: false };
}

export class SimParser {
  private p = 0;
  private lastLine = 0;

  constructor(
    private readonly toks: PT[],
    private readonly env: ParseEnv,
    private readonly src = '',
    private readonly lineOf: (off: number) => number = () => 0,
  ) {}

  get pos(): number {
    return this.p;
  }
  set pos(v: number) {
    this.p = v;
  }

  // ───────────── 토큰 스트림 (매크로 전개 포함) ─────────────

  private peek(k = 0): PT | undefined {
    let i = this.p;
    let n = 0;
    for (;;) {
      const t = this.toks[i];
      if (!t) return undefined;
      if (t.k === Tk.Ident && !this.isMemberOrTag(i) && this.tryExpand(i)) continue;
      if (n === k) return t;
      n++;
      i++;
    }
  }

  private next(): PT {
    const t = this.peek();
    if (!t) throw new ParseError('문장이 끝나기 전에 코드가 끝났습니다');
    this.p++;
    this.lastLine = t.line;
    return t;
  }

  private isP(t: PT | undefined, v: string): boolean {
    return !!t && t.k === Tk.Punct && t.v === v;
  }

  private accept(v: string): boolean {
    if (this.isP(this.peek(), v)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(v: string): PT {
    const t = this.peek();
    if (!this.isP(t, v)) throw new ParseError(`'${v}' 가 필요한 곳에 '${t ? tokText(t) : '끝'}'`);
    return this.next();
  }

  /** p->count / s.count / struct count 의 count 는 매크로가 아님 */
  private isMemberOrTag(i: number): boolean {
    const prev = this.toks[i - 1];
    if (!prev) return false;
    if (prev.k === Tk.Punct) return prev.v === '.' || prev.v === '->';
    return prev.k === Tk.Ident && (prev.v === 'struct' || prev.v === 'union' || prev.v === 'enum');
  }

  /** toks[i] 의 매크로를 제자리에서 전개. 전개했으면 true */
  private tryExpand(i: number): boolean {
    const t = this.toks[i];
    const name = t.v;
    if (t.hide?.has(name)) return false;
    const at = (v: string, k: Tk = Tk.Punct): PT => ({ ...t, k, v, hide: t.hide });
    if (name === '__LINE__') {
      this.toks.splice(i, 1, at(String(t.line + 1), Tk.Number));
      return true;
    }
    if (name === '__FILE__' || name === '__func__' || name === '__FUNCTION__') {
      const s = name === '__FILE__' ? this.env.fileName : this.env.funcName;
      this.toks.splice(i, 1, { ...at('', Tk.Str), raw: JSON.stringify(s) });
      return true;
    }
    if (this.env.isVariable(name) || this.env.isLogged?.(name)) return false;
    const m = this.env.macro(name);
    if (!m) return false;

    let consumed = 1;
    const args: PT[][] = [];
    if (m.params) {
      if (!this.isP(this.toks[i + 1], '(')) return false;
      let depth = 0;
      let cur: PT[] = [];
      let j = i + 1;
      for (; j < this.toks.length; j++) {
        const a = this.toks[j];
        if (a.k === Tk.Punct) {
          if (a.v === '(') {
            depth++;
            if (depth === 1) continue;
          } else if (a.v === ')') {
            depth--;
            if (depth === 0) break;
          } else if (a.v === ',' && depth === 1) {
            // 가변 인자는 argOf('__VA_ARGS__') 에서 다시 쉼표로 이어 붙인다
            args.push(cur);
            cur = [];
            continue;
          }
        }
        cur.push(a);
      }
      if (j >= this.toks.length) return false;
      if (cur.length || args.length) args.push(cur);
      consumed = j - i + 1;
    }

    if (this.env.isIgnored?.(name)) {
      this.toks.splice(i, consumed);
      return true;
    }

    const hide = new Set(t.hide ?? []);
    hide.add(name);
    const params = m.params ?? [];
    const argOf = (n: string): PT[] | undefined => {
      if (n === '__VA_ARGS__' && m.variadic) {
        const rest = args.slice(params.length);
        const out: PT[] = [];
        rest.forEach((r, k) => {
          if (k) out.push(at(','));
          out.push(...r);
        });
        return out;
      }
      const k = params.indexOf(n);
      return k >= 0 ? args[k] ?? [] : undefined;
    };
    const place = (x: PT): PT => {
      const h = new Set(x.hide ?? []);
      for (const n of hide) h.add(n);
      return { ...x, line: t.line, col: t.col, hide: h };
    };
    const out: PT[] = [];
    const body = m.body;
    for (let j = 0; j < body.length; j++) {
      const b = body[j];
      if (b.k === Tk.Punct && b.v === '#' && body[j + 1]?.k === Tk.Ident && argOf(body[j + 1].v)) {
        const text = argOf(body[j + 1].v)!.map(tokText).join(' ');
        out.push({ ...place(b), k: Tk.Str, v: '', raw: JSON.stringify(text) });
        j++;
        continue;
      }
      if (b.k === Tk.Punct && b.v === '##') {
        const nb = body[j + 1];
        j++;
        if (!nb) continue;
        const right = nb.k === Tk.Ident && argOf(nb.v) ? argOf(nb.v)! : [nb];
        if (nb.v === '__VA_ARGS__' && right.length === 0 && this.isP(out[out.length - 1], ',')) {
          out.pop(); // GNU: , ## __VA_ARGS__ 에서 가변 인자가 없으면 쉼표 제거
          continue;
        }
        const left = out.pop();
        if (!left) {
          out.push(...right.map(place));
          continue;
        }
        const glued = tokText(left) + (right[0] ? tokText(right[0]) : '');
        const re = lex(glued).map((x) => ({ ...x, raw: x.k === Tk.Str || x.k === Tk.Chr ? glued.slice(x.off, x.end) : undefined }) as PT);
        out.push(...re.map(place), ...right.slice(1).map(place));
        continue;
      }
      if (b.k === Tk.Ident) {
        const a = argOf(b.v);
        if (a) {
          out.push(...a.map(place));
          continue;
        }
      }
      out.push(place(b));
    }
    this.toks.splice(i, consumed, ...out);
    return true;
  }

  // ───────────── 타입 ─────────────

  private isTypeStart(t: PT | undefined): boolean {
    if (!t || t.k !== Tk.Ident) return false;
    if (TYPE_KW.has(t.v)) return true;
    return !this.env.isVariable(t.v) && this.env.isTypeName(t.v);
  }

  /** 지정자 단어들 (struct 태그 포함). 선언자 이름 직전까지 */
  private parseSpecifiers(): string[] {
    const base: string[] = [];
    let hasType = false;
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== Tk.Ident) break;
      if (t.v === 'struct' || t.v === 'union' || t.v === 'enum') {
        this.next();
        base.push(t.v);
        if (this.isP(this.peek(), '{')) throw new ParseError('함수 안의 struct/enum 정의는 지원하지 않습니다');
        const tag = this.next();
        base.push(tag.v);
        if (this.isP(this.peek(), '{')) throw new ParseError('함수 안의 struct/enum 정의는 지원하지 않습니다');
        hasType = true;
        continue;
      }
      if (TYPE_KW.has(t.v)) {
        this.next();
        base.push(t.v);
        if (!['const', 'volatile', 'static', 'register', 'extern', 'auto', 'typedef', 'inline'].includes(t.v)) hasType = true;
        continue;
      }
      if (!hasType) {
        this.next();
        base.push(t.v);
        hasType = true;
        continue;
      }
      break;
    }
    if (!base.length) throw new ParseError('타입이 필요합니다');
    return base;
  }

  /** 캐스트/sizeof 의 타입 이름: int, char *, struct x *, EmpRec */
  private parseTypeName(): TypeSpec {
    const base = this.parseSpecifiers();
    let ptr = 0;
    for (;;) {
      if (this.accept('*')) ptr++;
      else if (this.peek()?.v === 'const' || this.peek()?.v === 'volatile') this.next();
      else break;
    }
    const dims: (Expr | null)[] = [];
    while (this.accept('[')) {
      dims.push(this.isP(this.peek(), ']') ? null : this.parseExpr());
      this.expect(']');
    }
    return { base, ptr, dims };
  }

  // ───────────── 식 ─────────────

  parseExpr(): Expr {
    let e = this.parseAssign();
    while (this.isP(this.peek(), ',')) {
      const t = this.next();
      const r = this.parseAssign();
      e = { k: 'binary', op: ',', l: e, r, id: newId(), line: t.line, col: t.col };
    }
    return e;
  }

  parseAssign(): Expr {
    const l = this.parseCond();
    const t = this.peek();
    if (t && t.k === Tk.Punct && ASSIGN.has(t.v)) {
      this.next();
      const r = this.parseAssign();
      return { k: 'assign', op: t.v, l, r, id: newId(), line: l.line, col: l.col };
    }
    return l;
  }

  private parseCond(): Expr {
    const c = this.parseBinary(1);
    if (this.isP(this.peek(), '?')) {
      this.next();
      const t = this.parseExpr();
      this.expect(':');
      const f = this.parseCond();
      return { k: 'cond', c, t, f, id: newId(), line: c.line, col: c.col };
    }
    return c;
  }

  private parseBinary(min: number): Expr {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== Tk.Punct) break;
      const p = PREC[t.v];
      if (p === undefined || p < min) break;
      this.next();
      const r = this.parseBinary(p + 1);
      l = { k: 'binary', op: t.v, l, r, id: newId(), line: l.line, col: l.col };
    }
    return l;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('식이 필요합니다');
    const mk = (op: string, e: Expr): Expr => ({ k: 'unary', op, e, id: newId(), line: t.line, col: t.col });
    if (t.k === Tk.Punct) {
      if (t.v === '++' || t.v === '--' || t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~' || t.v === '*' || t.v === '&') {
        this.next();
        return mk(t.v, this.parseUnary());
      }
      if (t.v === '(' && this.isTypeStart(this.peek(1))) {
        this.next();
        const type = this.parseTypeName();
        this.expect(')');
        if (this.isP(this.peek(), '{')) throw new ParseError('복합 리터럴은 지원하지 않습니다');
        return { k: 'cast', type, e: this.parseUnary(), id: newId(), line: t.line, col: t.col };
      }
    }
    if (t.k === Tk.Ident && t.v === 'sizeof') {
      this.next();
      if (this.isP(this.peek(), '(') && this.isTypeStart(this.peek(1))) {
        this.next();
        const type = this.parseTypeName();
        this.expect(')');
        return { k: 'sizeof', type, id: newId(), line: t.line, col: t.col };
      }
      return { k: 'sizeof', e: this.parseUnary(), id: newId(), line: t.line, col: t.col };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(e: Expr): Expr {
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== Tk.Punct) return e;
      if (t.v === '[') {
        this.next();
        const i = this.parseExpr();
        this.expect(']');
        e = { k: 'index', e, i, id: newId(), line: e.line, col: e.col };
      } else if (t.v === '(') {
        this.next();
        const args: Expr[] = [];
        if (!this.isP(this.peek(), ')')) {
          do args.push(this.parseAssign());
          while (this.accept(','));
        }
        this.expect(')');
        e = { k: 'call', callee: e, args, id: newId(), line: e.line, col: e.col };
      } else if (t.v === '.' || t.v === '->') {
        this.next();
        const n = this.next();
        if (n.k !== Tk.Ident) throw new ParseError('멤버 이름이 필요합니다');
        e = { k: 'member', e, name: n.v, arrow: t.v === '->', id: newId(), line: e.line, col: e.col };
      } else if (t.v === '++' || t.v === '--') {
        this.next();
        e = { k: 'postfix', op: t.v, e, id: newId(), line: e.line, col: e.col };
      } else return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.next();
    const base = { id: newId(), line: t.line, col: t.col };
    switch (t.k) {
      case Tk.Number:
        return { k: 'num', ...parseNumber(t.v), ...base };
      case Tk.Chr: {
        const s = stripLiteral(t.raw ?? "''", "'");
        return { k: 'num', v: s.length ? s.charCodeAt(0) : 0, float: false, ...base };
      }
      case Tk.Str: {
        let v = stripLiteral(t.raw ?? '""', '"');
        while (this.peek()?.k === Tk.Str) v += stripLiteral(this.next().raw ?? '""', '"');
        return { k: 'str', v, ...base };
      }
      case Tk.Ident:
        if (STMT_KW.has(t.v) || TYPE_KW.has(t.v)) throw new ParseError(`'${t.v}' 는 여기 올 수 없습니다`);
        return { k: 'ident', name: t.v, ...base };
      case Tk.Punct:
        if (t.v === '(') {
          const e = this.parseExpr();
          this.expect(')');
          return e;
        }
        if (t.v === '{') {
          this.p--;
          return this.parseInit();
        }
    }
    throw new ParseError(`예상하지 못한 '${tokText(t)}'`);
  }

  private parseInit(): Expr {
    const open = this.expect('{');
    const items: Expr[] = [];
    while (!this.isP(this.peek(), '}')) {
      if (this.isP(this.peek(), '.') || this.isP(this.peek(), '[')) throw new ParseError('지정 초기화(.x = ...)는 지원하지 않습니다');
      items.push(this.isP(this.peek(), '{') ? this.parseInit() : this.parseAssign());
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return { k: 'init', items, id: newId(), line: open.line, col: open.col };
  }

  // ───────────── 선언 ─────────────

  looksLikeDecl(): boolean {
    const t0 = this.peek();
    if (!t0 || t0.k !== Tk.Ident) return false;
    if (TYPE_KW.has(t0.v)) return true;
    if (STMT_KW.has(t0.v) || this.env.isVariable(t0.v)) return false;
    const t1 = this.peek(1);
    if (!t1) return false;
    if (this.env.isTypeName(t0.v) && (t1.k === Tk.Ident || this.isP(t1, '*'))) return true;
    if (t1.k === Tk.Ident && !STMT_KW.has(t1.v)) return true;
    if (this.isP(t1, '*')) {
      const t2 = this.peek(2);
      const t3 = this.peek(3);
      return !!t2 && t2.k === Tk.Ident && !!t3 && t3.k === Tk.Punct && [';', '=', ',', '['].includes(t3.v);
    }
    return false;
  }

  /** 선언문 (끝의 ';' 까지 소비). requireSemi=false 면 sig 처럼 ';' 없는 선언도 허용 */
  parseDeclaration(requireSemi = true): Declarator[] {
    const base = this.parseSpecifiers();
    const decls: Declarator[] = [];
    for (;;) {
      let ptr = 0;
      let fnPtr = false;
      let nameTok: PT;
      for (;;) {
        if (this.accept('*')) ptr++;
        else if (this.peek()?.v === 'const' || this.peek()?.v === 'volatile') this.next();
        else break;
      }
      if (this.isP(this.peek(), '(') && this.isP(this.peek(1), '*')) {
        this.next();
        this.next();
        nameTok = this.next();
        this.expect(')');
        fnPtr = true;
        this.skipBalanced('(', ')');
      } else {
        nameTok = this.next();
      }
      if (nameTok.k !== Tk.Ident) throw new ParseError('변수 이름이 필요합니다');
      if (this.isP(this.peek(), '(')) throw new ParseError('함수 안의 함수 선언은 지원하지 않습니다');
      const dims: (Expr | null)[] = [];
      while (this.accept('[')) {
        dims.push(this.isP(this.peek(), ']') ? null : this.parseExpr());
        this.expect(']');
      }
      const d: Declarator = { name: nameTok.v, type: { base, ptr, dims, fnPtr }, line: nameTok.line };
      if (this.accept('=')) d.init = this.isP(this.peek(), '{') ? this.parseInit() : this.parseAssign();
      decls.push(d);
      if (this.accept(',')) continue;
      break;
    }
    if (requireSemi) this.expect(';');
    return decls;
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let d = 1;
    while (d > 0) {
      const t = this.next();
      if (this.isP(t, open)) d++;
      else if (this.isP(t, close)) d--;
    }
  }

  // ───────────── 문장 ─────────────

  /** p 가 '{' 를 가리킬 때 블록 하나를 파싱 */
  parseBlock(): Stmt & { k: 'block' } {
    const open = this.expect('{');
    const body: Stmt[] = [];
    while (this.peek() && !this.isP(this.peek(), '}')) body.push(this.parseStmt());
    // 코드가 '}' 없이 끝나도(편집 중이거나 매크로로 괄호가 어긋난 경우) 읽은 데까지 사용
    if (this.peek()) this.next();
    return { k: 'block', body, id: newId(), line: open.line, endLine: this.lastLine };
  }

  parseStmt(): Stmt {
    const start = this.p;
    const first = this.peek();
    try {
      return this.parseStmtInner();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.p = start;
      return this.recover(e.message, first ? first.line : this.lastLine);
    }
  }

  /** 해석 실패: 다음 ';' (또는 블록 끝)까지 건너뛰고 unsupported 노드 */
  private recover(msg: string, line: number): Stmt {
    let depth = 0;
    let consumed = false;
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (depth === 0 && this.isP(t, '}') && consumed) break;
      if (depth === 0 && this.isP(t, '}') && !consumed) break;
      this.next();
      consumed = true;
      if (t.k === Tk.SqlStmt && depth === 0) break;
      if (this.isP(t, '{') || this.isP(t, '(')) depth++;
      else if (this.isP(t, '}') || this.isP(t, ')')) {
        depth--;
        if (depth === 0 && this.isP(t, '}')) break;
      } else if (this.isP(t, ';') && depth === 0) break;
    }
    // 바깥 블록의 '}' 는 먹지 않는다 (먹으면 이후 괄호가 전부 어긋남)
    if (!consumed && this.peek() && !this.isP(this.peek(), '}')) this.next();
    return { k: 'unsupported', msg, id: newId(), line, endLine: this.lastLine };
  }

  private parseStmtInner(): Stmt {
    const t = this.peek();
    if (!t) throw new ParseError('문장이 필요합니다');
    const line = t.line;
    const done = (s: StmtBody): Stmt => ({ ...s, id: newId(), line, endLine: this.lastLine }) as Stmt;

    if (SQL_TOKENS.has(t.k)) return this.parseSql();
    if (t.k === Tk.Punct) {
      if (t.v === '{') return this.parseBlock();
      if (t.v === ';') {
        this.next();
        return done({ k: 'empty' });
      }
    }
    if (t.k === Tk.Ident) {
      switch (t.v) {
        case 'if': {
          this.next();
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          const th = this.parseStmt();
          let f: Stmt | undefined;
          if (this.peek()?.v === 'else' && this.peek()?.k === Tk.Ident) {
            this.next();
            f = this.parseStmt();
          }
          return done({ k: 'if', c, t: th, f });
        }
        case 'while': {
          this.next();
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          return done({ k: 'while', c, body: this.parseStmt() });
        }
        case 'do': {
          this.next();
          const body = this.parseStmt();
          if (this.next().v !== 'while') throw new ParseError("do 뒤에 'while' 이 필요합니다");
          this.expect('(');
          const c = this.parseExpr();
          this.expect(')');
          this.expect(';');
          return done({ k: 'do', body, c });
        }
        case 'for': {
          this.next();
          this.expect('(');
          let init: Stmt | undefined;
          if (!this.accept(';')) {
            const il = this.peek()!.line;
            if (this.looksLikeDecl()) init = { k: 'decl', decls: this.parseDeclaration(), id: newId(), line: il, endLine: this.lastLine };
            else {
              init = { k: 'expr', e: this.parseExpr(), id: newId(), line: il, endLine: this.lastLine };
              this.expect(';');
            }
          }
          const c = this.isP(this.peek(), ';') ? undefined : this.parseExpr();
          this.expect(';');
          const step = this.isP(this.peek(), ')') ? undefined : this.parseExpr();
          this.expect(')');
          return done({ k: 'for', init, c, step, body: this.parseStmt() });
        }
        case 'switch': {
          this.next();
          this.expect('(');
          const e = this.parseExpr();
          this.expect(')');
          return done({ k: 'switch', e, body: this.parseStmt() });
        }
        case 'case':
        case 'default': {
          this.next();
          const e = t.v === 'case' ? this.parseCond() : undefined;
          this.expect(':');
          const body = this.isP(this.peek(), '}') ? ({ k: 'empty', id: newId(), line, endLine: line } as Stmt) : this.parseStmt();
          return done({ k: 'case', e, body });
        }
        case 'break':
        case 'continue':
          this.next();
          this.expect(';');
          return done({ k: t.v });
        case 'return': {
          this.next();
          const e = this.isP(this.peek(), ';') ? undefined : this.parseExpr();
          this.expect(';');
          return done({ k: 'return', e });
        }
        case 'goto': {
          this.next();
          const l = this.next();
          this.expect(';');
          return done({ k: 'goto', label: l.v });
        }
      }
      if (!STMT_KW.has(t.v) && this.isP(this.peek(1), ':')) {
        this.next();
        this.next();
        const body = this.isP(this.peek(), '}') ? ({ k: 'empty', id: newId(), line, endLine: line } as Stmt) : this.parseStmt();
        return done({ k: 'label', name: t.v, body });
      }
      if (this.looksLikeDecl()) return done({ k: 'decl', decls: this.parseDeclaration() });
    }
    const e = this.parseExpr();
    this.expect(';');
    return done({ k: 'expr', e });
  }

  /** EXEC SQL ...; (렉서가 만든 Sql* 토큰들 + SqlStmt) */
  private parseSql(): Stmt {
    const hostToks: PT[] = [];
    let stmt: PT | undefined;
    while (this.peek()) {
      const t = this.next();
      if (t.k === Tk.SqlStmt) {
        stmt = t;
        break;
      }
      if (t.k === Tk.SqlHost) hostToks.push(t);
    }
    if (!stmt) throw new ParseError('EXEC SQL 문장이 끝나지 않았습니다');
    const text = this.src.slice(stmt.off, stmt.end);
    const line = this.lineOf(stmt.off);
    const endLine = this.lineOf(Math.max(stmt.off, stmt.end - 1));
    const m = /^EXEC\s+(SQL|ORACLE|TOOLS|IAF)\s+(?:(?:FOR|AT)\s+:?\s*\w+\s+)?(\w+)/i.exec(text);
    const verb = m ? (m[1].toUpperCase() === 'SQL' ? m[2].toUpperCase() : 'EXEC ' + m[1].toUpperCase()) : '?';

    // INTO 출력 변수 범위
    let intoStart = -1;
    let intoEnd = Infinity;
    const into = /\bINTO\b/i.exec(text);
    if (into && (verb === 'SELECT' || verb === 'FETCH' || verb === 'EXECUTE')) {
      intoStart = stmt.off + into.index;
      const rest = text.slice(into.index + 4);
      const stop = /\b(FROM|WHERE|USING|VALUES)\b|;/i.exec(rest);
      if (stop) intoEnd = stmt.off + into.index + 4 + stop.index;
    }
    const hosts: SqlHost[] = hostToks.map((h) => ({ name: h.v, out: h.off > intoStart && intoStart >= 0 && h.off < intoEnd }));

    const s: Stmt = { k: 'sql', text, verb, hosts, id: newId(), line, endLine };
    if (verb === 'WHENEVER') {
      const w = /WHENEVER\s+(NOT\s+FOUND|SQLERROR|SQLWARNING)\s+(.*?)\s*;?\s*$/is.exec(text);
      if (w) {
        const cond = /NOT/i.test(w[1]) ? 'notFound' : /ERROR/i.test(w[1]) ? 'sqlerror' : 'sqlwarning';
        const a = w[2].replace(/\s+/g, ' ').trim();
        let action: WheneverAction = { k: 'continue' };
        let mm: RegExpExecArray | null;
        if ((mm = /^GO\s*TO\s+(\w+)/i.exec(a))) action = { k: 'goto', label: mm[1] };
        else if (/^DO\s+BREAK/i.test(a)) action = { k: 'break' };
        else if (/^DO\s+CONTINUE/i.test(a)) action = { k: 'loopContinue' };
        else if ((mm = /^DO\s+(?:CALL\s+)?(\w+)/i.exec(a))) action = { k: 'do', fn: mm[1] };
        else if (/^STOP/i.test(a)) action = { k: 'stop' };
        (s as Stmt & { k: 'sql' }).whenever = { cond, action };
      }
    }
    return s;
  }
}
