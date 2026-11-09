import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { DEFAULT_ENCODING, indexFile, indexText } from '../core/fileIndexer';
import { SymbolIndex } from '../core/symbolIndex';
import { LintIssue, lintSource, LintOptions, splitName } from '../lint/lint';

const FIX = path.resolve(__dirname, '../../test-fixtures/lint');
const index = new SymbolIndex();
for (const f of ['conv.h', 'conv.pc']) index.setFile(indexFile(path.join(FIX, f), DEFAULT_ENCODING, 1 << 30));

function lintFile(name: string, opts?: LintOptions): LintIssue[] {
  const p = path.join(FIX, name);
  return lintSource(p, fs.readFileSync(p, 'utf8'), index.getFile(p)!, index, opts);
}
function lintText(name: string, src: string, opts?: LintOptions): LintIssue[] {
  const p = path.join(FIX, name);
  return lintSource(p, src, indexText(p, src), index, opts);
}
/** "줄:규칙" 목록 (1-based 줄) */
const keys = (issues: LintIssue[]) => issues.map((i) => `${i.line + 1}:${i.rule}`);

const pc = lintFile('conv.pc');
const pcKeys = keys(pc);
const has = (k: string) => assert.ok(pcKeys.includes(k), `${k} 없음:\n${pcKeys.join('\n')}`);
const lacks = (line: number) => assert.ok(!pcKeys.some((k) => k.startsWith(line + ':')), `${line}행에 경고가 있으면 안 됨:\n${pcKeys.join('\n')}`);

test('lint: 접두어 분해', () => {
  assert.deepStrictEqual(splitName('h_g_pszAcnt'), { h: true, g: true, badOrder: false, hung: 'psz', body: 'Acnt' });
  assert.deepStrictEqual(splitName('g_h_nX'), { h: true, g: true, badOrder: true, hung: 'n', body: 'X' });
  assert.deepStrictEqual(splitName('cnt'), { h: false, g: false, badOrder: false, hung: 'cnt', body: '' });
});

test('lint: 접두어 ↔ 타입 (typedef / 배열 / 포인터 / 구조체)', () => {
  for (const line of [23, 24, 25, 26, 27, 28, 29, 30, 31, 34, 35, 36, 37, 38, 39, 40, 42]) lacks(line);
  has('41:prefix-type');
  assert.ok(!pcKeys.includes('41:camel-case'), '접두어 경고가 있으면 CamelCase 는 생략');
  has('43:camel-case');
  const msg = pc.find((i) => i.line === 40 && i.rule === 'prefix-type')!.message;
  assert.match(msg, /'n' 접두어 \(현재 'cnt'\)/);
});

test('lint: sz 는 + 1, ac 는 + 1 금지 (매크로 본문까지)', () => {
  has('32:sz-plus-one');
  has('33:ac-no-plus-one');
  lacks(31); // [LEN_MSG_COD + 1]
  lacks(42); // [LEN_ACNT] -> (10 + 1)
  lacks(34); // ac[LEN_FILLER]
});

test('lint: 전역 / static / extern / 호스트 변수', () => {
  lacks(5); // static int32 g_nTotal
  has('6:global-static');
  has('6:global-prefix');
  has('7:no-extern');
  lacks(10); // h_g_szAcnt
  has('11:host-prefix');
  has('44:static-local');
  assert.ok(!pcKeys.includes('44:global-prefix'), 'static 지역 변수에 g_ 가 있으면 통과');
  has('45:global-prefix');
});

test('lint: 주석 / 헤더가드 / EXEC SQL INCLUDE / 구조체 / 함수', () => {
  has('100:comment-line');
  has('3:sql-include');
  has('14:struct-typedef');
  has('21:struct-param-by-value');
  has('100:internal-static');
  assert.ok(!pcKeys.some((k) => /:internal-static/.test(k) && !k.startsWith('100:')), 'static 함수나 헤더에 선언된 함수는 통과');
  has('81:if-assign');

  assert.deepStrictEqual(keys(lintFile('conv.h')), ['23:typedef-suffix']);
  assert.deepStrictEqual(keys(lintText('noguard.h', 'typedef int foo_t;\n')), ['1:header-guard']);
  assert.deepStrictEqual(keys(lintText('once.h', '#pragma once\ntypedef int foo_t;\n')), []);
});

test('lint: sqlcode 확인 (직접 / 매크로 / 함수 / WHENEVER)', () => {
  assert.deepStrictEqual(pcKeys.filter((k) => k.endsWith(':sqlcode-check')), ['86:sqlcode-check']);
  // 자동 인식이 안 되는 이름은 설정으로
  const src = 'static int f(void)\n{\n    EXEC SQL DELETE FROM T;\n    if (MY_CHK()) return -1;\n    return 0;\n}\n';
  assert.deepStrictEqual(keys(lintText('a.pc', src)).filter((k) => k.endsWith('sqlcode-check')), ['3:sqlcode-check']);
  assert.deepStrictEqual(keys(lintText('a.pc', src, { sqlCheckNames: ['MY_CHK'] })).filter((k) => k.endsWith('sqlcode-check')), []);
});

