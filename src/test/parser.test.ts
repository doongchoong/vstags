import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { decode, decodeCp949, DEFAULT_ENCODING, indexFile, indexText } from '../core/fileIndexer';
import { SymbolIndex } from '../core/symbolIndex';
import { Def, FileIndex, REF_STRIDE, RefFlag } from '../core/types';

const FIX = path.resolve(__dirname, '../../test-fixtures');
const fx = (p: string) => indexFile(path.join(FIX, p), DEFAULT_ENCODING, 1 << 30);

function def(fi: FileIndex, name: string, kind?: string): Def {
  const d = fi.defs.find((x) => x.name === name && (!kind || x.kind === kind));
  assert.ok(d, `def ${name} (${kind ?? '*'}) not found; have: ${fi.defs.map((x) => x.kind + ':' + x.name).join(', ')}`);
  return d!;
}
function refs(fi: FileIndex, name: string): { line: number; col: number; flags: number; enc: string }[] {
  const ni = fi.names.indexOf(name);
  const out = [];
  for (let k = 0; k < fi.refs.length; k += REF_STRIDE) {
    if (fi.refs[k] !== ni) continue;
    const e = fi.refs[k + 4];
    out.push({ line: fi.refs[k + 1] + 1, col: fi.refs[k + 2] + 1, flags: fi.refs[k + 3], enc: e >= 0 ? fi.defs[e].name : '' });
  }
  return out;
}

test('Pro*C: EXEC SQL 블록 무시 + 호스트 변수/커서/WHENEVER 추출', () => {
  const fi = fx('src/emp.pc');
  assert.strictEqual(def(fi, 'load_emps', 'function').line + 1, 32);
  assert.strictEqual(def(fi, 'load_emps').endLine! + 1, 69);
  assert.strictEqual(def(fi, 'raise_sal', 'function').endLine! + 1, 81);
  assert.strictEqual(def(fi, 'emp_cur', 'cursor').line + 1, 26);
  assert.strictEqual(def(fi, 'done', 'label').scope, fi.defs.indexOf(def(fi, 'load_emps')));
  assert.strictEqual(def(fi, 'h_ename', 'variable').type, 'VARCHAR');
  // WHENEVER SQLERROR DO sql_error(...) 는 호출로 기록
  const se = refs(fi, 'sql_error');
  assert.ok(se.some((r) => r.flags & RefFlag.Call && r.flags & RefFlag.Sql && r.enc === 'load_emps'));
  // :h_empno 호스트 변수
  assert.ok(refs(fi, 'h_empno').filter((r) => r.flags & RefFlag.Sql).length >= 3);
  // PL/SQL 블록 안의 내용은 C 참조가 아님
  assert.strictEqual(refs(fi, 'update_stats').length, 0);
  assert.strictEqual(refs(fi, 'emp').length, 0);
  assert.deepStrictEqual(fi.includes, ['string.h', 'common.h', 'sqlca', 'common.h']);
});

test('K&R 함수, 지역 변수 가림, #ifdef 중괄호 불균형, #if 0', () => {
  const fi = fx('src/legacy.c');
  const old = def(fi, 'old_style', 'function');
  assert.strictEqual(old.endLine! + 1, 15);
  for (const p of ['a', 'b', 'name']) assert.strictEqual(def(fi, p, 'param').scope, fi.defs.indexOf(old));
  assert.strictEqual(def(fi, 'b', 'param').type, 'char');
  assert.strictEqual(def(fi, 'counter', 'local').scope, fi.defs.indexOf(old));
  // dispatch 는 #ifdef/#else 양쪽에 '{' 가 있어도 끝 줄이 맞아야 함
  assert.strictEqual(def(fi, 'dispatch', 'function').endLine! + 1, 49);
  assert.strictEqual(def(fi, 'get_handler', 'function').line + 1, 51);
  assert.strictEqual(def(fi, 'use_types', 'function').line + 1, 56);
  // #if 0 내용 무시
  assert.strictEqual(refs(fi, 'compiled').length, 0);
  // 함수 포인터 테이블 등록 (&cb_two -> Addr)
  assert.ok(refs(fi, 'cb_two').some((r) => r.flags & RefFlag.Addr && r.enc === 'g_handlers'));
  assert.ok(refs(fi, 'cb_one').some((r) => r.enc === 'g_handlers'));

  const idx = new SymbolIndex();
  idx.setFile(fi);
  // 전역 counter 참조에서 old_style 내부(지역 counter)는 제외
  const gr = idx.references('counter', { excludeShadowed: true });
  assert.deepStrictEqual(gr.map((r) => r.line + 1), [44]);
});

