import { Expr, Stmt, WheneverAction } from './ast';
import { callBuiltin, callLog, hasBuiltin } from './builtins';
import { AUTO_LEN, CType, isCharType, MemberInfo, Memory, NeedValue, Obj, Ptr, Scalar, SimExit, typeName, Unsupported, UNKNOWN } from './memory';
import { parseNumber, unescapeC } from './parser';
import { continuationFrom } from './select';
import { SimWorld } from './world';

/**
 * 블록 시뮬레이터.
 * 원칙: 아는 값으로만 진행한다. 모르는 값이 필요하면 멈추고(need) 사용자가 넣으면 그 문장을 다시 실행한다.
 * 함수 호출은 반환값을 묻거나(ask), 사용자가 고르면 그 함수 안으로 들어가서(enter) 실행한 뒤 return 값을 돌려준다.
 * 호출 스택의 각 함수는 Simulator 하나(프레임)이고, 메모리/전역 변수/질문 답은 SimShared 로 공유한다.
 */

export type RV =
  | { k: 'num'; v: number; float: boolean }
  | { k: 'ptr'; p: Ptr | null }
  | { k: 'obj'; o: Obj }
  | { k: 'fn'; name: string };

export type Question =
  | {
      kind: 'return';
      id: number;
      fn: string;
      call: string;
      canEnter: boolean;
      /** 선언된 반환 타입의 종류. unknown = 선언을 찾지 못함 */
      ret: ReturnKind;
      /** 선언된 반환 타입 (표시용) */
      retType?: string;
    }
  | { kind: 'sqlcode'; sql: string; verb: string }
  | { kind: 'cond'; id: number; text: string };

export type SimEvent =
  | { k: 'step'; line: number; file: string; depth: number }
  | { k: 'need'; obj: Obj; line: number; msg: string }
  | { k: 'ask'; q: Question; line: number }
  | { k: 'unsupported'; msg: string; line: number };

/** 반환 타입 종류: 숫자 / char* 문자열 / 그 밖의 포인터 / 구조체 값 / void / 선언 못 찾음 */
export type ReturnKind = 'num' | 'str' | 'ptr' | 'struct' | 'void' | 'unknown';

export interface ReturnAnswer {
  value: number;
  /**
   * 반환값 종류 (없으면 num):
   *   str: 문자열 str 을 담은 버퍼의 포인터, null: NULL,
   *   new: 멤버가 ? 인 새 대상 (포인터면 그 대상을 가리킴), unknown: 내용을 모르는 대상 (쓰일 때 물음)
   */
  as?: 'num' | 'str' | 'null' | 'new' | 'unknown';
  str?: string;
  /** 들어가서 실행한 함수의 실제 반환값 (구조체/포인터 포함) */
  rv?: RV;
  /** 인자로 넘긴 버퍼/포인터 대상을 모르는 값으로 만든다 */
  havoc: boolean;
}

export type WheneverState = Partial<Record<'notFound' | 'sqlerror' | 'sqlwarning', WheneverAction>>;

type Completion =
  | { t: 'normal' }
  | { t: 'break' }
  | { t: 'continue' }
  | { t: 'return'; value?: RV }
  | { t: 'goto'; label: string }
  | { t: 'exit'; reason: string };
const NORMAL: Completion = { t: 'normal' };
/** 사용자가 건너뛴 문장 */
const SKIP: unique symbol = Symbol('skip');

export class AskSignal extends Error {
  constructor(public q: Question) {
    super('ask');
  }
}

/** 들어갈 함수의 위치 */
export interface CallTarget {
  path: string;
  name: string;
  line: number;
}

/** 호출 인자: 계산된 값, 또는 값을 복사해 올 객체 (모르는 값 ? 도 그대로 넘기기 위해) */
export type ArgVal = { k: 'rv'; rv: RV } | { k: 'obj'; o: Obj };

class EnterSignal extends Error {
  constructor(
    public id: number,
    public target: CallTarget,
    public args: ArgVal[],
    public call: string,
  ) {
    super('enter');
  }
}

const MAX_DEPTH = 32;

/** 커서까지 건너뛰기: 이 프레임의 실행을 버리고 program 부터 다시 시작 */
class JumpSignal extends Error {
  constructor(public program: Stmt[]) {
    super('jump');
  }
}

/** 호출 스택의 모든 프레임이 공유하는 상태 */
export class SimShared {
  readonly mem: Memory;
  /** 전역 변수 (static 은 파일별 키) */
  readonly globals = new Map<string, Obj>();
  readonly sqlca: Obj;
  pending: string[] = [];
  ready: string[] = [];
  /** 함수 반환값 답. 질문한 프레임(owner)의 문장이 끝나면 지운다 */
  readonly answers = new Map<number, ReturnAnswer & { owner: Simulator }>();
  readonly condAnswers = new Map<number, boolean>();
  sqlAnswer: number | undefined;
  skipRequested = false;
  /** 이번 시뮬레이션 동안 묻지 않고 무시할 함수 (로그/트레이스 함수 등) */
  readonly ignoredFns = new Set<string>();
  /** 사용자가 들어가기로 고른 호출 */
  readonly enter = new Set<number>();
  /** 들어갈 수 없었던 호출 (본문 해석 실패 등) -> 반환값을 묻는다 */
  readonly noEnter = new Set<number>();
  /** F11: 현재 문장의 첫 사용자 함수 호출로 들어간다 */
  autoEnter = false;
  /** 커서까지 건너뛰기 요청 (다음에 멈춘 지점에서 처리) */
  jump?: { frame: Simulator; program: Stmt[]; line: number };
  maxLoop = 1000;
  /** 호출된 함수의 프레임을 만든다 (session.ts 가 설정) */
  makeCallee?: (caller: Simulator, target: CallTarget, args: ArgVal[]) => Simulator;

  constructor(membersOf: (t: CType & { k: 'struct' }) => MemberInfo[]) {
    this.mem = new Memory(membersOf);
    this.sqlca = new Obj({ k: 'struct', name: 'sqlca' }, 'sqlca');
    this.mem.write(this.mem.field(this.sqlca, 'sqlcode'), 0);
    this.mem.commit();
  }
}

const ASK_VERBS = new Set(['SELECT', 'FETCH', 'UPDATE', 'INSERT', 'DELETE', 'EXECUTE', 'CALL', 'MERGE']);
const num = (v: number, float = false): RV => ({ k: 'num', v, float });

export class Simulator {
  readonly shared: SimShared;
  /** 지역 변수/파라미터, 표시 순서 유지 */
  readonly vars = new Map<string, Obj>();
  /** 이 함수에서 쓴 전역 변수 (표시용, 실제 객체는 shared.globals) */
  private readonly globalsUsed = new Map<string, Obj>();
  private readonly scopes: Map<string, Obj>[] = [];
  /** 지금 들어가 있는 호출된 함수의 프레임 */
  child?: Simulator;
  line = 0;

  constructor(
    readonly world: SimWorld,
    readonly block: Stmt[],
    private whenever: WheneverState = {},
    shared?: SimShared,
    /** 호출 깊이 (0 = 시뮬레이션을 시작한 함수) */
    readonly depth = 0,
    /** 미리 값이 정해진 지역 변수 (호출된 함수의 파라미터) */
    preset: [string, Obj][] = [],
    /** 함수 본문 전체 (커서까지 건너뛰기에서 목표 줄을 찾을 때) */
    private readonly fnBody: Stmt[] = block,
  ) {
    this.shared = shared ?? new SimShared((t) => world.membersOf(t));
    this.line = block[0]?.line ?? 0;
    for (const [n, o] of preset) this.vars.set(n, o);
    this.precreate(block);
  }

