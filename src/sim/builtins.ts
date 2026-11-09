import { Expr } from './ast';
import type { RV, Simulator } from './interp';
import { AUTO_LEN, isCharType, NeedValue, Obj, SimExit, Unsupported, UNKNOWN } from './memory';

/**
 * 시뮬레이터가 직접 계산하는 C 라이브러리 함수.
 * 여기 없는 함수는 "시뮬레이션하지 않는 함수"로 취급해서 반환값을 사용자에게 묻는다.
 */

type Builtin = (sim: Simulator, args: Expr[]) => RV;

const num = (v: number, float = false): RV => ({ k: 'num', v, float });

function str(sim: Simulator, e: Expr): string {
  return sim.readCStr(sim.strRefOf(e));
}
function int(sim: Simulator, e: Expr): number {
  return Math.trunc(sim.toNum(sim.eval(e)));
}
function need(args: Expr[], n: number, name: string): void {
  if (args.length < n) throw new Unsupported(`${name}() 인자가 부족합니다`);
}

/** printf 계열 포맷. tolerant=true 면 모르는 값을 ? 로 표시 (출력 전용 함수) */
function format(sim: Simulator, fmt: string, args: Expr[], tolerant: boolean): string {
  let ai = 0;
  const nextArg = (): Expr => {
    const a = args[ai++];
    if (!a) throw new Unsupported('포맷 인자가 부족합니다');
    return a;
  };
  const guard = <T>(fn: () => T): T | string => {
    if (!tolerant) return fn();
    try {
      return fn();
    } catch (e) {
      if (e instanceof NeedValue || e instanceof Unsupported) return '?';
      throw e;
    }
  };
  return fmt.replace(/%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|z|j|t)?([diouxXeEfFgGcsp%])/g, (_all, flags: string, w: string, p: string, _len, conv: string) => {
    if (conv === '%') return '%';
    const width = w === '*' ? int(sim, nextArg()) : w ? Number(w) : 0;
    const prec = p === '*' ? int(sim, nextArg()) : p !== undefined ? Number(p) : undefined;
    const arg = nextArg();
    let body: string;
    switch (conv) {
      case 'd':
      case 'i':
      case 'u': {
        const v = guard(() => int(sim, arg));
        body = typeof v === 'number' ? String(v) : v;
        break;
      }
      case 'x':
      case 'X':
      case 'o': {
        const v = guard(() => int(sim, arg));
        body = typeof v === 'number' ? (v >>> 0).toString(conv === 'o' ? 8 : 16) : v;
        if (conv === 'X') body = body.toUpperCase();
        break;
      }
      case 'c': {
        const v = guard(() => int(sim, arg));
        body = typeof v === 'number' ? String.fromCharCode(v) : v;
        break;
      }
      case 's': {
        const v = guard(() => str(sim, arg));
        body = prec !== undefined ? v.slice(0, prec) : v;
        break;
      }
      case 'p':
        body = '0x?';
        break;
      default: {
        const v = guard(() => sim.toNum(sim.eval(arg)));
        if (typeof v !== 'number') body = v;
        else if (conv === 'e' || conv === 'E') body = v.toExponential(prec ?? 6);
        else if (conv === 'g' || conv === 'G') body = String(Number(v.toPrecision(prec || 6)));
        else body = v.toFixed(prec ?? 6);
      }
    }
    if (body.length < width) {
      if (flags.includes('-')) body = body.padEnd(width);
      else if (flags.includes('0') && conv !== 's' && conv !== 'c') {
        const neg = body.startsWith('-');
        body = (neg ? '-' : '') + body.slice(neg ? 1 : 0).padStart(width - (neg ? 1 : 0), '0');
      } else body = body.padStart(width);
    }
    return body;
  });
}

