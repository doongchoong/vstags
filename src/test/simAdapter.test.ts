/* 블록 시뮬레이터 Debug Adapter 를 DAP 메시지로 구동 (VSCode 가 하는 것과 같은 순서) */
/* eslint-disable @typescript-eslint/no-explicit-any */
import './useMock';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';

/* eslint-disable @typescript-eslint/no-var-requires */
const mock = require('./vscodeMock');
const { SimDebugAdapter } = require('../sim/debugAdapter');
const { DEFAULT_ENCODING, indexFile } = require('../core/fileIndexer');
const { SymbolIndex } = require('../core/symbolIndex');

const FIX = path.resolve(__dirname, '../../test-fixtures');
const index = new SymbolIndex();
for (const f of ['src/emp.pc', 'include/common.h', 'include/types.h']) index.setFile(indexFile(path.join(FIX, f), DEFAULT_ENCODING, 1 << 30));

const until = async <T>(fn: () => T | undefined, ms = 3000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

class Client {
  msgs: any[] = [];
  private seq = 1;
  constructor(private ad: any) {
    ad.onDidSendMessage((m: any) => this.msgs.push(m));
  }
  async req(command: string, args?: any): Promise<any> {
    const seq = this.seq++;
    this.ad.handleMessage({ seq, type: 'request', command, arguments: args });
    const r = await until(() => this.msgs.find((m) => m.type === 'response' && m.request_seq === seq));
    if (!r.success) throw new Error(`${command}: ${r.message}`);
    return r.body;
  }
  count(event: string) {
    return this.msgs.filter((m) => m.type === 'event' && m.event === event).length;
  }
  async nextEvent(event: string, after: number): Promise<any> {
    return until(() => this.msgs.filter((m) => m.type === 'event' && m.event === event)[after]);
  }
  output() {
    return this.msgs.filter((m) => m.event === 'output').map((m) => m.body.output).join('');
  }
}

test('DAP: 진입 시 멈춤 -> 변수 창에서 값 입력 -> 계속 -> SQL 결과 선택 -> 종료', async () => {
  mock.window.quickPick = async (items: any[]) => items.find((i) => i.label === '0');
  const c = new Client(new SimDebugAdapter(() => index));
  const caps = await c.req('initialize', { adapterID: 'vstags-sim' });
  assert.ok(caps.supportsSetVariable);
  await c.req('launch', { file: path.join(FIX, 'src/emp.pc'), startLine: 72, endLine: 78 });
  await c.req('setBreakpoints', { source: { path: path.join(FIX, 'src/emp.pc') }, breakpoints: [] });
  await c.req('configurationDone');
  const stopped = await c.nextEvent('stopped', 0);
  assert.strictEqual(stopped.body.reason, 'entry');
  const st = await c.req('stackTrace', { threadId: 1 });
  assert.strictEqual(st.stackFrames[0].line, 73);
  assert.match(st.stackFrames[0].name, /raise_sal/);
  const vars = (await c.req('variables', { variablesReference: 1 })).variables;
  assert.deepStrictEqual(vars.map((v: any) => `${v.name}=${v.value}`).sort(), ['empno=?', 'pct=?']);
  const set = await c.req('setVariable', { variablesReference: 1, name: 'pct', value: '10' });
  assert.strictEqual(set.value, '10');
  const ev = await c.req('evaluate', { expression: 'pct * 2', context: 'watch' });
  assert.strictEqual(ev.result, '20');
  const sqlca = (await c.req('variables', { variablesReference: 2 })).variables;
  assert.ok(sqlca.some((v: any) => v.name === 'sqlcode' && v.value === '0'));
  await c.req('continue', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.match(c.output(), /UPDATE emp SET sal = sal \* \(1 \+ 10 \/ 100\)/);
  assert.match(c.output(), /■ 블록 끝/);
});

test('DAP: 모르는 값이면 예외처럼 멈추고 입력 상자 값으로 이어서 진행, 중단점', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-sim-'));
  const file = path.join(dir, 'f.c');
  fs.writeFileSync(file, 'int f(int a, char *s)\n{\n    int r = 0;\n    if (a > 0)\n        r = 1;\n    if (strcmp(s, "Y") == 0) r += 10;\n    return r;\n}\n');
  const asked: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)); // 실제 입력 상자처럼 사용자가 입력할 때까지 대기
  mock.window.inputBox = async (o: any) => {
    await gate;
    asked.push(o.title);
    return o.title.endsWith(': a') ? '5' : '"N"';
  };
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 2, endLine: 6 });
  await c.req('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 7 }] });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0); // entry
  await c.req('continue', { threadId: 1 });
  const need = await c.nextEvent('stopped', 1);
  assert.strictEqual(need.body.reason, 'exception');
  assert.match(need.body.description, /'a' 값이 필요/);
  const info = await c.req('exceptionInfo', { threadId: 1 });
  assert.strictEqual(info.exceptionId, '값 필요');
  release();
  // 입력 상자 -> 자동으로 계속 -> s 의 문자열을 묻고 -> 중단점(7행)에서 멈춤
  const bp = await c.nextEvent('stopped', 3);
  assert.strictEqual(bp.body.reason, 'breakpoint');
  assert.deepStrictEqual(asked, ['값 입력: a', '값 입력: s']);
  const r = (await c.req('variables', { variablesReference: 1 })).variables.find((v: any) => v.name === 'r');
  assert.strictEqual(r.value, '1');
  await c.req('next', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.match(c.output(), /■ return 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DAP: 문장 건너뛰기 요청 (vstagsSkip)', async () => {
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file: path.join(FIX, 'src/emp.pc'), startLine: 72, endLine: 78 });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0); // 73행 UPDATE 앞
  await c.req('vstagsSkip');
  const st = await c.nextEvent('stopped', 1);
  assert.strictEqual(st.body.reason, 'step');
  assert.strictEqual((await c.req('stackTrace', { threadId: 1 })).stackFrames[0].line, 75);
  assert.match(c.output(), /73행 건너뜀/);
  assert.doesNotMatch(c.output(), /SQL> /, 'UPDATE 는 실행(로그)되지 않음');
  await c.req('disconnect');
});

