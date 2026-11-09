import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { lex } from '../core/lexer';
import { DEFAULT_ENCODING, indexFile } from '../core/fileIndexer';
import { SymbolIndex } from '../core/symbolIndex';
import { formatObj, ReturnAnswer, Simulator } from '../sim/interp';
import { prepareTokens, SimParser } from '../sim/parser';
import { buildSimulator, nameMatcher } from '../sim/session';
import { applyValues, collectValues, listSnapshots, saveSnapshot } from '../sim/snapshot';
import * as os from 'os';

const FIX = path.resolve(__dirname, '../../test-fixtures');
const index = new SymbolIndex();
for (const f of ['src/emp.pc', 'src/legacy.c', 'include/common.h', 'include/types.h', 'include/macros.h', 'include/utils.h']) {
  index.setFile(indexFile(path.join(FIX, f), DEFAULT_ENCODING, 1 << 30));
}

interface Script {
  values?: Record<string, string | string[]>;
  returns?: Record<string, number | 'void' | 'always' | ReturnAnswer>;
  sqlcodes?: number[];
  conds?: boolean[];
  skip?: boolean;
  /** 이 줄(1-based)의 문장 앞에서 멈췄을 때 건너뛰기 */
  skipLines?: number[];
  /** 이 변수 값을 물으면 값 대신 건너뛰기 */
  skipNeeds?: string[];
  /** 반환값을 물으면 그 함수 안으로 들어가기 */
  enter?: string[];
  /** 이 줄 앞에서 F11 (다음 사용자 함수 호출로 들어가기) */
  stepInLines?: number[];
  /** 이 줄(1-based) 앞에서 멈췄을 때 그 값의 줄로 커서까지 건너뛰기 (한 번) */
  jumps?: Record<number, number>;
}

/** 시뮬레이터를 끝까지 돌린다. 멈출 때마다 스크립트의 값으로 답한다 */
function drive(sim: Simulator, script: Script = {}) {
  const gen = sim.run();
  const lines: number[] = [];
  const rets: string[] = [];
  const deep: string[] = [];
  const needs: string[] = [];
  const asks: string[] = [];
  const unsupported: string[] = [];
  const out: string[] = [];
  const sql = [...(script.sqlcodes ?? [])];
  const values: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(script.values ?? {})) values[k] = Array.isArray(v) ? [...v] : [v];
  for (let n = 0; n < 20000; n++) {
    const r = gen.next();
    out.push(...sim.takeOutput());
    if (r.done) return { lines, rets, deep, needs, asks, unsupported, out, end: r.value };
    const ev = r.value;
    if (ev.k === 'step') {
      lines.push(ev.line + 1);
      if (script.skipLines?.includes(ev.line + 1)) sim.requestSkip();
      if (script.stepInLines?.includes(ev.line + 1)) sim.armStepIn();
      const jt = script.jumps?.[ev.line + 1];
      if (jt !== undefined) {
        delete script.jumps![ev.line + 1];
        sim.requestJump(jt - 1);
      }
      if (ev.depth > 0) deep.push(`${ev.depth}:${ev.line + 1}`);
    } else if (ev.k === 'need' && script.skipNeeds?.includes(ev.obj.path)) {
      needs.push(ev.obj.path);
      sim.requestSkip();
    } else if (ev.k === 'need') {
      needs.push(ev.obj.path);
      const q = values[ev.obj.path];
      if (!q || !q.length) throw new Error(`예상 못한 값 요청 '${ev.obj.path}' (줄 ${ev.line + 1}): ${ev.msg}`);
      sim.setUserValue(ev.obj, q.length > 1 ? q.shift()! : q[0]);
    } else if (ev.k === 'ask') {
      const q = ev.q;
      if (q.kind === 'sqlcode') {
        asks.push(`sql:${q.verb}`);
        if (!sql.length) throw new Error(`예상 못한 SQL 결과 질문: ${q.sql}`);
        sim.provideSqlcode(sql.shift()!);
      } else if (q.kind === 'return' && script.enter?.includes(q.fn)) {
        asks.push(`enter:${q.fn}`);
        assert.ok(q.canEnter, `${q.fn} 는 들어갈 수 있어야 함`);
        sim.requestEnter(q.id);
      } else if (q.kind === 'return') {
        asks.push(`ret:${q.fn}`);
        const v = script.returns?.[q.fn];
        if (v === undefined) throw new Error(`예상 못한 반환값 질문: ${q.call}`);
        if (v === 'always') sim.ignoredFns.add(q.fn);
        rets.push(`${q.fn}:${q.ret}`);
        sim.provideReturn(q.id, typeof v === 'object' ? v : typeof v === 'number' ? { value: v, havoc: true } : { value: 0, havoc: false });
      } else {
        asks.push(`cond:${q.text}`);
        sim.provideCond(q.id, script.conds!.shift()!);
      }
    } else {
      unsupported.push(ev.msg);
      if (!script.skip) throw new Error(`지원 안 됨 (줄 ${ev.line + 1}): ${ev.msg}`);
      sim.requestSkip();
    }
  }
  throw new Error('끝나지 않음');
}