/** memset/memcpy 대상: 포인터가 가리키는 (배열, 시작 인덱스) 또는 단일 객체 */
function target(sim: Simulator, e: Expr): { arr?: Obj; idx: number; obj?: Obj } {
  const v = sim.eval(e);
  if (v.k !== 'ptr' || !v.p) throw new Unsupported('⚠ NULL 또는 포인터가 아닌 인자');
  const b = v.p.base;
  if (b.type.k === 'array') {
    const first = sim.mem.element(b, v.p.index);
    if (first.type.k === 'struct') return { obj: first, idx: 0 };
    return { arr: b, idx: v.p.index };
  }
  return { obj: b, idx: 0 };
}

function elemSize(sim: Simulator, arr: Obj): number {
  return arr.type.k === 'array' ? Math.max(1, sim.world.sizeOf(arr.type.of)) : 1;
}

const B: Record<string, Builtin> = {
  strcpy(sim, a) {
    need(a, 2, 'strcpy');
    const d = sim.strRefOf(a[0]);
    sim.writeCStr(d, str(sim, a[1]));
    return sim.eval(a[0]);
  },
  strncpy(sim, a) {
    need(a, 3, 'strncpy');
    const d = sim.strRefOf(a[0]);
    const n = int(sim, a[2]);
    const s = sim.readCStr(sim.strRefOf(a[1]), n);
    sim.writeCStr(d, s, false);
    const len = d.arr.type.k === 'array' ? d.arr.type.len : 0;
    for (let i = s.length; i < n; i++) {
      if (len > 0 && d.idx + i >= len) throw new Unsupported(`⚠ 버퍼 넘침: strncpy 가 '${d.arr.path}' (크기 ${len}) 에 ${n} 바이트를 씀`);
      sim.mem.write(sim.mem.element(d.arr, d.idx + i), 0);
    }
    return sim.eval(a[0]);
  },
  strcat(sim, a) {
    need(a, 2, 'strcat');
    const d = sim.strRefOf(a[0]);
    const cur = sim.readCStr(d);
    sim.writeCStr({ arr: d.arr, idx: d.idx + cur.length }, str(sim, a[1]));
    return sim.eval(a[0]);
  },
  strncat(sim, a) {
    need(a, 3, 'strncat');
    const d = sim.strRefOf(a[0]);
    const cur = sim.readCStr(d);
    const s = sim.readCStr(sim.strRefOf(a[1]), int(sim, a[2]));
    sim.writeCStr({ arr: d.arr, idx: d.idx + cur.length }, s);
    return sim.eval(a[0]);
  },
  strcmp(sim, a) {
    need(a, 2, 'strcmp');
    const x = str(sim, a[0]);
    const y = str(sim, a[1]);
    return num(x < y ? -1 : x > y ? 1 : 0);
  },
  strncmp(sim, a) {
    need(a, 3, 'strncmp');
    const n = int(sim, a[2]);
    const x = sim.readCStr(sim.strRefOf(a[0]), n);
    const y = sim.readCStr(sim.strRefOf(a[1]), n);
    return num(x < y ? -1 : x > y ? 1 : 0);
  },
  strlen(sim, a) {
    need(a, 1, 'strlen');
    return num(str(sim, a[0]).length);
  },
  strchr(sim, a) {
    need(a, 2, 'strchr');
    const r = sim.strRefOf(a[0]);
    const i = sim.readCStr(r).indexOf(String.fromCharCode(int(sim, a[1])));
    return { k: 'ptr', p: i < 0 ? null : { base: r.arr, index: r.idx + i } };
  },
  strrchr(sim, a) {
    need(a, 2, 'strrchr');
    const r = sim.strRefOf(a[0]);
    const i = sim.readCStr(r).lastIndexOf(String.fromCharCode(int(sim, a[1])));
    return { k: 'ptr', p: i < 0 ? null : { base: r.arr, index: r.idx + i } };
  },
  strstr(sim, a) {
    need(a, 2, 'strstr');
    const r = sim.strRefOf(a[0]);
    const i = sim.readCStr(r).indexOf(str(sim, a[1]));
    return { k: 'ptr', p: i < 0 ? null : { base: r.arr, index: r.idx + i } };
  },
  memset(sim, a) {
    need(a, 3, 'memset');
    const t = target(sim, a[0]);
    const c = int(sim, a[1]) & 0xff;
    const n = int(sim, a[2]);
    if (t.obj) {
      const size = sim.world.sizeOf(t.obj.type);
      if (n < size) throw new Unsupported(`구조체 '${t.obj.path}' 의 일부(${n}/${size}바이트)만 memset 하는 경우는 지원하지 않습니다`);
      if (c === 0) sim.mem.zeroDeep(t.obj);
      else fillChars(sim, t.obj, c);
    } else if (t.arr) {
      const es = elemSize(sim, t.arr);
      const len = t.arr.type.k === 'array' ? t.arr.type.len : 0;
      const count = Math.ceil(n / es);
      if (len > 0 && t.idx + count > len) throw new Unsupported(`⚠ 버퍼 넘침: memset 이 '${t.arr.path}' (크기 ${len * es}바이트) 에 ${n}바이트를 씀`);
      for (let i = 0; i < count; i++) {
        const el = sim.mem.element(t.arr, t.idx + i);
        if (c === 0) sim.mem.zeroDeep(el);
        else if (el.type.k === 'int' && el.type.size === 1) sim.mem.write(el, c);
        else fillChars(sim, el, c);
      }
    }
    return sim.eval(a[0]);
  },
  memcpy(sim, a) {
    need(a, 3, 'memcpy');
    const d = target(sim, a[0]);
    const s = target(sim, a[1]);
    const n = int(sim, a[2]);
    if (d.obj && s.obj) {
      requireKnown(sim, s.obj);
      sim.mem.copyDeep(d.obj, s.obj);
    } else if (d.arr && s.arr) {
      const es = elemSize(sim, d.arr);
      const count = Math.ceil(n / es);
      const dl = d.arr.type.k === 'array' ? d.arr.type.len : 0;
      const sl = s.arr.type.k === 'array' ? s.arr.type.len : 0;
      if (dl > 0 && d.idx + count > dl) throw new Unsupported(`⚠ 버퍼 넘침: memcpy 가 '${d.arr.path}' (크기 ${dl}) 에 ${count}개를 씀`);
      if (sl > 0 && s.idx + count > sl) throw new Unsupported(`⚠ 범위 밖 읽기: memcpy 가 '${s.arr.path}' (크기 ${sl}) 에서 ${count}개를 읽음`);
      // 모르는 원본 값이 있으면 묻는다 (문자 배열은 첫 '\0' 까지만 확인)
      if (s.arr.type.k === 'array' && isCharType(s.arr.type.of)) {
        for (let i = 0; i < count; i++) {
          const c = sim.mem.element(s.arr, s.idx + i).v;
          if (c === UNKNOWN) throw new NeedValue(s.arr, s.arr.origin ? `${s.arr.origin}, memcpy 원본` : 'memcpy 원본');
          if (c === 0) break;
        }
      } else for (let i = 0; i < count; i++) requireKnown(sim, sim.mem.element(s.arr, s.idx + i));
      for (let i = 0; i < count; i++) sim.mem.copyDeep(sim.mem.element(d.arr, d.idx + i), sim.mem.element(s.arr, s.idx + i));
    } else throw new Unsupported('memcpy: 배열과 구조체 사이 복사는 지원하지 않습니다');
    return sim.eval(a[0]);
  },
  memcmp(sim, a) {
    need(a, 3, 'memcmp');
    const n = int(sim, a[2]);
    const x = sim.strRefOf(a[0]);
    const y = sim.strRefOf(a[1]);
    for (let i = 0; i < n; i++) {
      const p = sim.load(sim.mem.element(x.arr, x.idx + i));
      const q = sim.load(sim.mem.element(y.arr, y.idx + i));
      const d = sim.toNum(p) - sim.toNum(q);
      if (d) return num(d < 0 ? -1 : 1);
    }
    return num(0);
  },
  sprintf(sim, a) {
    need(a, 2, 'sprintf');
    const s = format(sim, str(sim, a[1]), a.slice(2), false);
    sim.writeCStr(sim.strRefOf(a[0]), s);
    return num(s.length);
  },
  snprintf(sim, a) {
    need(a, 3, 'snprintf');
    const n = int(sim, a[1]);
    const s = format(sim, str(sim, a[2]), a.slice(3), false);
    if (n > 0) sim.writeCStr(sim.strRefOf(a[0]), s.slice(0, n - 1));
    return num(s.length);
  },
  printf(sim, a) {
    need(a, 1, 'printf');
    const s = format(sim, str(sim, a[0]), a.slice(1), true);
    sim.emit(`printf: ${s.replace(/\n$/, '')}`);
    return num(s.length);
  },
  fprintf(sim, a) {
    need(a, 2, 'fprintf');
    const s = format(sim, str(sim, a[1]), a.slice(2), true);
    sim.emit(`fprintf: ${s.replace(/\n$/, '')}`);
    return num(s.length);
  },
  puts(sim, a) {
    need(a, 1, 'puts');
    let s: string;
    try {
      s = str(sim, a[0]);
    } catch {
      s = '?';
    }
    sim.emit(`puts: ${s}`);
    return num(s.length + 1);
  },
  atoi: (sim, a) => num(parseInt(str(sim, a[0]).trim(), 10) || 0),
  atol: (sim, a) => num(parseInt(str(sim, a[0]).trim(), 10) || 0),
  atoll: (sim, a) => num(parseInt(str(sim, a[0]).trim(), 10) || 0),
  atof: (sim, a) => num(parseFloat(str(sim, a[0]).trim()) || 0, true),
  strtol: (sim, a) => num(parseInt(str(sim, a[0]).trim(), a[2] ? int(sim, a[2]) || 10 : 10) || 0),
  strtod: (sim, a) => num(parseFloat(str(sim, a[0]).trim()) || 0, true),
  abs: (sim, a) => num(Math.abs(int(sim, a[0]))),
  labs: (sim, a) => num(Math.abs(int(sim, a[0]))),
  fabs: (sim, a) => num(Math.abs(sim.toNum(sim.eval(a[0]))), true),
  toupper: (sim, a) => num(String.fromCharCode(int(sim, a[0])).toUpperCase().charCodeAt(0)),
  tolower: (sim, a) => num(String.fromCharCode(int(sim, a[0])).toLowerCase().charCodeAt(0)),
  isdigit: (sim, a) => num(+/[0-9]/.test(String.fromCharCode(int(sim, a[0])))),
  isalpha: (sim, a) => num(+/[A-Za-z]/.test(String.fromCharCode(int(sim, a[0])))),
  isalnum: (sim, a) => num(+/[A-Za-z0-9]/.test(String.fromCharCode(int(sim, a[0])))),
  isspace: (sim, a) => num(+/[ \t\n\r\f\v]/.test(String.fromCharCode(int(sim, a[0])))),
  isupper: (sim, a) => num(+/[A-Z]/.test(String.fromCharCode(int(sim, a[0])))),
  islower: (sim, a) => num(+/[a-z]/.test(String.fromCharCode(int(sim, a[0])))),
  exit(sim, a) {
    const code = a[0] ? int(sim, a[0]) : 0;
    throw new SimExit(`exit(${code}) — 시뮬레이션 종료`);
  },
};
B.memmove = B.memcpy;