test('DAP: 함수 안으로 들어가기 - 호출 스택 2단계, 프레임별 변수/조사식, Shift+F11', async () => {
  const file = path.join(FIX, 'src/calls.c');
  index.setFile(indexFile(file, DEFAULT_ENCODING, 1 << 30));
  mock.window.quickPick = async (items: any[]) => items.find((i) => i.id === 'enter') ?? items.find((i) => i.label === '0');
  mock.window.inputBox = async () => '0'; // g_debug
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 18, endLine: 25 });
  await c.req('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 9 }] });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0); // entry
  await c.req('continue', { threadId: 1 });
  const bp = await c.nextEvent('stopped', 2); // 1: g_debug 값 필요, 2: fill 안의 중단점
  assert.strictEqual(bp.body.reason, 'breakpoint');
  const st = (await c.req('stackTrace', { threadId: 1 })).stackFrames;
  assert.deepStrictEqual(st.map((f: any) => [f.id, f.name.split(' ')[0], f.line]), [[2, 'fill()', 9], [1, 'flow', 22]]);
  const sc = (await c.req('scopes', { frameId: 2 })).scopes;
  const vars = (await c.req('variables', { variablesReference: sc[0].variablesReference })).variables;
  assert.ok(vars.some((v: any) => v.name === 'no' && v.value === '100'), JSON.stringify(vars));
  assert.ok(vars.some((v: any) => v.name === 'r' && v.value === '→ rec'));
  assert.strictEqual((await c.req('evaluate', { expression: 'r->ename', frameId: 2, context: 'watch' })).result, '"SCOTT"');
  assert.strictEqual((await c.req('evaluate', { expression: 'next', frameId: 1, context: 'watch' })).result, '?');
  await c.req('stepOut', { threadId: 1 });
  const back = await c.nextEvent('stopped', 3);
  assert.strictEqual(back.body.reason, 'step');
  const st2 = (await c.req('stackTrace', { threadId: 1 })).stackFrames;
  assert.deepStrictEqual(st2.map((f: any) => f.line), [23], '호출한 쪽 다음 문장 (b = bonus(rec))');
  assert.strictEqual((await c.req('evaluate', { expression: 'next', context: 'watch' })).result, '101');
  await c.req('continue', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.match(c.output(), /← fill\(\) = 101/);
  assert.match(c.output(), /■ return 126/);
});