/** 시뮬레이터 상태에서 식 값 보기 */
function val(sim: Simulator, expr: string): string {
  const parser = new SimParser(prepareTokens(expr, lex(expr)), sim.world);
  const e = parser.parseExpr();
  if (e.k === 'ident' || e.k === 'member' || e.k === 'index') return formatObj(sim.lvalue(e));
  const v = sim.eval(e);
  return v.k === 'num' ? String(v.v) : JSON.stringify(v);
}

const empPc = fs.readFileSync(path.join(FIX, 'src/emp.pc'), 'utf8');
const empPath = path.join(FIX, 'src/emp.pc');

test('시뮬레이션: UPDATE + 바인드된 SQL 출력 + SQL_OK 매크로', () => {
  // raise_sal 본문 (73~79행)
  const { sim, fnName } = buildSimulator(index, empPath, empPc, 72, 78);
  assert.strictEqual(fnName, 'raise_sal');
  sim.setUserValue(sim.lookup('pct')!, '10');
  const r = drive(sim, { sqlcodes: [0] });
  assert.match(r.out[0], /UPDATE emp SET sal = sal \* \(1 \+ 10 \/ 100\) WHERE empno = :empno\(\?\)/);
  assert.match(r.out[1], /COMMIT WORK/);
  assert.deepStrictEqual(r.lines, [73, 75, 79]);
  assert.strictEqual(r.end, '블록 끝');
});

test('시뮬레이션: SQL 오류 가정 -> WHENEVER SQLERROR DO (파일상 앞의 WHENEVER 가 유효) + 모르는 함수', () => {
  const { sim } = buildSimulator(index, empPath, empPc, 72, 79);
  const r = drive(sim, { sqlcodes: [-1], returns: { sql_error: 'void' } });
  assert.ok(r.out.some((l) => /WHENEVER: DO sql_error\(\)/.test(l)), r.out.join('\n'));
  assert.deepStrictEqual(r.asks, ['sql:UPDATE', 'ret:sql_error']);
  assert.match(r.end, /return -1/);
});