  get mem(): Memory {
    return this.shared.mem;
  }
  get sqlca(): Obj {
    return this.shared.sqlca;
  }
  get ignoredFns(): Set<string> {
    return this.shared.ignoredFns;
  }
  get maxLoop(): number {
    return this.shared.maxLoop;
  }
  set maxLoop(n: number) {
    this.shared.maxLoop = n;
  }

  // ───────────── 외부(디버그 어댑터)용 API ─────────────

  /** 가장 안쪽(지금 실행 중인) 프레임 */
  innermost(): Simulator {
    return this.child ? this.child.innermost() : this;
  }
  /** 호출 스택 (바깥 -> 안쪽) */
  frames(): Simulator[] {
    return this.child ? [this, ...this.child.frames()] : [this];
  }
  provideReturn(id: number, a: ReturnAnswer): void {
    this.shared.answers.set(id, { ...a, owner: this.innermost() });
  }
  provideCond(id: number, v: boolean): void {
    this.shared.condAnswers.set(id, v);
  }
  provideSqlcode(code: number): void {
    this.shared.sqlAnswer = code;
  }
  requestSkip(): void {
    this.shared.skipRequested = true;
  }
  /** 이 호출로 들어가기 (반환값 질문에 대한 답) */
  requestEnter(id: number): void {
    this.shared.enter.add(id);
  }
  /** F11: 다음 문장에서 처음 만나는 사용자 함수 호출로 들어간다 */
  /**
   * 커서까지 건너뛰기: 지금 실행 중인(가장 안쪽) 함수에서 line 부터 이어서 실행한다.
   * 그 사이 코드는 실행하지 않고, 지금까지의 값은 그대로 둔다.
   */
  requestJump(line: number): void {
    const f = this.innermost();
    const fn = f.world.defs[f.world.fnIdx];
    if (fn && (line < fn.line || (fn.endLine !== undefined && line > fn.endLine))) {
      throw new Error(`지금 실행 중인 함수 ${fn.name}() 안에서만 이동할 수 있습니다`);
    }
    const program = continuationFrom(f.fnBody, line);
    if (!program.length) throw new Error('그 줄 아래에 실행할 문장이 없습니다');
    this.shared.jump = { frame: f, program, line };
  }

  /** 지금 실행 중인 함수의 파일과 줄 범위 (커서까지 건너뛰기 대상 확인용) */
  jumpScope(): { file: string; from: number; to: number } {
    const f = this.innermost();
    const fn = f.world.defs[f.world.fnIdx];
    return { file: f.world.filePath, from: fn?.line ?? 0, to: fn?.endLine ?? Number.MAX_SAFE_INTEGER };
  }

  armStepIn(): void {
    this.shared.autoEnter = true;
  }
  takeOutput(): string[] {
    const o = this.shared.ready;
    this.shared.ready = [];
    return o;
  }
  emit(s: string): void {
    this.shared.pending.push(s);
  }

  /** 화면에 보여줄 변수 목록 (블록 안 선언이 바깥 것을 가림) */
  visibleVars(): [string, Obj][] {
    const m = new Map(this.vars);
    for (const [k, v] of this.globalsUsed) if (!m.has(k)) m.set(k, v);
    for (const s of this.scopes) for (const [k, v] of s) m.set(k, v);
    return [...m];
  }