test('DAP: 값 입력 상자에서 건너뛰기 버튼 -> 그 문장을 넘어감', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-sim-'));
  const file = path.join(dir, 'g.c');
  fs.writeFileSync(
    file,
    ['int g(int a, char *s)', '{', '    int r = 0;', '    if (a > 0)', '        r = 1;', '    if (strcmp(s, "Y") == 0) r += 10;', '    return r;', '}', ''].join('\n'),
  );
  mock.window.inputBox = async (o: any) => (o.title.endsWith(': a') ? mock.SKIP_BUTTON : '"Y"');
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 2, endLine: 6 });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0);
  await c.req('continue', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.match(c.output(), /4행 건너뜀/);
  assert.match(c.output(), /■ return 10/, 'a 를 묻는 if 는 건너뛰고 s 는 "Y"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DAP: Jump to Cursor (gotoTargets / goto)', async () => {
  const file = path.join(FIX, 'src/calls.c');
  const c = new Client(new SimDebugAdapter(() => index));
  const caps = await c.req('initialize', {});
  assert.ok(caps.supportsGotoTargetsRequest);
  await c.req('launch', { file, startLine: 18, endLine: 25 });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0); // 19행
  const t = (await c.req('gotoTargets', { source: { path: file }, line: 23 })).targets;
  assert.deepStrictEqual(t.map((x: any) => x.line), [23]);
  assert.deepStrictEqual((await c.req('gotoTargets', { source: { path: file }, line: 3 })).targets, [], '다른 함수(fill) 줄은 대상 아님');
  await c.req('goto', { threadId: 1, targetId: t[0].id });
  const st = await c.nextEvent('stopped', 1);
  assert.strictEqual(st.body.reason, 'goto');
  assert.strictEqual((await c.req('stackTrace', { threadId: 1 })).stackFrames[0].line, 23);
  assert.strictEqual((await c.req('evaluate', { expression: 'next', context: 'watch' })).result, '?', '22행(next = fill(...))은 실행 안 됨');
  assert.match(c.output(), /19행에서 23행으로 건너뜀/);
  await c.req('disconnect');
});

test('DAP: 뒤로 한 단계 - 처음부터 다시 실행해서 이전 문장으로, 그 전 입력은 유지하고 묻지 않음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-sim-'));
  const file = path.join(dir, 'h.c');
  fs.writeFileSync(file, ['int h(int a)', '{', '    int r = 0;', '    if (a > 0)', '        r = 1;', '    r = r + 10;', '    return r;', '}', ''].join('\n'));
  let asked = 0;
  mock.window.inputBox = async () => (++asked === 1 ? '5' : '-1');
  const c = new Client(new SimDebugAdapter(() => index));
  const caps = await c.req('initialize', {});
  assert.ok(caps.supportsStepBack);
  await c.req('launch', { file, startLine: 2, endLine: 6 });
  await c.req('configurationDone');
  const line = async () => (await c.req('stackTrace', { threadId: 1 })).stackFrames[0].line;
  const val = async (e: string) => (await c.req('evaluate', { expression: e, context: 'watch' })).result;
  await c.nextEvent('stopped', 0); // 3행
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 1); // 4행 if
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 2); // a 값 필요 -> 입력 5
  await c.nextEvent('stopped', 3); // 5행 r = 1
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 4);
  assert.strictEqual(await line(), 6);
  assert.strictEqual(await val('r'), '1');

  await c.req('stepBack', { threadId: 1 });
  await c.nextEvent('stopped', 5);
  assert.strictEqual(await line(), 5);
  assert.strictEqual(await val('r'), '0', 'r = 1 은 아직 실행 전');
  assert.strictEqual(await val('a'), '5', '그 전에 넣은 값은 유지');
  assert.strictEqual(asked, 1, '다시 묻지 않음');
  assert.match(c.output(), /↶ h\.c 5행으로 되돌아감/);

  await c.req('stepBack', { threadId: 1 });
  await c.nextEvent('stopped', 6);
  assert.strictEqual(await line(), 4);
  assert.strictEqual(await val('a'), '?', 'a 를 넣기 전으로 돌아감');

  // 다른 값으로 다시 진행
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 8); // 7: a 값 필요 -> -1, 8: 6행
  assert.strictEqual(asked, 2);
  assert.strictEqual(await line(), 6);
  await c.req('continue', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.match(c.output(), /■ return 10/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DAP: 뒤로 가기 - SQL 결과 답도 다시 묻지 않음, reverseContinue 는 이전 중단점까지', async () => {
  const file = path.join(FIX, 'src/emp.pc');
  let picks = 0;
  mock.window.quickPick = async (items: any[]) => {
    picks++;
    return items.find((i) => i.label === '0');
  };
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 72, endLine: 78 });
  await c.req('configurationDone');
  const line = async () => (await c.req('stackTrace', { threadId: 1 })).stackFrames[0].line;
  await c.nextEvent('stopped', 0); // 73 UPDATE
  await c.req('next', { threadId: 1 }); // SQL 결과 0
  await c.nextEvent('stopped', 1); // 75
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 2); // 79 COMMIT
  assert.strictEqual(await line(), 79);
  assert.strictEqual(picks, 1);

  await c.req('stepBack', { threadId: 1 });
  await c.nextEvent('stopped', 3);
  assert.strictEqual(await line(), 75);
  assert.strictEqual(picks, 1, 'UPDATE 결과는 기록대로 다시 적용');
  assert.strictEqual((await c.req('evaluate', { expression: 'sqlca.sqlcode', context: 'watch' })).result, '0');

  await c.req('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 73 }] });
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 4); // 79
  await c.req('reverseContinue', { threadId: 1 });
  await c.nextEvent('stopped', 5);
  assert.strictEqual(await line(), 73, '75 를 지나 중단점(73)까지');
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 6);
  assert.strictEqual(picks, 2, '73 이전으로 돌아갔으므로 UPDATE 결과는 다시 물음');
  await c.req('disconnect');
});