test('시뮬레이션: FETCH 루프, 호스트 변수는 FETCH 뒤 모르는 값, NOT FOUND -> GOTO done 으로 종료', () => {
  // load_emps 의 for (;;) { ... } (43~54행)
  const { sim } = buildSimulator(index, empPath, empPc, 42, 53);
  const r = drive(sim, {
    sqlcodes: [0, 1403],
    values: { n: '0', h_empno: '7369', 'h_ename.len': '5', 'h_ename.arr': '"SMITH"', h_sal: '800', g_debug: '0' },
    returns: { 'rec->on_change': 'void' },
  });
  assert.deepStrictEqual(r.needs, ['n', 'h_empno', 'h_ename.len', 'h_ename.arr', 'h_sal', 'g_debug'], 'memcpy 원본(h_ename.arr)도 물음');
  assert.strictEqual(val(sim, 'rec->ename'), '"SMITH"');
  assert.match(r.end, /블록 밖 레이블 'done'/);
  assert.strictEqual(val(sim, 'n'), '1');
  assert.strictEqual(val(sim, 'rec->empno'), '7369');
  assert.strictEqual(val(sim, 'rec->sal'), '800');
  assert.strictEqual(val(sim, 'list->items[0].empno'), '7369');
  assert.strictEqual(val(sim, 'rec->dept'), '→ dept');
  assert.ok(r.out[0].startsWith('SQL> EXEC SQL FETCH emp_cur INTO :h_empno'));
});

test('시뮬레이션: C 연산/문자열/switch/구조체/버퍼 넘침 감지', () => {
  const src = `#include "common.h"
int calc(int a)
{
    char buf[8];
    char name[MAX_NAME + 1];
    int i, total = 0;
    int arr[5] = {1, 2, 3};
    EmpRec rec;
    memset(&rec, 0, sizeof(rec));
    strcpy(name, "SCOTT");
    strcat(name, "_X");
    sprintf(buf, "%03d", 7);
    for (i = 0; i < 5; i++) {
        if (arr[i] == 0) continue;
        total += arr[i] * 2;
    }
    switch (total) {
    case 12: total = 100;
    case 13: total += 1; break;
    default: total = -1;
    }
    rec.empno = (int)(7 / 2) + LOG_LEVEL_ERR;
    rec.sal = 10 / 4.0;
    a = strlen(name) > 5 ? 1 : 0;
    strcpy(buf, "TOO-LONG-STRING");
    return total;
}
`;
  const { sim } = buildSimulator(index, path.join(FIX, 'src/t.c'), src, 3, 25);
  const r = drive(sim, { skip: true });
  assert.strictEqual(val(sim, 'name'), '"SCOTT_X"');
  assert.strictEqual(val(sim, 'buf'), '"007"');
  assert.strictEqual(val(sim, 'i'), '5');
  assert.strictEqual(val(sim, 'rec.empno'), '13');
  assert.strictEqual(val(sim, 'rec.sal'), '2.5');
  assert.strictEqual(val(sim, 'rec.ename'), '""');
  assert.strictEqual(val(sim, 'a'), '1');
  assert.strictEqual(r.unsupported.length, 1);
  assert.match(r.unsupported[0], /버퍼 넘침: 'buf' 크기 8/);
  assert.match(r.end, /return 101/);
});

test('시뮬레이션: 모르는 값이면 멈추고, 넣은 값으로 분기', () => {
  const src = `int f(int a, char *s)
{
    int r = 0;
    if (a > 0)
        r = 1;
    else
        r = 2;
    if (strcmp(s, "Y") == 0) r += 10;
    return r;
}
`;
  const s1 = buildSimulator(index, path.join(FIX, 'src/t2.c'), src, 2, 8).sim;
  const r1 = drive(s1, { values: { a: '-3', s: '"Y"' } });
  assert.deepStrictEqual(r1.needs, ['a', 's']);
  assert.match(r1.end, /return 12/);
  assert.deepStrictEqual(r1.lines, [3, 4, 7, 8, 8, 9]); // 8행: if 와 그 안의 r += 10
});