  lookup(name: string): Obj | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const o = this.scopes[i].get(name);
      if (o) return o;
    }
    if (name === 'sqlca') return this.sqlca;
    let o = this.vars.get(name) ?? this.globalsUsed.get(name);
    if (o) return o;
    const info = this.world.varInfo(name, this.line);
    if (!info) return undefined;
    if (info.local) {
      o = new Obj(this.world.resolveSpec(info.spec), name);
      this.vars.set(name, o);
      return o;
    }
    // 전역 변수는 호출 스택 전체가 같은 객체를 쓴다
    o = this.shared.globals.get(info.key);
    if (!o) {
      o = new Obj(this.world.resolveSpec(info.spec), name);
      this.shared.globals.set(info.key, o);
    }
    this.globalsUsed.set(name, o);
    return o;
  }

  /** 사용자가 입력한 값 (변수 창 / 입력 상자). 형식: 123, -1.5, 'A', "문자열", NULL, ? */
  setUserValue(o: Obj, text: string): void {
    const t = text.trim();
    const mark = this.mem.mark();
    try {
      if (t === '?') this.mem.unknownDeep(o);
      else if (o.type.k === 'int' || o.type.k === 'float') {
        const n = this.parseUserNumber(t);
        this.store(o, num(n, o.type.k === 'float'));
      } else if (o.type.k === 'ptr') {
        if (t === 'NULL' || t === '0') this.mem.write(o, null);
        else throw new Error('포인터에는 NULL 만 입력할 수 있습니다 (대상을 펼쳐서 값을 넣으세요)');
      } else if (o.type.k === 'array' && isCharType(o.type.of)) {
        this.writeCStr({ arr: o, idx: 0 }, this.parseUserString(t));
      } else if (o.type.k === 'struct' && o.type.name === 'VARCHAR') {
        const s = this.parseUserString(t);
        const arr = this.mem.field(o, 'arr');
        for (let i = 0; i < s.length; i++) this.mem.write(this.mem.element(arr, i), s.charCodeAt(i));
        this.mem.write(this.mem.field(o, 'len'), s.length);
      } else if (o.type.k === 'struct' && /^\{\s*0?\s*\}$/.test(t)) {
        this.mem.zeroDeep(o);
      } else throw new Error('구조체/배열은 펼쳐서 멤버별로 입력하세요');
      this.mem.commit();
    } catch (e) {
      this.mem.rollback(mark);
      throw e instanceof Unsupported ? new Error(e.message) : e;
    }
  }

  private parseUserNumber(t: string): number {
    const c = /^'(.*)'$/.exec(t);
    if (c) return unescapeC(c[1]).charCodeAt(0) || 0;
    const neg = t.startsWith('-');
    const body = t.replace(/^[-+]/, '');
    if (!/^(0[xX][0-9a-fA-F]+|\d+(\.\d*)?([eE][-+]?\d+)?|\.\d+)[uUlLfF]*$/.test(body)) throw new Error(`숫자가 아닙니다: ${t}`);
    const v = parseNumber(body).v;
    return neg ? -v : v;
  }

  private parseUserString(t: string): string {
    const q = /^"(.*)"$/s.exec(t);
    return q ? unescapeC(q[1]) : t;
  }

  // ───────────── 실행 ─────────────

  /** program 을 실행하다가 커서까지 건너뛰기가 오면 그 지점부터 다시 */
  private *execJumpable(program: Stmt[]): Generator<SimEvent, Completion, void> {
    for (;;) {
      try {
        return yield* this.execList(program);
      } catch (e) {
        if (!(e instanceof JumpSignal)) throw e;
        program = e.program;
      }
    }
  }

  *run(): Generator<SimEvent, string, void> {
    this.scopes.push(new Map());
    try {
      const c = yield* this.execJumpable(this.block);
      switch (c.t) {
        case 'return':
          return `return ${c.value ? fmtRV(c.value) : ''} — 블록 끝`;
        case 'goto':
          return `블록 밖 레이블 '${c.label}' 로 이동 — 시뮬레이션 종료`;
        case 'break':
        case 'continue':
          return `블록 밖으로 ${c.t} — 시뮬레이션 종료`;
        case 'exit':
          return c.reason;
        default:
          return '블록 끝';
      }
    } catch (e) {
      if (e instanceof SimExit) return e.message;
      throw e;
    } finally {
      this.flushOut();
    }
  }

  /** 호출된 함수로 실행. return 값을 돌려준다 (void 면 undefined) */
  *runCall(): Generator<SimEvent, RV | undefined, void> {
    this.scopes.push(new Map());
    const c = yield* this.execJumpable(this.block);
    return c.t === 'return' ? c.value : undefined;
  }

  private step(s: { line: number }): SimEvent {
    this.line = s.line;
    return { k: 'step', line: s.line, file: this.world.filePath, depth: this.depth };
  }

  private flushOut(): void {
    this.shared.ready.push(...this.shared.pending);
    this.shared.pending = [];
  }

  /** 문장이 끝남: 되돌릴 기록과 이 프레임이 받은 답을 정리 */
  private commitStmt(): void {
    this.mem.commit();
    for (const [id, a] of this.shared.answers) if (a.owner === this) this.shared.answers.delete(id);
    this.shared.autoEnter = false;
    this.flushOut();
  }

  /** 호출된 함수 안으로 들어가 실행하고, 반환값을 이 프레임의 답으로 남긴다 */
  private *enterCall(sig: EnterSignal): Generator<SimEvent, void, void> {
    let callee: Simulator;
    try {
      if (!this.shared.makeCallee) throw new Error('지원하지 않습니다');
      callee = this.shared.makeCallee(this, sig.target, sig.args);
    } catch (err) {
      this.shared.noEnter.add(sig.id);
      this.shared.ready.push(`  ✗ ${sig.target.name}() 안으로 들어갈 수 없습니다: ${err instanceof Error ? err.message : err}`);
      return;
    }
    this.shared.ready.push(`→ ${sig.call} 진입`);
    this.child = callee;
    let rv: RV | undefined;
    try {
      rv = yield* callee.runCall();
    } finally {
      this.child = undefined;
    }
    this.shared.ready.push(`← ${sig.target.name}() ${rv ? '= ' + fmtRV(rv) : '끝'}`);
    this.shared.answers.set(sig.id, { value: 0, rv: rv ?? num(0), havoc: false, owner: this });
  }

  /** 이번 문장을 건너뛰라는 요청이 있으면 소비하고 true (콘솔에 표시) */
  private takeSkip(line: number): boolean {
    const j = this.shared.jump;
    if (j && j.frame === this) {
      this.shared.jump = undefined;
      this.shared.skipRequested = false;
      for (const [id, a] of this.shared.answers) if (a.owner === this) this.shared.answers.delete(id);
      this.shared.autoEnter = false;
      // 블록 안에서 선언한 변수도 값을 유지하도록 함수 범위로 옮긴다 (블록을 빠져나가면 scope 가 사라지므로)
      for (const sc of this.scopes) for (const [k, v] of sc) this.vars.set(k, v);
      this.flushOut();
      this.shared.ready.push(`  ⤼ ${line + 1}행에서 ${j.line + 1}행으로 건너뜀`);
      throw new JumpSignal(j.program);
    }
    if (!this.shared.skipRequested) return false;
    this.shared.skipRequested = false;
    for (const [id, a] of this.shared.answers) if (a.owner === this) this.shared.answers.delete(id);
    this.shared.autoEnter = false;
    this.flushOut();
    this.shared.ready.push(`  ⤼ ${line + 1}행 건너뜀`);
    return true;
  }

  /** 문장 직전에 멈춘다. 사용자가 건너뛰기를 누르면 true */
  private *stepSkip(line: number): Generator<SimEvent, boolean, void> {
    yield this.step({ line });
    return this.takeSkip(line);
  }

  /**
   * 한 문장(또는 그 일부)을 원자적으로 실행. 모르는 값/질문이 생기면 되돌리고 멈춘 뒤 다시 시도한다.
   * 멈춘 상태에서 사용자가 건너뛰기를 누르면 SKIP.
   */
  private *atomic<T>(line: number, fn: () => T): Generator<SimEvent, T | typeof SKIP, void> {
    for (;;) {
      const mark = this.mem.mark();
      try {
        const v = fn();
        this.commitStmt();
        return v;
      } catch (e) {
        this.mem.rollback(mark);
        this.shared.pending = [];
        if (e instanceof EnterSignal) {
          yield* this.enterCall(e);
          continue;
        }
        if (e instanceof NeedValue) yield { k: 'need', obj: e.obj, line, msg: e.message };
        else if (e instanceof AskSignal) yield { k: 'ask', q: e.q, line };
        else if (e instanceof Unsupported) yield { k: 'unsupported', msg: e.message, line };
        else throw e;
        if (this.takeSkip(line)) return SKIP;
      }
    }
  }

  /** 조건식. 계산할 수 없는(지원 안 되는) 조건은 참/거짓을 묻는다 */
  private *cond(e: Expr, line: number): Generator<SimEvent, boolean | typeof SKIP, void> {
    for (;;) {
      const mark = this.mem.mark();
      try {
        const v = this.truthy(this.eval(e));
        this.commitStmt();
        return v;
      } catch (err) {
        this.mem.rollback(mark);
        this.shared.pending = [];
        if (err instanceof EnterSignal) {
          yield* this.enterCall(err);
          continue;
        }
        if (err instanceof NeedValue) yield { k: 'need', obj: err.obj, line, msg: err.message };
        else if (err instanceof AskSignal) yield { k: 'ask', q: err.q, line };
        else if (err instanceof Unsupported) yield { k: 'ask', q: { kind: 'cond', id: e.id, text: `${exprText(e)}   (${err.message})` }, line };
        else throw err;
        if (this.takeSkip(line)) return SKIP;
        if (this.shared.condAnswers.has(e.id)) {
          const b = this.shared.condAnswers.get(e.id)!;
          this.shared.condAnswers.delete(e.id);
          return b;
        }
      }
    }
  }

  private *loopGuard(line: number, n: number): Generator<SimEvent, boolean, void> {
    yield { k: 'unsupported', msg: `반복이 ${n}회를 넘었습니다. 건너뛰기를 누르면 반복을 빠져나갑니다.`, line };
    return !this.takeSkip(line);
  }

  private *execList(list: Stmt[], start = 0): Generator<SimEvent, Completion, void> {
    let i = start;
    while (i < list.length) {
      const c = yield* this.exec(list[i]);
      if (c.t === 'goto') {
        const j = list.findIndex((s) => hasLabel(s, c.label));
        if (j >= 0) {
          i = j;
          continue;
        }
      }
      if (c.t !== 'normal') return c;
      i++;
    }
    return NORMAL;
  }

  private *withScope(fn: () => Generator<SimEvent, Completion, void>): Generator<SimEvent, Completion, void> {
    this.scopes.push(new Map());
    try {
      return yield* fn();
    } finally {
      this.scopes.pop();
    }
  }

  /** 반복문 몸체 실행 결과. undefined 면 계속 반복 */
  private loopNext(r: Completion): Completion | undefined {
    if (r.t === 'break') return NORMAL;
    if (r.t !== 'normal' && r.t !== 'continue') return r;
    return undefined;
  }

  private *exec(s: Stmt): Generator<SimEvent, Completion, void> {
    switch (s.k) {
      case 'empty':
        return NORMAL;
      case 'block':
        return yield* this.withScope(() => this.execList(s.body));
      case 'expr':
        if (yield* this.stepSkip(s.line)) return NORMAL;
        yield* this.atomic(s.line, () => this.eval(s.e));
        return NORMAL;
      case 'decl':
        if (yield* this.stepSkip(s.line)) return NORMAL;
        for (const d of s.decls) if ((yield* this.atomic(s.line, () => this.declare(d))) === SKIP) break;
        return NORMAL;
      case 'if': {
        if (yield* this.stepSkip(s.line)) return NORMAL;
        const c = yield* this.cond(s.c, s.line);
        if (c === SKIP) return NORMAL;
        if (c) return yield* this.exec(s.t);
        return s.f ? yield* this.exec(s.f) : NORMAL;
      }
      case 'while':
        for (let n = 1; ; n++) {
          if (yield* this.stepSkip(s.line)) return NORMAL;
          const c = yield* this.cond(s.c, s.line);
          if (c === SKIP || !c) return NORMAL;
          const done = this.loopNext(yield* this.exec(s.body));
          if (done) return done;
          if (n % this.maxLoop === 0 && !(yield* this.loopGuard(s.line, n))) return NORMAL;
        }
      case 'do':
        for (let n = 1; ; n++) {
          if (n === 1 && (yield* this.stepSkip(s.line))) return NORMAL;
          const done = this.loopNext(yield* this.exec(s.body));
          if (done) return done;
          if (yield* this.stepSkip(s.c.line)) return NORMAL;
          const c = yield* this.cond(s.c, s.c.line);
          if (c === SKIP || !c) return NORMAL;
          if (n % this.maxLoop === 0 && !(yield* this.loopGuard(s.line, n))) return NORMAL;
        }
      case 'for':
        return yield* this.withScope(() => this.execFor(s));
      case 'switch': {
        if (yield* this.stepSkip(s.line)) return NORMAL;
        const v = yield* this.atomic(s.line, () => this.toNum(this.eval(s.e)));
        if (v === SKIP) return NORMAL;
        const list = s.body.k === 'block' ? s.body.body : [s.body];
        // case 값이 색인에 없는 매크로면 지원 안 됨으로 멈춘다 (건너뛰면 switch 전체를 건너뜀)
        const target = yield* this.atomic(s.line, () => {
          let def = -1;
          for (let i = 0; i < list.length; i++) {
            for (let c: Stmt = list[i]; c.k === 'case' || c.k === 'label'; c = c.body) {
              if (c.k !== 'case') continue;
              if (!c.e) def = def < 0 ? i : def;
              else if (this.toNum(this.eval(c.e)) === v) return i;
            }
          }
          return def;
        });
        if (target === SKIP || target < 0) return NORMAL;
        const r = yield* this.withScope(() => this.execList(list, target));
        return r.t === 'break' ? NORMAL : r;
      }
      case 'case':
      case 'label':
        return yield* this.exec(s.body);
      case 'return': {
        if (yield* this.stepSkip(s.line)) return NORMAL;
        const e = s.e;
        if (!e) return { t: 'return' };
        const v = yield* this.atomic(s.line, () => this.eval(e));
        return v === SKIP ? NORMAL : { t: 'return', value: v };
      }
      case 'break':
      case 'continue':
        if (yield* this.stepSkip(s.line)) return NORMAL;
        return { t: s.k };
      case 'goto':
        if (yield* this.stepSkip(s.line)) return NORMAL;
        return { t: 'goto', label: s.label };
      case 'sql':
        return yield* this.execSql(s);
      case 'unsupported':
        if (yield* this.stepSkip(s.line)) return NORMAL;
        for (;;) {
          yield { k: 'unsupported', msg: `해석할 수 없는 문장: ${s.msg}`, line: s.line };
          if (this.takeSkip(s.line)) return NORMAL;
        }
      case 'resume':
        return yield* this.execResume(s);
    }
  }

  /** 반복문/switch 몸체 중간에서 시작: 남은 몸체를 실행하고 바깥 반복을 이어간다 */
  private *execResume(s: Stmt & { k: 'resume' }): Generator<SimEvent, Completion, void> {
    const r = yield* this.withScope(() => this.execList(s.rest));
    const L = s.loop;
    if (L.k === 'switch') return r.t === 'break' ? NORMAL : r;
    if (r.t === 'break') return NORMAL;
    if (r.t !== 'normal' && r.t !== 'continue') return r;
    switch (L.k) {
      case 'for':
        return yield* this.withScope(() => this.execFor(L, true));
      case 'while':
        return yield* this.exec(L);
      case 'do': {
        if (yield* this.stepSkip(L.c.line)) return NORMAL;
        const c = yield* this.cond(L.c, L.c.line);
        return c === SKIP || !c ? NORMAL : yield* this.exec(L);
      }
    }
    return r;
  }

  /** resume: 초기식 없이, 증감식부터 이어서 반복 */
  private *execFor(s: Stmt & { k: 'for' }, resume = false): Generator<SimEvent, Completion, void> {
    if (resume) {
      const st = s.step;
      if (st && (yield* this.atomic(s.line, () => this.eval(st))) === SKIP) return NORMAL;
    } else {
      if (yield* this.stepSkip(s.line)) return NORMAL;
      const init = s.init;
      if (init?.k === 'decl') {
        for (const d of init.decls) if ((yield* this.atomic(s.line, () => this.declare(d))) === SKIP) return NORMAL;
      } else if (init?.k === 'expr' && (yield* this.atomic(s.line, () => this.eval(init.e))) === SKIP) return NORMAL;
    }
    for (let n = 1; ; n++) {
      if ((n > 1 || resume) && (yield* this.stepSkip(s.line))) return NORMAL;
      if (s.c) {
        const c = yield* this.cond(s.c, s.line);
        if (c === SKIP || !c) return NORMAL;
      }
      const done = this.loopNext(yield* this.exec(s.body));
      if (done) return done;
      const st = s.step;
      if (st && (yield* this.atomic(s.line, () => this.eval(st))) === SKIP) return NORMAL;
      if (n % this.maxLoop === 0 && !(yield* this.loopGuard(s.line, n))) return NORMAL;
    }
  }

  // ───────────── EXEC SQL ─────────────

  private *execSql(s: Stmt & { k: 'sql' }): Generator<SimEvent, Completion, void> {
    if (yield* this.stepSkip(s.line)) return NORMAL;
    if (s.whenever) {
      this.whenever[s.whenever.cond] = s.whenever.action;
      return NORMAL;
    }
    if (s.verb.startsWith('EXEC ')) return NORMAL; // EXEC ORACLE ...
    const bound = this.bindSql(s);
    this.shared.ready.push(`SQL> ${bound}`);
    const sqlcode = this.mem.field(this.sqlca, 'sqlcode');
    if (!ASK_VERBS.has(s.verb)) {
      this.mem.write(sqlcode, 0);
      this.mem.commit();
      return NORMAL;
    }
    this.shared.sqlAnswer = undefined;
    while (this.shared.sqlAnswer === undefined) {
      yield { k: 'ask', q: { kind: 'sqlcode', sql: bound, verb: s.verb }, line: s.line };
      if (this.takeSkip(s.line)) return NORMAL;
    }
    const code = this.shared.sqlAnswer;
    this.shared.sqlAnswer = undefined;
    this.mem.write(sqlcode, code);
    if (code === 0) {
      const origin = `${s.verb} (줄 ${s.line + 1}) 결과`;
      for (const h of s.hosts) {
        if (!h.out) continue;
        const o = this.lookup(h.name);
        if (o) this.mem.unknownDeep(o, origin);
      }
    }
    this.mem.commit();
    const action = code === 1403 || code === 100 ? this.whenever.notFound : code < 0 ? this.whenever.sqlerror : code > 0 ? this.whenever.sqlwarning : undefined;
    if (!action) return NORMAL;
    switch (action.k) {
      case 'goto':
        this.shared.ready.push(`  → WHENEVER: GOTO ${action.label}`);
        return { t: 'goto', label: action.label };
      case 'break':
        this.shared.ready.push('  → WHENEVER: DO BREAK');
        return { t: 'break' };
      case 'loopContinue':
        return { t: 'continue' };
      case 'do':
        this.shared.ready.push(`  → WHENEVER: DO ${action.fn}() (시뮬레이션하지 않음)`);
        return NORMAL;
      case 'stop':
        return { t: 'exit', reason: 'WHENEVER … STOP — 시뮬레이션 종료' };
    }
    return NORMAL;
  }

  /** 호스트 변수를 현재 값으로 바꾼 SQL (로그용, 모르는 값은 :name(?)) */
  private bindSql(s: Stmt & { k: 'sql' }): string {
    const outs = new Set(s.hosts.filter((h) => h.out).map((h) => h.name));
    return s.text
      .replace(/\s+/g, ' ')
      .replace(/:\s*([A-Za-z_]\w*)/g, (all, name: string) => {
        if (outs.has(name)) return all;
        const o = this.lookup(name);
        if (!o) return all;
        return this.sqlLiteral(o) ?? `:${name}(?)`;
      });
  }

  private sqlLiteral(o: Obj): string | undefined {
    if (o.type.k === 'int' || o.type.k === 'float') return o.v === UNKNOWN ? undefined : String(o.v);
    if (o.type.k === 'array' && isCharType(o.type.of)) {
      const s = this.peekCStr(o, 0);
      return s === undefined ? undefined : `'${s}'`;
    }
    if (o.type.k === 'struct' && o.type.name === 'VARCHAR') {
      const len = this.mem.field(o, 'len').v;
      if (typeof len !== 'number') return undefined;
      const arr = this.mem.field(o, 'arr');
      let s = '';
      for (let i = 0; i < len; i++) {
        const c = arr.elems?.[i]?.v;
        if (typeof c !== 'number') return undefined;
        s += String.fromCharCode(c);
      }
      return `'${s}'`;
    }
    return undefined;
  }

  // ───────────── 선언 ─────────────

  private declare(d: { name: string; type: import('./ast').TypeSpec; init?: Expr }): void {
    let t = this.world.resolveSpec(d.type);
    if (t.k === 'array' && t.len === 0 && d.init) {
      if (d.init.k === 'str') t = { ...t, len: d.init.v.length + 1 };
      else if (d.init.k === 'init') t = { ...t, len: d.init.items.length };
    }
    // 초기값 없는 선언: 선언 전에 사용자가(변수값 적용 등) 이미 정해 둔 값이 있으면 그 값을 쓴다 (C 에서는 어차피 정해지지 않은 값)
    const pre = d.init ? undefined : this.vars.get(d.name);
    const o = pre && pre.type.k === t.k ? pre : new Obj(t, d.name);
    this.scopes[this.scopes.length - 1].set(d.name, o);
    if (d.init) this.initObj(o, d.init);
  }

  private initObj(o: Obj, init: Expr): void {
    if (init.k === 'init') {
      if (o.type.k === 'array') {
        init.items.forEach((it, i) => this.initObj(this.mem.element(o, i), it));
        const n = o.type.len === AUTO_LEN ? 0 : o.type.len;
        for (let i = init.items.length; i < n; i++) this.mem.zeroDeep(this.mem.element(o, i));
      } else if (o.type.k === 'struct') {
        const ms = this.world.membersOf(o.type);
        ms.forEach((m, i) => {
          const f = this.mem.field(o, m.name);
          if (i < init.items.length) this.initObj(f, init.items[i]);
          else this.mem.zeroDeep(f);
        });
      } else if (init.items.length) this.initObj(o, init.items[0]);
      else this.mem.zeroDeep(o);
      return;
    }
    if (init.k === 'str' && o.type.k === 'array') {
      this.writeCStr({ arr: o, idx: 0 }, init.v);
      for (let i = init.v.length + 1; i < o.type.len; i++) this.mem.write(this.mem.element(o, i), 0);
      return;
    }
    this.store(o, this.eval(init));
  }

  // ───────────── 식 ─────────────

  eval(e: Expr): RV {
    switch (e.k) {
      case 'num':
        return num(e.v, e.float);
      case 'str':
        return { k: 'ptr', p: { base: this.strLit(e.v), index: 0 } };
      case 'ident': {
        const o = this.lookup(e.name);
        if (o) return this.load(o);
        const ev = this.world.enumValue(e.name);
        if (ev !== undefined) return num(ev);
        if (this.world.isFunction(e.name) || hasBuiltin(e.name)) return { k: 'fn', name: e.name };
        throw new Unsupported(`'${e.name}' 를 찾을 수 없습니다 (선언/매크로/열거자가 색인에 없음)`);
      }
      case 'unary':
        switch (e.op) {
          case '-': {
            const v = this.eval(e.e);
            return num(-this.toNum(v), isFloat(v));
          }
          case '+':
            return this.eval(e.e);
          case '!':
            return num(this.truthy(this.eval(e.e)) ? 0 : 1);
          case '~':
            return num(~this.toNum(this.eval(e.e)));
          case '*':
            return this.load(this.deref(this.ptrOf(e.e)));
          case '&':
            if (e.e.k === 'ident' && !this.lookup(e.e.name)) return this.eval(e.e); // &func
            return { k: 'ptr', p: this.addrOf(e.e) };
          case '++':
          case '--':
            return this.incdec(e.e, e.op === '++' ? 1 : -1, false);
        }
        break;
      case 'postfix':
        return this.incdec(e.e, e.op === '++' ? 1 : -1, true);
      case 'binary':
        if (e.op === ',') {
          this.eval(e.l);
          return this.eval(e.r);
        }
        if (e.op === '&&') return num(this.truthy(this.eval(e.l)) && this.truthy(this.eval(e.r)) ? 1 : 0);
        if (e.op === '||') return num(this.truthy(this.eval(e.l)) || this.truthy(this.eval(e.r)) ? 1 : 0);
        return this.binop(e.op, this.eval(e.l), this.eval(e.r));
      case 'assign': {
        const o = this.lvalue(e.l);
        const rv = e.op === '=' ? this.eval(e.r) : this.binop(e.op.slice(0, -1), this.load(o), this.eval(e.r));
        this.store(o, rv);
        return o.type.k === 'struct' || o.type.k === 'array' ? rv : this.load(o);
      }
      case 'cond':
        return this.truthy(this.eval(e.c)) ? this.eval(e.t) : this.eval(e.f);
      case 'call':
        return this.call(e);
      case 'index':
      case 'member':
        return this.load(this.lvalue(e));
      case 'cast': {
        const t = this.world.resolveSpec(e.type);
        const v = this.eval(e.e);
        if (t.k === 'int') return num(this.convInt(this.toNum(v), t.size, t.unsigned));
        if (t.k === 'float') return num(this.toNum(v), true);
        if (t.k === 'ptr' && v.k === 'num' && v.v === 0) return { k: 'ptr', p: null };
        return v;
      }
      case 'sizeof':
        return num(e.type ? this.world.sizeOf(this.world.resolveSpec(e.type)) : this.sizeofExpr(e.e!));
      case 'init':
        throw new Unsupported('초기화 목록 { } 은 선언에서만 쓸 수 있습니다');
    }
    throw new Unsupported(`지원하지 않는 식: ${exprText(e)}`);
  }

  private sizeofExpr(e: Expr): number {
    if (e.k === 'str') return e.v.length + 1;
    if (e.k === 'ident' || e.k === 'member' || e.k === 'index' || (e.k === 'unary' && e.op === '*')) {
      try {
        return this.world.sizeOf(this.lvalue(e).type);
      } catch {
        /* 아래 */
      }
    }
    const v = this.eval(e);
    return v.k === 'num' ? (v.float ? 8 : 4) : 8;
  }

  private strLit(s: string): Obj {
    const o = new Obj({ k: 'array', of: { k: 'int', name: 'char', size: 1 }, len: s.length + 1 }, JSON.stringify(s));
    o.elems = [];
    for (let i = 0; i <= s.length; i++) {
      const c = new Obj(o.type.k === 'array' ? o.type.of : o.type, `${o.path}[${i}]`);
      c.v = i < s.length ? s.charCodeAt(i) : 0;
      c.parent = o;
      c.index = i;
      o.elems.push(c);
    }
    return o;
  }

  truthy(v: RV): boolean {
    if (v.k === 'num') return v.v !== 0;
    if (v.k === 'ptr') return v.p !== null;
    return true;
  }

  toNum(v: RV): number {
    if (v.k === 'num') return v.v;
    if (v.k === 'ptr' && v.p === null) return 0;
    throw new Unsupported('포인터/구조체를 숫자로 쓸 수 없습니다');
  }

  private convInt(n: number, size: number, unsigned?: boolean): number {
    n = Math.trunc(n);
    if (size === 8) return n;
    const bits = size * 8;
    const mod = 2 ** bits;
    let r = ((n % mod) + mod) % mod;
    if (!unsigned && r >= mod / 2) r -= mod;
    return r;
  }

  binop(op: string, a: RV, b: RV): RV {
    const cmp = ['==', '!=', '<', '>', '<=', '>='].includes(op);
    if (a.k === 'ptr' || b.k === 'ptr') {
      if (cmp) {
        const pa = a.k === 'ptr' ? a.p : this.toNum(a) === 0 ? null : undefined;
        const pb = b.k === 'ptr' ? b.p : this.toNum(b) === 0 ? null : undefined;
        if (pa === undefined || pb === undefined) throw new Unsupported('포인터와 숫자를 비교할 수 없습니다');
        if (op === '==' || op === '!=') {
          const eq = pa === pb || (!!pa && !!pb && pa.base === pb.base && pa.index === pb.index);
          return num(eq === (op === '==') ? 1 : 0);
        }
        if (!pa || !pb || pa.base !== pb.base) throw new Unsupported('서로 다른 객체의 포인터 대소 비교');
        return this.binop(op, num(pa.index), num(pb.index));
      }
      if (op === '+' || op === '-') {
        if (a.k === 'ptr' && b.k === 'ptr' && op === '-') {
          if (!a.p || !b.p || a.p.base !== b.p.base) throw new Unsupported('서로 다른 객체의 포인터 뺄셈');
          return num(a.p.index - b.p.index);
        }
        const p = a.k === 'ptr' ? a.p : (b as RV & { k: 'ptr' }).p;
        const n = this.toNum(a.k === 'ptr' ? b : a) * (op === '-' ? -1 : 1);
        if (!p) throw new Unsupported('NULL 포인터 연산');
        return { k: 'ptr', p: { base: p.base, index: p.index + n } };
      }
      throw new Unsupported(`포인터에 '${op}' 연산은 지원하지 않습니다`);
    }
    const x = this.toNum(a);
    const y = this.toNum(b);
    const f = isFloat(a) || isFloat(b);
    switch (op) {
      case '+': return num(x + y, f);
      case '-': return num(x - y, f);
      case '*': return num(x * y, f);
      case '/':
        if (y === 0) throw new Unsupported('⚠ 0 으로 나누기');
        return num(f ? x / y : Math.trunc(x / y), f);
      case '%':
        if (y === 0) throw new Unsupported('⚠ 0 으로 나머지 연산');
        return num(x % y);
      case '<<': return num(x << y);
      case '>>': return num(x >> y);
      case '&': return num(x & y);
      case '|': return num(x | y);
      case '^': return num(x ^ y);
      case '==': return num(+(x === y));
      case '!=': return num(+(x !== y));
      case '<': return num(+(x < y));
      case '>': return num(+(x > y));
      case '<=': return num(+(x <= y));
      case '>=': return num(+(x >= y));
    }
    throw new Unsupported(`연산자 '${op}' 는 지원하지 않습니다`);
  }

  private incdec(e: Expr, d: number, post: boolean): RV {
    const o = this.lvalue(e);
    const cur = this.load(o);
    const next = cur.k === 'ptr' ? this.binop('+', cur, num(d)) : num(this.toNum(cur) + d, isFloat(cur));
    this.store(o, next);
    return post ? cur : this.load(o);
  }

  // ───────────── 메모리 접근 ─────────────

  load(o: Obj): RV {
    switch (o.type.k) {
      case 'array':
        return { k: 'ptr', p: { base: o, index: 0 } };
      case 'struct':
        return { k: 'obj', o };
      case 'fn':
        return { k: 'fn', name: o.type.name };
      case 'void':
        throw new Unsupported('void 값');
    }
    if (o.v === UNKNOWN) {
      // 문자 배열의 한 글자를 모르면 배열 전체(문자열)를 물어본다
      const target = o.parent && o.parent.type.k === 'array' && isCharType(o.parent.type.of) ? o.parent : o;
      throw new NeedValue(target, target.origin);
    }
    if (o.type.k === 'ptr') return { k: 'ptr', p: o.v as Ptr | null };
    const v = o.v as number;
    return num(v, o.type.k === 'float' || (o.type.k === 'int' && !!o.type.guessed && !Number.isInteger(v)));
  }

  store(o: Obj, v: RV): void {
    switch (o.type.k) {
      case 'int':
        // 정의를 모르는 타입은 정수/실수·크기를 가정하지 않고 값 그대로 (자르지 않음)
        this.mem.write(o, o.type.guessed ? this.toNum(v) : this.convInt(this.toNum(v), o.type.size, o.type.unsigned));
        return;
      case 'float':
        this.mem.write(o, this.toNum(v));
        return;
      case 'ptr':
        if (v.k === 'ptr') this.mem.write(o, v.p);
        else if (v.k === 'fn') this.mem.write(o, { base: new Obj({ k: 'fn', name: v.name }, v.name), index: 0 });
        else if (this.toNum(v) === 0) this.mem.write(o, null);
        else throw new Unsupported('포인터에 숫자를 대입할 수 없습니다');
        return;
      case 'struct':
        if (v.k !== 'obj') throw new Unsupported('구조체에 다른 값을 대입할 수 없습니다');
        this.mem.copyDeep(o, v.o);
        return;
      default:
        throw new Unsupported(`'${o.path}' 에는 대입할 수 없습니다`);
    }
  }

  lvalue(e: Expr): Obj {
    switch (e.k) {
      case 'ident': {
        const o = this.lookup(e.name);
        if (!o) throw new Unsupported(`'${e.name}' 는 변수가 아닙니다 (선언을 색인에서 찾지 못함)`);
        return o;
      }
      case 'unary':
        if (e.op === '*') return this.deref(this.ptrOf(e.e));
        break;
      case 'index':
        return this.elemAt(this.ptrOf(e.e), this.toNum(this.eval(e.i)));
      case 'member': {
        const base = e.arrow ? this.deref(this.ptrOf(e.e)) : this.lvalue(e.e);
        return this.mem.field(base, e.name);
      }
    }
    throw new Unsupported(`값을 넣거나 주소를 취할 수 없는 식: ${exprText(e)}`);
  }

  /** 식의 포인터 값. 배열은 첫 원소 포인터로, 모르는 포인터는 가상 대상으로 초기화 */
  ptrOf(e: Expr): Ptr | null {
    if (e.k === 'ident' || e.k === 'member' || e.k === 'index' || (e.k === 'unary' && e.op === '*')) {
      const o = this.lvalue(e);
      if (o.type.k === 'array') return { base: o, index: 0 };
      if (o.type.k === 'ptr') {
        if (o.v === UNKNOWN) return this.mem.autoTarget(o);
        return o.v as Ptr | null;
      }
      throw new Unsupported(`'${o.path}' 는 포인터가 아닙니다`);
    }
    const v = this.eval(e);
    if (v.k === 'ptr') return v.p;
    if (v.k === 'num' && v.v === 0) return null;
    throw new Unsupported(`포인터가 필요합니다: ${exprText(e)}`);
  }

  deref(p: Ptr | null): Obj {
    return this.elemAt(p, 0);
  }

  elemAt(p: Ptr | null, i: number): Obj {
    if (!p) throw new Unsupported('⚠ NULL 포인터 역참조');
    const idx = p.index + i;
    if (p.base.type.k === 'array') return this.mem.element(p.base, idx);
    if (idx === 0) return p.base;
    throw new Unsupported('배열이 아닌 객체에 포인터 연산');
  }

  addrOf(e: Expr): Ptr {
    const o = this.lvalue(e);
    if (o.parent && o.index !== undefined) return { base: o.parent, index: o.index };
    return { base: o, index: 0 };
  }

  // ───────────── 함수 호출 ─────────────

  private call(e: Expr & { k: 'call' }): RV {
    if (e.callee.k === 'ident' && !this.lookup(e.callee.name)) {
      const name = e.callee.name;
      const log = this.world.logFunction(name);
      if (log) return callLog(this, name, e.args, log); // 회사 로깅 함수: printf 처럼 출력
      // 설정의 무시 목록 (printf 등 내장 함수도 끌 수 있음). 포인터를 돌려주는 함수면 NULL 이 아니라 내용을 모르는 대상
      if (this.world.ignore(name)) return this.freshResult(name, this.world.returnType(name));
      if (hasBuiltin(name)) return callBuiltin(this, name, e.args);
      return this.unknownCall(e, name);
    }
    // 함수 포인터: 가리키는 함수를 알면 그 이름으로
    let name = exprText(e.callee);
    try {
      const v = this.eval(e.callee);
      if (v.k === 'fn') name = v.name;
      else if (v.k === 'ptr' && v.p && v.p.base.type.k === 'fn') name = v.p.base.type.name;
    } catch {
      /* 모르는 함수 포인터 */
    }
    return this.unknownCall(e, name);
  }

  /** 들어갈 함수에 넘길 인자. 변수면 객체째 넘겨서 모르는 값(?)도 그대로 전달 */
  private argVal(a: Expr): ArgVal {
    if (a.k === 'ident' || a.k === 'member' || a.k === 'index' || (a.k === 'unary' && a.op === '*')) {
      const o = this.lvalue(a);
      if (o.type.k === 'array') return { k: 'rv', rv: { k: 'ptr', p: { base: o, index: 0 } } };
      // 모르는 포인터는 대상을 먼저 만들어서 호출한 쪽과 호출된 쪽이 같은 대상을 보게 한다
      if (o.type.k === 'ptr' && o.v === UNKNOWN) this.mem.autoTarget(o);
      return { k: 'obj', o };
    }
    return { k: 'rv', rv: this.eval(a) };
  }

  /** 시뮬레이션하지 않는 함수: 반환값을 사용자에게 묻는다 */
  private unknownCall(e: Expr & { k: 'call' }, name: string): RV {
    const sideEffects = () => {
      for (const a of e.args) if (hasSideEffect(a)) this.eval(a);
    };
    const rt = this.world.returnType(name);
    if (this.ignoredFns.has(name) || this.world.ignore(name)) {
      sideEffects();
      return this.freshResult(name, rt);
    }
    const ans = this.shared.answers.get(e.id);
    if (ans && ans.owner === this && ans.rv) {
      sideEffects();
      return ans.rv;
    }
    if (!ans || ans.owner !== this) {
      const target = this.shared.noEnter.has(e.id) || this.depth >= MAX_DEPTH ? undefined : this.world.functionDef(name);
      if (target && (this.shared.enter.has(e.id) || this.shared.autoEnter)) {
        this.shared.enter.delete(e.id);
        this.shared.autoEnter = false;
        throw new EnterSignal(e.id, target, e.args.map((a) => this.argVal(a)), exprText(e));
      }
      sideEffects();
      throw new AskSignal({ kind: 'return', id: e.id, fn: name, call: exprText(e), canEnter: !!target, ret: returnKind(rt), retType: rt && typeName(rt) });
    }
    sideEffects();
    if (ans.havoc) {
      for (const a of e.args) {
        try {
          if (a.k === 'unary' && a.op === '&') this.mem.unknownDeep(this.lvalue(a.e), `${name}() 호출 결과`);
          else if (a.k === 'ident' || a.k === 'member' || a.k === 'index') {
            const o = this.lvalue(a);
            if (o.type.k === 'array') this.mem.unknownDeep(o, `${name}() 호출 결과`);
            else if (o.type.k === 'ptr' && o.v !== UNKNOWN && o.v) this.mem.unknownDeep((o.v as Ptr).base, `${name}() 호출 결과`);
          }
        } catch {
          /* 인자가 변수가 아니면 무시 */
        }
      }
    }
    return this.returnValue(name, ans, rt);
  }

  /** 사용자가 고른 반환값 -> 값 */
  private returnValue(name: string, a: ReturnAnswer, rt: CType | undefined): RV {
    switch (a.as) {
      case 'str': {
        const o = this.strLit(this.parseUserString(a.str ?? ''));
        o.path = `${name}() 결과`;
        return { k: 'ptr', p: { base: o, index: 0 } };
      }
      case 'null':
        return { k: 'ptr', p: null };
      case 'new':
      case 'unknown':
        return this.freshResult(name, rt);
      default:
        return num(a.value);
    }
  }

  /** 반환값을 정하지 않은 호출의 결과: 포인터면 내용을 모르는 새 대상, 구조체면 멤버가 ? 인 새 값, 그 외 0 */
  private freshResult(name: string, rt: CType | undefined): RV {
    if (rt?.k === 'ptr') return { k: 'ptr', p: this.mem.autoTarget(new Obj(rt, `${name}()`)) };
    if (rt?.k === 'struct') return { k: 'obj', o: new Obj(rt, `${name}()`) };
    return num(0);
  }

  // ───────────── 문자열 헬퍼 (builtins 용) ─────────────

  /** 문자열 인자: 모르는 char 포인터면 가리키는 버퍼를 만들어서 그 내용을 묻는다 */
  strRefOf(e: Expr): { arr: Obj; idx: number } {
    return this.charRef({ k: 'ptr', p: this.ptrOf(e) });
  }

  charRef(v: RV): { arr: Obj; idx: number } {
    if (v.k !== 'ptr') throw new Unsupported('문자열(char 포인터)이 필요합니다');
    if (!v.p) throw new Unsupported('⚠ NULL 문자열');
    const base = v.p.base;
    if (base.type.k === 'array' && isCharType(base.type.of)) return { arr: base, idx: v.p.index };
    throw new Unsupported(`'${base.path}' 는 문자 배열이 아닙니다`);
  }

  /** '\0' 까지 읽기. 모르는 글자가 있으면 NeedValue (strict) */
  readCStr(r: { arr: Obj; idx: number }, max = Infinity): string {
    let s = '';
    for (let i = r.idx; s.length < max; i++) {
      const len = r.arr.type.k === 'array' ? r.arr.type.len : 0;
      if (len > 0 && i >= len) throw new Unsupported(`⚠ '${r.arr.path}' 에 문자열 끝('\\0')이 없습니다`);
      const c = this.mem.element(r.arr, i);
      if (c.v === UNKNOWN) throw new NeedValue(r.arr, r.arr.autoOf !== undefined ? `'${r.arr.autoOf}' 가 가리키는 문자열` : r.arr.origin);
      if (c.v === 0) break;
      s += String.fromCharCode(c.v as number);
    }
    return s;
  }

  /** 표시용: 모르면 undefined */
  peekCStr(arr: Obj, idx: number): string | undefined {
    try {
      return this.readCStr({ arr, idx });
    } catch {
      return undefined;
    }
  }

  writeCStr(r: { arr: Obj; idx: number }, s: string, terminate = true): void {
    const len = r.arr.type.k === 'array' ? r.arr.type.len : 0;
    const need = s.length + (terminate ? 1 : 0);
    if (len > 0 && r.idx + need > len) {
      throw new Unsupported(`⚠ 버퍼 넘침: '${r.arr.path}' 크기 ${len}, 위치 ${r.idx} 에 ${need} 글자를 쓰려고 함`);
    }
    for (let i = 0; i < s.length; i++) this.mem.write(this.mem.element(r.arr, r.idx + i), s.charCodeAt(i));
    if (terminate) this.mem.write(this.mem.element(r.arr, r.idx + s.length), 0);
  }

  // ───────────── 준비 ─────────────

  /** 블록에서 쓰는 변수를 미리 만들어 변수 창에 ? 로 보이게 한다 */
  private precreate(block: Stmt[]): void {
    const declared = new Set<string>();
    const used: string[] = [];
    const visitE = (e: Expr | undefined): void => {
      if (!e) return;
      switch (e.k) {
        case 'ident':
          used.push(e.name);
          return;
        case 'call':
          if (e.callee.k !== 'ident') visitE(e.callee);
          e.args.forEach(visitE);
          return;
        case 'unary':
        case 'postfix':
        case 'cast':
          visitE(e.e);
          return;
        case 'sizeof':
          return;
        case 'binary':
        case 'assign':
          visitE(e.l);
          visitE(e.r);
          return;
        case 'cond':
          visitE(e.c);
          visitE(e.t);
          visitE(e.f);
          return;
        case 'index':
          visitE(e.e);
          visitE(e.i);
          return;
        case 'member':
          visitE(e.e);
          return;
        case 'init':
          e.items.forEach(visitE);
      }
    };
    const visitS = (s: Stmt | undefined): void => {
      if (!s) return;
      switch (s.k) {
        case 'expr':
          visitE(s.e);
          return;
        case 'decl':
          for (const d of s.decls) {
            declared.add(d.name);
            visitE(d.init);
          }
          return;
        case 'if':
          visitE(s.c);
          visitS(s.t);
          visitS(s.f);
          return;
        case 'while':
        case 'do':
          visitE(s.c);
          visitS(s.body);
          return;
        case 'for':
          visitS(s.init);
          visitE(s.c);
          visitE(s.step);
          visitS(s.body);
          return;
        case 'switch':
          visitE(s.e);
          visitS(s.body);
          return;
        case 'case':
        case 'label':
          visitS(s.body);
          return;
        case 'block':
          s.body.forEach(visitS);
          return;
        case 'return':
          visitE(s.e);
          return;
        case 'resume':
          s.rest.forEach(visitS);
          visitS(s.loop);
          return;
        case 'sql':
          for (const h of s.hosts) used.push(h.name);
      }
    };
    block.forEach(visitS);
    for (const n of used) {
      if (declared.has(n) || n === 'sqlca') continue;
      try {
        this.lookup(n);
      } catch {
        /* 타입 해석 실패는 실행 시 다시 */
      }
    }
  }
}