test('헤더: struct/union/enum/typedef/멤버 컨테이너', () => {
  const fi = fx('include/common.h');
  assert.strictEqual(def(fi, 'LOG_ERR', 'macro').endLine! + 1, 9);
  assert.strictEqual(def(fi, 'LOG_LEVEL_ERR', 'enumerator').container, 'log_level');
  assert.strictEqual(def(fi, 'LogLevel', 'typedef').type, 'log_level');
  assert.strictEqual(def(fi, 'empno', 'member').container, 'emp_rec');
  assert.strictEqual(def(fi, 'on_change', 'member').container, 'emp_rec');
  assert.strictEqual(def(fi, 'ival', 'member').container, 'u');
  assert.strictEqual(def(fi, 'u', 'member').container, 'emp_rec');
  assert.strictEqual(def(fi, 'count', 'member').container, 'EmpList'); // 익명 typedef struct
  assert.strictEqual(def(fi, 'g_debug', 'extern').type, 'int');
  assert.strictEqual(def(fi, 'c_linkage_fn', 'prototype').line + 1, 50);
  assert.ok(def(fi, 'helper_static', 'prototype').isStatic);
  // 프로토타입의 파라미터 이름은 참조가 아님
  assert.strictEqual(refs(fi, 'deptno').length, 0);
  // 매크로 본문의 참조는 매크로 소속
  assert.ok(refs(fi, 'log_write').some((r) => r.enc === 'LOG_ERR' && r.flags & RefFlag.Call));
});

test('EUC-KR 소스: 컬럼은 바이트가 아닌 문자 기준', () => {
  const fi = fx('src/euckr.c');
  assert.strictEqual(def(fi, 'korean_fn').col, 16);
  const raw = fs.readFileSync(path.join(FIX, 'src/euckr.c'));
  assert.ok(decode(raw).includes('한글'));
});

test('여러 C 구문 조각', () => {
  const src = `
#define OBJ_LIKE (1 + 2)
#define FN_LIKE(a, b) ((a) + (b) + OBJ_LIKE)
extern "C" {
int in_extern_c(void);
}
static inline struct node *make_node(int v) { return alloc_node(v); }
int (*g_ops[4])(int) = { op_a, op_b };
int f PROTO((int a, int b));
DECLARE_SOMETHING(foo)
int after_macro(void) { return 0; }
enum color { RED = 1 << 0, GREEN = RED * 2, BLUE };
typedef struct node { struct node *next; int val : 4; } Node, *NodePtr;
unsigned long long big_counter = 0, *p_counter = &big_counter;
int main(int argc, char **argv) {
  struct node n = { 0 };
  Node *np = &n;
  int i, arr[10];
  for (int k = 0; k < 3; k++) i = k;
  np->val = FN_LIKE(1, 2);
  if (argc > 1) { goto out; }
out:
  return make_node(arr[0]) != 0;
}
`;
  const fi = indexText('t.c', src);
  const kinds = Object.fromEntries(fi.defs.filter((d) => d.scope === undefined).map((d) => [d.name, d.kind]));
  assert.deepStrictEqual(
    {
      OBJ_LIKE: kinds.OBJ_LIKE, FN_LIKE: kinds.FN_LIKE, in_extern_c: kinds.in_extern_c, make_node: kinds.make_node,
      g_ops: kinds.g_ops, f: kinds.f, after_macro: kinds.after_macro, color: kinds.color, GREEN: kinds.GREEN,
      node: kinds.node, Node: kinds.Node, NodePtr: kinds.NodePtr, big_counter: kinds.big_counter, p_counter: kinds.p_counter, main: kinds.main,
    },
    {
      OBJ_LIKE: 'macro', FN_LIKE: 'macro', in_extern_c: 'prototype', make_node: 'function', g_ops: 'variable', f: 'prototype',
      after_macro: 'function', color: 'enum', GREEN: 'enumerator', node: 'struct', Node: 'typedef', NodePtr: 'typedef',
      big_counter: 'variable', p_counter: 'variable', main: 'function',
    },
  );
  assert.strictEqual(kinds.foo, undefined);
  assert.strictEqual(kinds.DECLARE_SOMETHING, undefined);
  assert.strictEqual(def(fi, 'make_node').type, 'node');
  assert.ok(def(fi, 'make_node').isStatic);
  const main = fi.defs.indexOf(def(fi, 'main'));
  for (const l of ['argc', 'argv', 'n', 'np', 'i', 'arr', 'k', 'out']) {
    assert.ok(fi.defs.some((d) => d.name === l && d.scope === main), `local ${l}`);
  }
  assert.strictEqual(def(fi, 'np', 'local').type, 'Node');
  assert.strictEqual(def(fi, 'val', 'member').container, 'node');
  assert.ok(refs(fi, 'op_a').length === 1 && refs(fi, 'op_a')[0].enc === 'g_ops');
  assert.ok(refs(fi, 'alloc_node')[0].flags & RefFlag.Call);
  assert.ok(refs(fi, 'val')[0].flags & RefFlag.Write);
  assert.ok(refs(fi, 'FN_LIKE').some((r) => r.enc === 'main'));
  assert.strictEqual(refs(fi, 'a').length, 0, 'PROTO 파라미터 / 매크로 파라미터는 참조 아님');
});