test('시뮬레이션: 25줄 넘는 매크로, 멤버 이름과 같은 매크로, 빈 매크로, 닫히지 않은 함수', () => {
  const src = `#include "macros.h"
int g(int a, struct counter *c)
{
    int r = 0;
    CHECK_ERR(a);
    r = c->count;
    if (a) {
        r += 1;
        EMPTY_TRACE
    }
    return r;
}
`;
  // 이전에는 매크로가 25줄에서 잘려 "'}' 가 필요한 곳에 '끝'" 오류
  const { sim } = buildSimulator(index, path.join(FIX, 'src/m.c'), src, 3, 10);
  const r = drive(sim, { values: { a: '1', err_count: '0', 'c->count': '7' }, returns: { trace_line: 'always' } });
  assert.deepStrictEqual(r.asks, ['ret:trace_line'], '항상 무시를 고르면 30번 묻지 않음');
  assert.deepStrictEqual(r.needs, ['a', 'err_count', 'c->count']);
  assert.strictEqual(val(sim, 'err_count'), '1');
  assert.match(r.end, /return 8/);

  // 편집 중이라 함수가 닫히지 않은 경우에도 읽은 데까지 실행
  const open = src.slice(0, src.lastIndexOf('}'));
  const s2 = buildSimulator(index, path.join(FIX, 'src/m.c'), open, 3, 4).sim;
  assert.match(drive(s2, { values: { a: '0' }, returns: { trace_line: 'always' } }).end, /블록 끝/);
});

const skipSrc = `#include "macros.h"
int h(int a)
{
    int r = 0;
    PRINT_STRUCT(r);
    if (a > 0) {
        r = 100;
        log_msg("big");
    }
    for (r = 0; r < 3; r++)
        trace_line(r);
    r += 5;
    return r;
}
`;

test('시뮬레이션: 문장 건너뛰기 (if 블록 통째로, 값 대신 건너뛰기)', () => {
  // 6행 if 앞에서 건너뛰기 -> a 를 묻지 않고 블록 전체를 넘어감
  const s1 = buildSimulator(index, path.join(FIX, 'src/k.c'), skipSrc, 3, 13).sim;
  const r1 = drive(s1, { skipLines: [6], returns: { print_struct: 'void', trace_line: 'always' } });
  assert.deepStrictEqual(r1.needs, []);
  assert.ok(r1.out.includes('  ⤼ 6행 건너뜀'), r1.out.join('\n'));
  assert.ok(!r1.asks.includes('ret:log_msg'));
  assert.match(r1.end, /return 8/);

  // a 값을 물을 때 값 대신 건너뛰기 -> 그 if 문 전체를 건너뜀
  const s2 = buildSimulator(index, path.join(FIX, 'src/k.c'), skipSrc, 3, 13).sim;
  const r2 = drive(s2, { skipNeeds: ['a'], returns: { print_struct: 'void', trace_line: 'always' } });
  assert.deepStrictEqual(r2.needs, ['a']);
  assert.deepStrictEqual(r2.asks, ['ret:print_struct', 'ret:trace_line']);
  assert.match(r2.end, /return 8/);

  // for 문 앞에서 건너뛰기 -> 반복문 전체를 넘어감 (r 은 0 그대로)
  const s3 = buildSimulator(index, path.join(FIX, 'src/k.c'), skipSrc, 3, 13).sim;
  const r3 = drive(s3, { skipLines: [6, 10], returns: { print_struct: 'void' } });
  assert.match(r3.end, /return 5/);
});

test('시뮬레이션: 무시 목록 (매크로 문장 / 함수 호출)', () => {
  const m = nameMatcher(['PRINT_*', 'trace_?ine', 'log_msg']);
  assert.ok(m('PRINT_STRUCT') && m('trace_line') && m('log_msg') && !m('print_struct') && !m('trace_lines'));
  const { sim } = buildSimulator(index, path.join(FIX, 'src/k.c'), skipSrc, 3, 13, { ignore: ['PRINT_*', 'trace_*', 'log_msg'] });
  const r = drive(sim, { values: { a: '1' } });
  assert.deepStrictEqual(r.asks, [], 'PRINT_STRUCT 매크로, trace_line/log_msg 함수 모두 묻지 않음');
  assert.deepStrictEqual(r.lines, [4, 6, 7, 8, 10, 11, 10, 11, 10, 11, 10, 12, 13], '무시한 매크로 문장(5행)은 실행 줄에도 없음');
  assert.match(r.end, /return 8/);
});