test('DAP: 들어간 함수 안에서 뒤로 가기 - 호출 스택도 그대로 복원', async () => {
  const file = path.join(FIX, 'src/calls.c');
  mock.window.quickPick = async (items: any[]) => items.find((i) => i.id === 'enter');
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 18, endLine: 25 });
  await c.req('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 6 }] });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0);
  await c.req('continue', { threadId: 1 }); // fill 로 들어가서 6행 중단점
  await c.nextEvent('stopped', 1);
  const frames = async () => (await c.req('stackTrace', { threadId: 1 })).stackFrames.map((f: any) => `${f.name.split(' ')[0]}:${f.line}`);
  assert.deepStrictEqual(await frames(), ['fill():6', 'flow:22']);
  await c.req('stepBack', { threadId: 1 });
  await c.nextEvent('stopped', 2);
  assert.deepStrictEqual(await frames(), ['fill():5', 'flow:22']);
  assert.strictEqual((await c.req('evaluate', { expression: 'r->empno', frameId: 2, context: 'watch' })).result, '100');
  assert.strictEqual((await c.req('evaluate', { expression: 'r->ename', frameId: 2, context: 'watch' })).result, '""', 'strcpy(5행) 전');
  await c.req('disconnect');
});

test('DAP: char* 를 돌려주는 함수는 문자열을 물음 (선언된 반환 타입 표시)', async () => {
  const file = path.join(FIX, 'src/rettype.c');
  index.setFile(indexFile(path.join(FIX, 'include/utils.h'), DEFAULT_ENCODING, 1 << 30));
  const titles: string[] = [];
  mock.window.quickPick = async (items: any[], o: any) => {
    titles.push(o.title + ' | ' + items.map((i) => i.id).join(','));
    return items.find((i) => i.id === 'str');
  };
  mock.window.inputBox = async () => '정상 처리';
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 8, endLine: 9 });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0);
  await c.req('continue', { threadId: 1 });
  await c.nextEvent('terminated', 0);
  assert.strictEqual(titles.length, 1);
  assert.match(titles[0], /get_msg(100) → char* | str,later,null,always,skip/);
  // 뒤로 가기용 기록도 같은 답으로 다시 적용되는지는 journal 공용 함수로 확인
  const { returnAnswer } = require('../sim/journal');
  assert.deepStrictEqual(returnAnswer('str', undefined, 'x'), { value: 0, as: 'str', str: 'x', havoc: true });
});

test('DAP: 변수값 스냅샷 모으기/적용 + 변수 창 새로 고침 + 지금 함수 알림', async () => {
  const file = path.join(FIX, 'src/calls.c');
  const c = new Client(new SimDebugAdapter(() => index));
  await c.req('initialize', {});
  await c.req('launch', { file, startLine: 18, endLine: 25 });
  await c.req('configurationDone');
  await c.nextEvent('stopped', 0);
  const frame = await c.nextEvent('vstagsFrame', 0);
  assert.strictEqual(frame.body.function, 'flow');
  // 함수 첫 줄(선언 전)에서 적용해도, 초기값 없는 선언(int next, b;)을 지나면서 값이 유지됨
  const res = await c.req('vstagsSnapshotApply', { name: 't', values: { next: '99', b: '3', nosuch: '1' } });
  assert.deepStrictEqual(res.applied, ['next', 'b']);
  assert.deepStrictEqual(res.failed.map((f: any) => f.path), ['nosuch']);
  await c.nextEvent('invalidated', 0);
  assert.match(c.output(), /변수값 적용 't': 2개, 적용 못 함 1개 \(nosuch\)/);
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 1);
  await c.req('next', { threadId: 1 });
  await c.nextEvent('stopped', 2); // 21행 (선언을 지난 뒤)
  assert.strictEqual((await c.req('evaluate', { expression: 'next', context: 'watch' })).result, '99');
  assert.strictEqual((await c.req('evaluate', { expression: 'b', context: 'watch' })).result, '3');
  await c.req('setVariable', { variablesReference: 1, name: 'next', value: '41' });
  const col = await c.req('vstagsSnapshotCollect');
  assert.strictEqual(col.function, 'flow');
  assert.strictEqual(col.values.next, '41');
  assert.strictEqual(col.values.b, '3');
  await c.req('disconnect');
});