test('lint: memset 크기 / 초기화 전 사용', () => {
  has('66:memset-size');
  has('67:memset-size');
  lacks(68); // sizeof(*ptOut)
  has('54:uninit-local'); // tC: OUT 인자로 처음 넘김
  has('57:uninit-local'); // szTmp: strcpy 로 처음 덮어씀
  for (const line of [52, 53, 55, 56, 58]) lacks(line); // memset / 초기화 매크로 / = {0} / [0] = 0x00
});

test('lint: sz / ac 복사 크기', () => {
  for (const line of [71, 72, 73, 74, 75, 76]) has(`${line}:copy-size`);
  for (const line of [77, 78, 79]) lacks(line); // memcpy 정확한 크기, 한글 4바이트, sizeof - 1
  assert.match(pc.find((i) => i.line === 70)!.message, /문자열\(6바이트\) \+ NUL 이 'szSmall'\(6바이트\)/);
});

test('lint: 규칙별 끄기 / 심각도, 접두어 표 바꾸기', () => {
  const off = keys(lintFile('conv.pc', { rules: { 'copy-size': 'off', 'camel-case': 'hint' } }));
  assert.ok(!off.some((k) => k.endsWith(':copy-size')));
  assert.strictEqual(lintFile('conv.pc', { rules: { 'camel-case': 'hint' } }).find((i) => i.rule === 'camel-case')!.severity, 'hint');
  assert.strictEqual(pc.find((i) => i.rule === 'camel-case')!.severity, 'information');
  assert.strictEqual(pc.find((i) => i.rule === 'prefix-type')!.severity, 'warning');

  const src = 'static int f(void)\n{\n    int iCnt = 0;\n    int nCnt = 0;\n    return iCnt + nCnt;\n}\n';
  assert.deepStrictEqual(keys(lintText('b.c', src)).filter((k) => k.endsWith('prefix-type')), ['3:prefix-type']);
  assert.deepStrictEqual(keys(lintText('b.c', src, { prefixes: { i: ['int'] } })).filter((k) => k.endsWith('prefix-type')), ['4:prefix-type']);
});

test('lint: 같은 규칙이 10줄 이상 연달아 걸리면 하나로 묶음 (빈 줄/주석 줄은 이어진 것으로)', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 6; i++) lines.push(`static double dAmt${i} = 0;`);
  lines.push('', '/* 주석 */');
  for (let i = 7; i <= 12; i++) lines.push(`static double dAmt${i} = 0;`);
  lines.push('static double g_dOk = 0;'); // 끊김
  for (let i = 13; i <= 15; i++) lines.push(`static double dAmt${i} = 0;`);
  const src = lines.join('\n') + '\n';

  const out = lintText('g.c', src).filter((i) => i.rule === 'global-prefix');
  assert.strictEqual(out.length, 4, '묶음 1 + 끊긴 뒤 3개');
  const g = out.find((i) => i.related)!;
  assert.strictEqual(g.related!.length, 12);
  assert.deepStrictEqual([g.line, g.endLine], [0, 13]);
  assert.match(g.message, /^g_ 접두어 규칙 위반: 12건 \(1~14행/);
  assert.match(g.related![0].message, /'dAmt1'/);
  assert.deepStrictEqual(out.filter((i) => !i.related).map((i) => i.line + 1), [16, 17, 18]);

  assert.strictEqual(lintText('g.c', src, { groupMinLines: 0 }).filter((i) => i.rule === 'global-prefix').length, 15);
  assert.strictEqual(lintText('g.c', src, { groupMinLines: 13 }).filter((i) => i.rule === 'global-prefix').length, 15);
});

test('lint: 같은 심각도 안에서 안전 검사를 먼저 (VS Code 의 파일당 1000개 제한 대비)', () => {
  const warnings = pc.filter((i) => i.severity === 'warning');
  const lastSafety = warnings.map((i) => ['sqlcode-check', 'memset-size', 'uninit-local', 'copy-size'].includes(i.rule)).lastIndexOf(true);
  const firstOther = warnings.findIndex((i) => !['sqlcode-check', 'memset-size', 'uninit-local', 'copy-size'].includes(i.rule));
  assert.ok(lastSafety >= 0 && lastSafety < firstOther, '안전 검사 다음에 나머지 경고');
  assert.ok(pc.findIndex((i) => i.severity === 'information') > pc.map((i) => i.severity).lastIndexOf('warning'), 'warning 다음에 information');
});