const callsPath = path.join(FIX, 'src/calls.c');
const callsSrc = fs.readFileSync(callsPath, 'utf8');
index.setFile(indexFile(callsPath, DEFAULT_ENCODING, 1 << 30));

test('함수 안으로 들어가기: 포인터로 넘긴 구조체가 이어지고 return 값이 돌아옴', () => {
  // flow() 본문 전체 (19~26행)
  const { sim } = buildSimulator(index, callsPath, callsSrc, 18, 25);
  const r = drive(sim, { enter: ['fill', 'bonus'], values: { g_debug: '0' } });
  assert.deepStrictEqual(r.asks, ['enter:fill', 'enter:bonus']);
  assert.deepStrictEqual(r.needs, ['g_debug'], '전역 변수는 호출된 함수에서 한 번 넣으면 호출한 쪽에서도 같은 값');
  assert.deepStrictEqual(r.deep, ['1:4', '1:5', '1:6', '1:7', '1:9', '1:13', '1:14', '1:15']);
  assert.strictEqual(val(sim, 'rec.empno'), '100');
  assert.strictEqual(val(sim, 'rec.ename'), '"SCOTT"');
  assert.strictEqual(val(sim, 'rec.sal'), '250', '값으로 넘긴 구조체(bonus)는 복사본이라 원본 그대로');
  assert.strictEqual(val(sim, 'next'), '101');
  assert.strictEqual(val(sim, 'b'), '25');
  assert.ok(r.out.includes('→ fill(&rec, 100) 진입') && r.out.includes('← fill() = 101'), r.out.join('\n'));
  assert.match(r.end, /return 126/);
});

test('함수 안으로 들어가기: F11 은 묻지 않고 들어감, 모르는 포인터도 같은 대상 공유', () => {
  const { sim } = buildSimulator(index, callsPath, callsSrc, 18, 25);
  const r = drive(sim, { stepInLines: [22], values: { g_debug: '0' }, returns: { bonus: 7 } });
  assert.deepStrictEqual(r.asks, ['ret:bonus'], 'fill 은 F11 로 바로 들어감');
  assert.match(r.end, /return 108/);

  // outer(EmpList *list): list 를 모르는 채로 put(list, 3) 에 들어가면 같은 대상을 본다
  const o = buildSimulator(index, callsPath, callsSrc, 33, 34).sim;
  const r2 = drive(o, { enter: ['put'] });
  assert.deepStrictEqual(r2.needs, [], 'list->count 는 put 안에서 정해졌으므로 묻지 않음');
  assert.match(r2.end, /return 3/);
});

test('함수 중간에서 시작: 커서가 반복문 몸체 안이면 반복을 이어가고 함수 끝까지', () => {
  // load_emps 의 46행 (for (;;) 몸체 중간) 에 커서만
  const { sim, toLine } = buildSimulator(index, empPath, empPc, 45, -1);
  assert.strictEqual(toLine + 1, 68, '함수 끝(return n)까지');
  const r = drive(sim, {
    sqlcodes: [1403, 0],
    values: { h_empno: '7369', 'h_ename.len': '4', 'h_ename.arr': '"KING"', h_sal: '800', g_debug: '0', n: '1' },
    returns: { 'rec->on_change': 'void' },
  });
  // 몸체 나머지(46~52) -> 반복 계속(43 for, 44 FETCH) -> NOT FOUND -> GOTO done -> 56 CLOSE ... 68 return
  assert.deepStrictEqual(r.lines, [46, 47, 48, 49, 50, 51, 52, 43, 44, 56, 57, 59, 68]);
  assert.deepStrictEqual(r.asks, ['ret:rec->on_change', 'sql:FETCH', 'sql:EXECUTE']);
  assert.match(r.end, /return 1/);
});

