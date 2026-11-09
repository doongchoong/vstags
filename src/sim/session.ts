import * as fs from 'fs';
import { decode, DEFAULT_ENCODING } from '../core/fileIndexer';
import { lex, Tk } from '../core/lexer';
import { parseSource } from '../core/parser';
import { filterConditionals } from '../core/preproc';
import { enclosingFunction, SymbolIndex } from '../core/symbolIndex';
import { Def } from '../core/types';
import { Stmt } from './ast';
import type { LogConfig } from './builtins';
import { continuationFrom, selectStatements } from './select';
import { ArgVal, CallTarget, Simulator, SimShared, WheneverState } from './interp';
import { Obj, UNKNOWN } from './memory';
import { PT, prepareTokens, SimParser } from './parser';
import { SimWorld } from './world';

export interface SimSetup {
  sim: Simulator;
  fnName: string;
  /** 실제로 실행할 문장 범위 (0-based 줄) */
  fromLine: number;
  toLine: number;
}

export interface SimOptions {
  /** 무시할 함수/매크로 이름. * ? 와일드카드 (예: "TRACE_*", "log_*") */
  ignore?: string[];
  /**
   * 로깅 함수/매크로 -> 출력 앞에 붙일 prefix ({fn} 함수 이름, {line} 줄 번호).
   * 이름 뒤에 ':N' 을 붙이면 N 번째 인자가 포맷 문자열 (없으면 자동으로 찾음). 예: { "log_write:4": "[LOG] " }
   */
  logFunctions?: Record<string, string>;
  /** 회사 타입 설정: 이름 -> C 타입 텍스트 (예: { "MONEY": "double", "int64": "long long" }) */
  types?: Record<string, string>;
  /** 다른 파일의 내용 (열려 있는 문서면 저장 안 된 내용). 없으면 디스크에서 읽음 */
  readSource?: (path: string) => string | undefined;
}

/** { "log_write:4": "[LOG] " } -> 이름별 로그 설정 */
export function logMatcher(map: Record<string, string>): (name: string) => LogConfig | undefined {
  const entries = Object.entries(map).map(([key, prefix]) => {
    const m = /^(.*?)(?::(\d+))?$/.exec(key.trim())!;
    return { match: nameMatcher([m[1]]), cfg: { prefix: String(prefix ?? ''), fmtIndex: m[2] ? Number(m[2]) : undefined } as LogConfig };
  });
  return (name) => entries.find((e) => e.match(name))?.cfg;
}

/** "TRACE_*" 같은 이름 패턴 목록 -> 판정 함수 */
export function nameMatcher(patterns: string[]): (name: string) => boolean {
  const res = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
  return (name) => res.some((r) => r.test(name));
}

interface ParsedFunction {
  body: Stmt[];
  toks: PT[];
  lineOf: (off: number) => number;
}

/** 함수 정의의 본문을 시뮬레이터용 문장 트리로 */
function parseFunctionBody(world: SimWorld, src: string, fn: Def): ParsedFunction {
  // 시뮬레이터는 #ifdef 분기 중 하나만 따라간다. 함수가 첫 분기 밖(#else 쪽)에 있으면 색인기와 같은 방식으로 다시 찾는다
  const raw = lex(src);
  let toks = prepareTokens(src, filterConditionals(raw, true));
  const findName = () => toks.findIndex((t) => t.k === Tk.Ident && t.line === fn.line && t.col === fn.col);
  let nameIdx = findName();
  if (nameIdx < 0) {
    toks = prepareTokens(src, filterConditionals(raw, false));
    nameIdx = findName();
  }
  if (nameIdx < 0) throw new Error(`함수 '${fn.name}' 의 위치를 찾지 못했습니다`);
  let open = -1;
  let depth = 0;
  for (let i = nameIdx + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== Tk.Punct) continue;
    if (t.v === '(') depth++;
    else if (t.v === ')') depth--;
    else if (t.v === '{' && depth <= 0) {
      // depth < 0: void (*get_handler(int))(int) { 처럼 이름이 괄호 안에 있는 경우
      open = i;
      break;
    }
  }
  if (open < 0) throw new Error(`함수 '${fn.name}' 의 본문을 찾지 못했습니다`);

  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const parser = new SimParser(toks, world, src, lineOf);
  parser.pos = open;
  return { body: parser.parseBlock().body, toks, lineOf };
}

/** 줄 beforeLine 이전에 (파일 순서상) 마지막으로 나온 WHENEVER 가 유효 */
function initialWhenever(world: SimWorld, src: string, f: ParsedFunction, beforeLine: number): WheneverState {
  const whenever: WheneverState = {};
  for (const t of f.toks) {
    if (t.k !== Tk.SqlStmt || f.lineOf(t.off) >= beforeLine) continue;
    if (!/^EXEC\s+SQL\s+WHENEVER\b/i.test(src.slice(t.off, t.end))) continue;
    const s = new SimParser(prepareTokens(src, [t]), world, src, f.lineOf).parseStmt();
    if (s.k === 'sql' && s.whenever) whenever[s.whenever.cond] = s.whenever.action;
  }
  return whenever;
}

/**
 * 파일 내용과 선택 범위로 시뮬레이터를 만든다.
 * @param endLine 선택 끝 줄. -1 이면 커서 문장부터 그 블록 끝까지.
 */