/**
 * 복사할 원본에 모르는 값이 있으면 NeedValue (memcpy 용).
 * 문자 배열은 첫 '\0' 까지만 확인 (뒤쪽 쓰레기 영역은 묻지 않음), 포인터는 값 자체만.
 */
function requireKnown(sim: Simulator, o: Obj, depth = 0): void {
  if (depth > 8) return;
  const t = o.type;
  if (t.k === 'struct') {
    for (const f of sim.mem.allFields(o)) requireKnown(sim, f, depth + 1);
  } else if (t.k === 'array') {
    const n = t.len === AUTO_LEN ? (o.elems?.length ?? 0) : t.len;
    if (isCharType(t.of)) {
      for (let i = 0; i < n; i++) {
        const c = sim.mem.element(o, i).v;
        if (c === UNKNOWN) throw new NeedValue(o, o.origin ? `${o.origin}, memcpy 원본` : 'memcpy 원본');
        if (c === 0) return;
      }
    } else for (let i = 0; i < Math.min(n, 4096); i++) requireKnown(sim, sim.mem.element(o, i), depth + 1);
  } else if (o.v === UNKNOWN) {
    throw new NeedValue(o, o.origin ? `${o.origin}, memcpy 원본` : 'memcpy 원본');
  }
}

/** 구조체/배열의 문자 칸은 c 로, 그 외 칸은 모르는 값으로 (memset 0 이 아닌 경우) */
function fillChars(sim: Simulator, o: Obj, c: number): void {
  if (o.type.k === 'array') {
    const n = Math.min(o.type.len, 65536);
    for (let i = 0; i < n; i++) fillChars(sim, sim.mem.element(o, i), c);
  } else if (o.type.k === 'struct') {
    for (const f of sim.mem.allFields(o)) fillChars(sim, f, c);
  } else if (isCharType(o.type)) sim.mem.write(o, c);
  else sim.mem.write(o, UNKNOWN);
}