test('함수 중간에서 시작: 빈 줄/주석에 커서면 다음 문장부터, 반복문 안 break/continue', () => {
  const s1 = buildSimulator(index, empPath, empPc, 39, -1); // 40행은 빈 줄
  assert.strictEqual(s1.fromLine + 1, 41);
  const src = `int f(int n)
{
    int i, s = 0;
    for (i = 0; i < n; i++) {
        if (i == 1)
            continue;
        s += i;
        if (s > 5)
            break;
    }
    return s * 100 + i;
}
`;
  // 7행(s += i) 에 커서: i 는 모름 -> 입력, 그다음 반복은 i++ 부터 이어짐
  const { sim } = buildSimulator(index, path.join(FIX, 'src/loop.c'), src, 6, -1);
  const r = drive(sim, { values: { i: '2', s: '0', n: '10' } });
  // i=2: s=2 / i=3: s=5 / i=4: s=9 > 5 -> break
  assert.match(r.end, /return 904/);
});

test('선택이 함수 머리/여는 괄호 줄뿐이면 함수 본문 전체', () => {
  // raise_sal 의 '{' 줄(72행)만 선택
  const s = buildSimulator(index, empPath, empPc, 71, 71);
  assert.strictEqual(s.fnName, 'raise_sal');
  assert.strictEqual(s.fromLine + 1, 73);
  assert.strictEqual(s.toLine + 1, 80);
});

test('커서까지 건너뛰기: 사이 코드는 실행하지 않고 값은 유지, 반복문 안으로도', () => {
  const src = `int j(int a)
{
    int x = 1;
    int y = 2;
    x = x + 10;
    y = y + 20;
    if (a > 0)
        x = 100;
    return x * 1000 + y;
}
int k(int n)
{
    int i, s = 0;
    for (i = 0; i < n; i++) {
        s += i;
        s += 100;
    }
    return s;
}
`;
  const file = path.join(FIX, 'src/jump.c');
  // 4행 앞에서 6행으로: y 선언(4)과 x = x + 10(5)은 실행 안 함, x = 1 은 유지
  const s1 = buildSimulator(index, file, src, 2, -1).sim;
  const r1 = drive(s1, { jumps: { 4: 6 }, values: { y: '5', a: '0' } });
  assert.deepStrictEqual(r1.lines, [3, 4, 6, 7, 9]);
  assert.ok(r1.out.includes('  ⤼ 4행에서 6행으로 건너뜀'), r1.out.join('\n'));
  assert.deepStrictEqual(r1.needs, ['y', 'a']);
  assert.match(r1.end, /return 1025/);

  // 반복문 몸체 안(16행)으로: 몸체 나머지 후 i++ 부터 반복 이어짐
  const s2 = buildSimulator(index, file, src, 12, -1).sim;
  const r2 = drive(s2, { jumps: { 13: 16 }, values: { s: '0', i: '0', n: '3' } });
  assert.deepStrictEqual(r2.lines.slice(0, 4), [13, 16, 14, 15]);
  assert.match(r2.end, /return 303/);

  // 지금 함수 밖으로는 이동 불가
  const s3 = buildSimulator(index, file, src, 2, -1).sim;
  s3.run().next();
  assert.throws(() => s3.requestJump(15), /j\(\) 안에서만/);
});

test('커서까지 건너뛰기: 들어간 함수 안에서', () => {
  const { sim } = buildSimulator(index, callsPath, callsSrc, 18, 25);
  // fill 안 5행(strcpy) 앞에서 9행(return)으로: ename/sal 은 memset 0 그대로
  const r = drive(sim, { enter: ['fill', 'bonus'], jumps: { 5: 9 }, values: { g_debug: '0' } });
  assert.strictEqual(val(sim, 'rec.empno'), '100');
  assert.strictEqual(val(sim, 'rec.ename'), '""');
  assert.strictEqual(val(sim, 'b'), '0');
  assert.match(r.end, /return 101/);
});