function returnKind(t: CType | undefined): ReturnKind {
  if (!t) return 'unknown';
  switch (t.k) {
    case 'ptr':
      return isCharType(t.to) ? 'str' : 'ptr';
    case 'struct':
      return 'struct';
    case 'void':
      return 'void';
    default:
      return 'num';
  }
}

function isFloat(v: RV): boolean {
  return v.k === 'num' && v.float;
}

function hasLabel(s: Stmt, label: string): boolean {
  for (let c: Stmt = s; c.k === 'case' || c.k === 'label'; c = c.body) if (c.k === 'label' && c.name === label) return true;
  return false;
}

function hasSideEffect(e: Expr): boolean {
  switch (e.k) {
    case 'assign':
    case 'postfix':
    case 'call':
      return true;
    case 'unary':
      return e.op === '++' || e.op === '--' || hasSideEffect(e.e);
    case 'binary':
      return hasSideEffect(e.l) || hasSideEffect(e.r);
    case 'cond':
      return hasSideEffect(e.c) || hasSideEffect(e.t) || hasSideEffect(e.f);
    case 'index':
      return hasSideEffect(e.e) || hasSideEffect(e.i);
    case 'member':
    case 'cast':
      return hasSideEffect(e.e);
    default:
      return false;
  }
}

export function fmtRV(v: RV): string {
  switch (v.k) {
    case 'num':
      return String(v.v);
    case 'ptr':
      return v.p ? `→ ${ptrTarget(v.p)}` : 'NULL';
    case 'obj':
      return v.o.path;
    case 'fn':
      return `${v.name}()`;
  }
}