/** 회사 로깅 함수 설정: 출력 앞에 붙일 prefix, 포맷 문자열 인자 위치(1부터, 없으면 자동) */
export interface LogConfig {
  prefix: string;
  fmtIndex?: number;
}

/** 모르는 값은 ? 로: 로그 출력용 인자 하나의 텍스트 */
function looseText(sim: Simulator, e: Expr): string {
  try {
    const v = sim.eval(e);
    if (v.k === 'num') return String(v.v);
    if (v.k === 'ptr' && v.p && v.p.base.type.k === 'array' && isCharType(v.p.base.type.of)) return sim.readCStr({ arr: v.p.base, idx: v.p.index });
    return v.k === 'ptr' && !v.p ? 'NULL' : '?';
  } catch (err) {
    if (err instanceof NeedValue || err instanceof Unsupported) return '?';
    throw err;
  }
}

/**
 * 등록된 로깅 함수: printf 처럼 포맷해서 디버그 콘솔에 prefix 와 함께 출력. 묻지 않고 0 반환.
 * 포맷 문자열은 지정한 위치, 없으면 첫 문자열 리터럴(또는 % 가 든 첫 문자열 인자).
 */
export function callLog(sim: Simulator, fn: string, args: Expr[], cfg: LogConfig): RV {
  // 자동: '%' 가 든 첫 문자열 (리터럴 우선). __FILE__ 같은 앞쪽 문자열 인자는 포맷이 아님. 없으면 인자를 이어서 출력
  let fi = cfg.fmtIndex !== undefined ? cfg.fmtIndex - 1 : args.findIndex((a) => a.k === 'str' && a.v.includes('%'));
  if (fi < 0 && cfg.fmtIndex === undefined) fi = args.findIndex((a) => a.k !== 'str' && /%/.test(looseText(sim, a)));
  let msg: string;
  if (fi >= 0 && fi < args.length) {
    const fmt = looseText(sim, args[fi]);
    msg = fmt === '?' ? '?' : format(sim, fmt, args.slice(fi + 1), true);
  } else {
    msg = args.map((a) => looseText(sim, a)).join(' ');
  }
  const prefix = cfg.prefix.replace(/\{fn\}/g, fn).replace(/\{line\}/g, String(sim.line + 1));
  for (const l of msg.replace(/\n+$/, '').split('\n')) sim.emit(prefix + l);
  return num(0);
}

export function hasBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(B, name);
}

export function callBuiltin(sim: Simulator, name: string, args: Expr[]): RV {
  return B[name](sim, args);
}