test('로깅 함수: printf 처럼 포맷해서 prefix 와 함께 출력, 묻지 않고 모르는 값은 ?', () => {
  const src = `#include "common.h"
int t(int a)
{
    char name[10];
    strcpy(name, "KIM");
    log_write(LOG_LEVEL_DBG, __FILE__, __LINE__, "name=%s a=%d", name, a);
    LOG_ERR("err %s/%05.1f", name, 3.14159);
    trace(1, 2, "x=%d", 5);
    plain_log("no", "format");
    return 0;
}
`;
  const logFunctions = { log_write: '[{fn}:{line}] ', LOG_ERR: '[ERR] ', 'trace:3': '', 'plain_*': '> ' };
  const { sim } = buildSimulator(index, path.join(FIX, 'src/log.c'), src, 3, 9, { logFunctions });
  const r = drive(sim);
  assert.deepStrictEqual(r.asks, [], '로깅 함수는 반환값을 묻지 않음');
  assert.deepStrictEqual(r.needs, [], 'a 를 몰라도 멈추지 않음');
  assert.deepStrictEqual(
    r.out.filter((l) => !l.startsWith('SQL')),
    ['[log_write:6] name=KIM a=?', '[ERR] err KIM/003.1', 'x=5', '> no format'],
  );
  assert.match(r.end, /return 0/);
});

test('로깅 함수: Pro*C 파일의 LOG_ERR 매크로 (모르는 msg/sqlca 메시지는 ?)', () => {
  // sql_error() 본문 (20~23행)
  const { sim } = buildSimulator(index, empPath, empPc, 19, 22, { logFunctions: { LOG_ERR: '[ERR {fn}] ' } });
  const r = drive(sim, { sqlcodes: [0] });
  assert.ok(r.out.includes('[ERR LOG_ERR] sql error ?: ?'), r.out.join('\n'));
});

const retPath = path.join(FIX, 'src/rettype.c');
const retSrc = fs.readFileSync(retPath, 'utf8');

test('반환 타입: char* 는 문자열, 구조체 포인터는 새 대상, 정의 모르는 타입(int64/MONEY)은 자르지 않음', () => {
  const { sim } = buildSimulator(index, retPath, retSrc, 8, 16);
  const r = drive(sim, {
    returns: {
      get_msg: { value: 0, as: 'str', str: '"정상 처리"', havoc: false },
      find_emp: { value: 0, as: 'new', havoc: false },
      get_amount: 3000000000,
      get_money: 10.5,
    },
  });
  assert.deepStrictEqual(r.rets, ['get_msg:str', 'find_emp:ptr', 'get_amount:num', 'get_money:num']);
  assert.strictEqual(val(sim, 'buf'), '"정상 처리"');
  assert.strictEqual(val(sim, 'e->sal'), '10');
  assert.strictEqual(val(sim, 'e->empno'), '?', '새 대상의 다른 멤버는 모르는 값');
  assert.strictEqual(val(sim, 'amt'), '3000000001', '32비트로 잘리지 않음');
  assert.strictEqual(val(sim, 'won'), '5.25', '정수로 잘리지 않음');
  assert.match(r.end, /return 5/);
});

test('반환 타입: char* 를 나중에(쓰일 때) 묻기, 무시한 포인터 함수는 NULL 이 아님, 회사 타입 설정', () => {
  const s1 = buildSimulator(index, retPath, retSrc, 8, 9).sim; // m = get_msg(100); strcpy(buf, m);
  const r1 = drive(s1, {
    returns: { get_msg: { value: 0, as: 'unknown', havoc: false } },
    values: { 'get_msg()': '"ABC"' },
  });
  assert.deepStrictEqual(r1.needs, ['get_msg()'], 'strcpy 에서 그 문자열을 물음');
  assert.strictEqual(val(s1, 'buf'), '"ABC"');

  const s2 = buildSimulator(index, retPath, retSrc, 10, 11, { ignore: ['find_emp'] }).sim;
  const r2 = drive(s2);
  assert.deepStrictEqual(r2.unsupported, [], 'e->sal = 10 이 NULL 역참조로 멈추지 않음');

  // MONEY 를 long 으로 지정하면 정수 나눗셈
  const s3 = buildSimulator(index, retPath, retSrc, 14, 15, { types: { MONEY: 'long' } }).sim;
  drive(s3, { returns: { get_money: 11 } });
  assert.strictEqual(val(s3, 'won'), '5');
});