function ptrTarget(p: Ptr): string {
  const b = p.base;
  if (b.type.k === 'array') {
    if (b.autoOf !== undefined) return p.index === 0 ? `*${b.autoOf}` : `${b.autoOf}[${p.index}]`;
    return `${b.path}[${p.index}]`;
  }
  return b.path;
}

/** 변수 창 표시용 값 문자열 */
export function formatObj(o: Obj): string {
  const t = o.type;
  const scalar = (v: Scalar) => (v === UNKNOWN ? '?' : String(v));
  switch (t.k) {
    case 'int':
      if (o.v === UNKNOWN) return '?';
      if (t.size === 1 && typeof o.v === 'number' && o.v >= 32 && o.v < 127) return `${o.v} '${String.fromCharCode(o.v)}'`;
      if (t.size === 1 && o.v === 0) return `0 '\\0'`;
      return scalar(o.v);
    case 'float':
      return scalar(o.v);
    case 'ptr':
      if (o.v === UNKNOWN) return '?';
      return o.v === null ? 'NULL' : `→ ${ptrTarget(o.v as Ptr)}`;
    case 'array': {
      if (!isCharType(t.of)) return t.len === AUTO_LEN ? '[…]' : `[${t.len}]`;
      let s = '';
      const n = t.len === AUTO_LEN ? 256 : Math.min(t.len, 256);
      for (let i = 0; i < n; i++) {
        const c = o.elems?.[i]?.v;
        if (c === undefined || c === UNKNOWN) return i === 0 ? '?' : JSON.stringify(s).slice(0, -1) + '?…"';
        if (c === 0) return JSON.stringify(s);
        s += String.fromCharCode(c as number);
      }
      return JSON.stringify(s) + (n < t.len ? '…' : '');
    }
    case 'struct':
      if (t.name === 'VARCHAR') {
        const len = o.fields?.get('len')?.v;
        const arr = o.fields?.get('arr');
        if (typeof len !== 'number') return '{len: ?}';
        let s = '';
        for (let i = 0; i < len; i++) {
          const c = arr?.elems?.[i]?.v;
          if (typeof c !== 'number') return `{len: ${len}, arr: ?}`;
          s += String.fromCharCode(c);
        }
        return `{len: ${len}, arr: ${JSON.stringify(s)}}`;
      }
      return '{…}';
    case 'fn':
      return `${t.name}()`;
    case 'void':
      return 'void';
  }
}

/** 메시지용 식 텍스트 */
export function exprText(e: Expr): string {
  switch (e.k) {
    case 'num':
      return String(e.v);
    case 'str':
      return JSON.stringify(e.v);
    case 'ident':
      return e.name;
    case 'unary':
      return e.op + exprText(e.e);
    case 'postfix':
      return exprText(e.e) + e.op;
    case 'binary':
      return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case 'assign':
      return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case 'cond':
      return `${exprText(e.c)} ? ${exprText(e.t)} : ${exprText(e.f)}`;
    case 'call':
      return `${exprText(e.callee)}(${e.args.map(exprText).join(', ')})`;
    case 'index':
      return `${exprText(e.e)}[${exprText(e.i)}]`;
    case 'member':
      return `${exprText(e.e)}${e.arrow ? '->' : '.'}${e.name}`;
    case 'cast':
      return `(${e.type.base.join(' ')}${'*'.repeat(e.type.ptr)})${exprText(e.e)}`;
    case 'sizeof':
      return `sizeof(${e.type ? e.type.base.join(' ') : exprText(e.e!)})`;
    case 'init':
      return `{${e.items.map(exprText).join(', ')}}`;
  }
}