export function buildSimulator(index: SymbolIndex, filePath: string, src: string, startLine: number, endLine: number, opts: SimOptions = {}): SimSetup {
  const defs = parseSource(src).defs;
  const fnIdx = enclosingFunction(defs, startLine);
  if (fnIdx < 0) throw new Error('함수 본문 안에서 시작하세요 (커서/선택이 함수 밖에 있습니다)');
  const fn = defs[fnIdx];
  const ignore = nameMatcher(opts.ignore ?? []);
  const log = logMatcher(opts.logFunctions ?? {});
  const policy: Policy = { ignore, log, types: Object.entries(opts.types ?? {}) };
  const world = new SimWorld(index, filePath, defs, fnIdx, src);
  applyPolicy(world, policy);
  const parsed = parseFunctionBody(world, src, fn);

  // 커서만 있으면: 그 줄(빈 줄/주석이면 다음 문장)부터 함수 끝까지, 반복문 안이면 반복도 이어서
  // 범위를 선택했으면: 선택한 문장들만
  let sel = endLine < 0 ? continuationFrom(parsed.body, startLine) : selectStatements(parsed.body, startLine, endLine);
  // 함수 머리/여는 괄호 줄만 선택했으면 함수 본문 전체
  if (!sel.length && parsed.body.length && startLine <= parsed.body[0].line) sel = parsed.body;
  if (!sel.length) {
    throw new Error(
      endLine < 0
        ? '커서 아래에 실행할 문장이 없습니다'
        : '선택한 범위에 실행할 문장이 없습니다 (빈 줄/주석만 선택됨). 선택 없이 커서만 두면 그 아래 문장부터 함수 끝까지 실행합니다',
    );
  }

  const sim = new Simulator(world, sel, initialWhenever(world, src, parsed, sel[0].line), undefined, 0, [], parsed.body);
  const readSource = opts.readSource ?? (() => undefined);
  sim.shared.makeCallee = (caller, target, args) => makeCallee(caller, target, args, readSource, policy);
  return { sim, fnName: fn.name, fromLine: sel[0].line, toLine: sel[sel.length - 1].endLine };
}

/** 설정에서 온 함수/타입 정책 (시작 함수와 들어간 함수가 같이 씀) */
interface Policy {
  ignore: (name: string) => boolean;
  log: (name: string) => LogConfig | undefined;
  types: [string, string][];
}

function applyPolicy(world: SimWorld, p: Policy): void {
  world.ignore = p.ignore;
  world.logFunction = p.log;
  for (const [k, v] of p.types) world.typeAliases.set(k, v);
}

/** 호출된 함수의 프레임: 본문을 파싱하고 인자를 파라미터에 묶는다 */
function makeCallee(
  caller: Simulator,
  target: CallTarget,
  args: ArgVal[],
  readSource: (path: string) => string | undefined,
  policy: Policy,
): Simulator {
  const src =
    target.path === caller.world.filePath
      ? caller.world.src
      : (readSource(target.path) ?? decode(fs.readFileSync(target.path), DEFAULT_ENCODING));
  const defs = parseSource(src).defs;
  let fnIdx = defs.findIndex((d) => d.kind === 'function' && d.name === target.name && d.line === target.line);
  if (fnIdx < 0) fnIdx = defs.findIndex((d) => d.kind === 'function' && d.name === target.name);
  if (fnIdx < 0) throw new Error(`'${target.name}' 의 정의를 찾지 못했습니다`);
  const world = new SimWorld(caller.world.index, target.path, defs, fnIdx, src);
  applyPolicy(world, policy);
  const parsed = parseFunctionBody(world, src, defs[fnIdx]);

  const mem = caller.mem;
  const params: [string, Obj][] = [];
  defs
    .filter((d) => d.kind === 'param' && d.scope === fnIdx)
    .forEach((p, i) => {
      const info = world.varInfo(p.name, p.line);
      let t = info ? world.resolveSpec(info.spec) : ({ k: 'int', name: 'int', size: 4 } as const);
      if (t.k === 'array') t = { k: 'ptr', to: t.of }; // char buf[] 파라미터는 포인터
      const o = new Obj(t, p.name);
      const a = args[i];
      if (a) bindArg(caller, o, a);
      params.push([p.name, o]);
    });
  mem.commit();
  return new Simulator(world, parsed.body, initialWhenever(world, src, parsed, defs[fnIdx].line), caller.shared, caller.depth + 1, params, parsed.body);
}

/** 인자 -> 파라미터. 포인터는 같은 대상을 가리키고, 구조체 값 전달은 복사, 모르는 값은 ? 그대로 */
function bindArg(sim: Simulator, o: Obj, a: ArgVal): void {
  try {
    if (a.k === 'rv') {
      sim.store(o, a.rv);
      return;
    }
    const src = a.o;
    if (o.type.k === 'struct' && src.type.k === 'struct') {
      sim.mem.copyDeep(o, src);
      return;
    }
    if (src.v === UNKNOWN) return;
    if (o.type.k === 'ptr') {
      if (typeof src.v !== 'number' || src.v === 0) sim.mem.write(o, typeof src.v === 'number' ? null : src.v);
      return;
    }
    if (typeof src.v === 'number') sim.store(o, { k: 'num', v: src.v, float: src.type.k === 'float' });
  } catch {
    /* 타입이 맞지 않으면 ? 로 둔다 */
  }
}

// 재수출: 테스트/어댑터 편의
export { SimShared, continuationFrom, selectStatements };