const snapSrc = `#include "common.h"
int g(EmpRec *in, int a, char *s)
{
    VARCHAR v[10];
    int r = -1;
    if (a > 0 && in->sal > 100 && strcmp(s, "Y") == 0)
        r = in->empno;
    return r;
}
`;

test('변수값 스냅샷: 모은 값을 새 시뮬레이션에 덮어쓰면 다시 묻지 않음 (포인터 대상, char*, VARCHAR)', () => {
  const file = path.join(FIX, 'src/snap.c');
  const s1 = buildSimulator(index, file, snapSrc, 3, 7).sim;
  const r1 = drive(s1, { values: { a: '5', 'in->sal': '200', s: '"Y"', 'in->empno': '7' } });
  assert.match(r1.end, /return 7/);
  s1.setUserValue(s1.lookup('v')!, '"KIM"');
  const values = collectValues(s1);
  assert.strictEqual(values.a, '5');
  assert.strictEqual(values['in[0].sal'], '200');
  assert.strictEqual(values['in[0].empno'], '7');
  assert.strictEqual(values.s, '"Y"');
  assert.strictEqual(values.v, '"KIM"');
  assert.ok(!('in' in values), '포인터 값 자체는 저장하지 않음');

  const s2 = buildSimulator(index, file, snapSrc, 3, 7).sim;
  const res = applyValues(s2, { ...values, nosuch: '1' });
  assert.deepStrictEqual(res.failed.map((f) => f.path), ['nosuch']);
  const r2 = drive(s2);
  assert.deepStrictEqual(r2.needs, [], '스냅샷 값으로 바로 진행');
  assert.match(r2.end, /return 7/);
  assert.strictEqual(val(s2, 'v.len'), '3');
});

test('변수값 스냅샷: 파일 저장/목록 (함수별 폴더, 이름의 특수문자)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-snap-'));
  saveSnapshot(dir, { name: '정상/1건', function: 'g', saved: '2026-10-23', values: { a: '5' } });
  saveSnapshot(dir, { name: '데이터 없음', function: 'load_emps', saved: '2026-10-23', values: { n: '0' } });
  const list = listSnapshots(dir);
  assert.deepStrictEqual(list.map((x) => `${x.function}/${x.name}`), ['g/정상/1건', 'load_emps/데이터 없음']);
  assert.ok(list[0].path.endsWith(path.join('.vstags', 'snapshots', 'g', '정상_1건.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memcpy: 모르는 원본은 물음 (문자열은 첫 \0 까지만, 구조체는 모르는 멤버)', () => {
  const src = `#include "common.h"
int m(void)
{
    char s1[10];
    char s2[10];
    struct dept_rec d1, d2, d3;
    strcpy(s1, "AB");
    memcpy(s2, s1, sizeof(s2));
    d1.deptno = 10;
    memcpy(&d2, &d1, sizeof(d1));
    memset(&d3, 0, sizeof(d3));
    memcpy(&d2, &d3, sizeof(d3));
    return d2.deptno;
}
`;
  const { sim } = buildSimulator(index, path.join(FIX, 'src/mc.c'), src, 3, 12);
  const r = drive(sim, { values: { 'd1.dname': '"SALES"' } });
  assert.deepStrictEqual(r.needs, ['d1.dname'], 's1 의 \0 뒤 쓰레기 영역, memset 한 d3 는 묻지 않음');
  assert.strictEqual(val(sim, 's2'), '"AB"');
  assert.match(r.end, /return 0/);
});