test('견고성: 깨진 입력/잘린 파일에서도 예외 없이 종료', () => {
  const samples = ['src/emp.pc', 'src/legacy.c', 'include/common.h'].map((p) => fs.readFileSync(path.join(FIX, p), 'utf8'));
  for (const s of samples) {
    for (let cut = 0; cut < s.length; cut += 7) indexText('cut.c', s.slice(0, cut));
    for (let cut = 0; cut < s.length; cut += 13) indexText('cut.c', s.slice(cut));
  }
  const alphabet = ['{', '}', '(', ')', ';', ',', '=', '*', 'int ', 'x ', 'struct ', 'enum ', '#if 0\n', '#else\n', '#endif\n',
    '#define A(x) x\n', 'EXEC SQL ', 'SELECT :h ', 'END-EXEC', "'", '"', '/*', '*/', '\n', 'typedef ', 'f(', '->', '.', ':'];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
  for (let n = 0; n < 2000; n++) {
    let s = '';
    const len = rnd() % 80;
    for (let i = 0; i < len; i++) s += alphabet[rnd() % alphabet.length];
    indexText('fuzz.c', s);
  }
});

test('CP949: 확장 완성형/깨진 바이트도 한 글자로 디코딩되어 컬럼이 VSCode(windows949)와 일치', () => {
  // "/* 똠 한 [FE FE] 갂 [80] */ int cp_fn(void);"
  //  똠=8C63(확장)  한=C7D1(표준)  FEFE(사용자 정의)  갂=8141(확장)  80(단독 깨진 바이트)
  const bytes = Buffer.concat([
    Buffer.from('/* '),
    Buffer.from([0x8c, 0x63, 0x20, 0xc7, 0xd1, 0x20, 0xfe, 0xfe, 0x20, 0x81, 0x41, 0x20, 0x80]),
    Buffer.from(' */ int cp_fn(void);'),
  ]);
  const text = decodeCp949(bytes);
  assert.strictEqual(text, '/* \ufffd 한 \ufffd \ufffd \ufffd */ int cp_fn(void);');
  assert.strictEqual(decode(bytes), text, 'auto 모드: UTF-8 실패 후 cp949');
  assert.strictEqual(decode(bytes, { encoding: 'euc-kr', fallback: 'cp949' }), text, 'euc-kr 라벨도 같은 디코더');
  const fi = indexText('cp.c', text);
  assert.strictEqual(def(fi, 'cp_fn').col, 20); // '/* ? 한 ? ? ? */ int ' = 20글자
  // 순수 ASCII / UTF-8 파일은 그대로
  assert.strictEqual(decode(Buffer.from('int a; /* 한글 */')), 'int a; /* 한글 */');
});

test('주석: 정의 바로 위(빈 줄 없이)와 같은 줄 오른쪽 주석을 붙임', () => {
  const fi = fx('include/docs.h');
  const doc = (n: string) => def(fi, n).doc;
  assert.strictEqual(doc('MAX_DNAME'), '최대 부서명 길이\n(옆 주석)');
  assert.strictEqual(doc('dept_info'), '부서 정보\n본부/팀 단위', '장식 줄(****) 제거, 빈 줄로 떨어진 주석은 안 붙음');
  assert.strictEqual(doc('no'), '부서번호');
  assert.strictEqual(doc('dname'), '부서명');
  assert.strictEqual(doc('lo'), undefined, '한 줄에 선언이 둘이면 오른쪽 주석은 마지막 것에');
  assert.strictEqual(doc('hi'), '범위 상한');
  assert.strictEqual(doc('DeptInfo'), undefined);
  assert.strictEqual(doc('find_dept'), '부서 조회\nno: 부서번호', 'static int / find_dept( 처럼 이름보다 앞 줄에서 시작해도');
});
