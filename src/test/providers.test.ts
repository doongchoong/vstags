/* vscode 목을 이용한 프로바이더 동작 테스트 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';

import './useMock';

/* eslint-disable @typescript-eslint/no-var-requires */
const mock = require('./vscodeMock');
const { CProviders, SemanticTokens } = require('../vscode/providers');
const { indexFile, indexText } = require('../core/fileIndexer');
const { SymbolIndex } = require('../core/symbolIndex');

const FIX = path.resolve(__dirname, '../../test-fixtures');
const files = ['src/emp.pc', 'src/legacy.c', 'src/euckr.c', 'include/common.h', 'include/types.h'].map((p) => path.join(FIX, p));
const index = new SymbolIndex();
for (const f of files) index.setFile(indexFile(f, { encoding: 'auto', fallback: 'cp949' }, 1 << 30));
const mgr = {
  index,
  live: (doc: any) => indexText(doc.uri.fsPath, doc.getText()),
  overrides: () => new Map(),
  onDidChange: () => ({ dispose() {} }),
};
const prov = new CProviders(mgr);

const docs = new Map<string, any>();
function doc(rel: string) {
  const p = path.join(FIX, rel);
  if (!docs.has(p)) docs.set(p, mock.makeDoc(p, fs.readFileSync(p, 'utf8')));
  return docs.get(p);
}
/** rel 파일에서 lineContains 를 포함하는 줄의 word 위치 */
function at(rel: string, lineContains: string, word: string, nth = 0) {
  const d = doc(rel);
  for (let l = 0; l < d.lineCount; l++) {
    const t = d.lineAt(l).text as string;
    if (!t.includes(lineContains)) continue;
    let c = -1;
    for (let i = 0; i <= nth; i++) c = t.indexOf(word, c + 1);
    if (c >= 0) return { d, pos: new mock.Position(l, c + 1) };
  }
  throw new Error(`not found: ${lineContains} / ${word}`);
}
const where = (l: any) => `${path.basename(l.uri.fsPath)}:${l.range.start.line + 1}`;

test('정의로 이동: 프로토타입보다 함수 정의 우선', () => {
  const { d, pos } = at('src/legacy.c', 'load_emps(&g_emps', 'load_emps');
  assert.deepStrictEqual(prov.provideDefinition(d, pos).map(where), ['emp.pc:32']);
  const decl = prov.provideDeclaration(d, pos).map(where);
  assert.deepStrictEqual(decl, ['common.h:44']);
});

test('멤버 접근 경로의 타입 추적', () => {
  let r = at('src/emp.pc', 'rec->empno = h_empno', 'empno');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['common.h:19']);
  r = at('src/legacy.c', 'lst->items[0].u.ival', 'ival');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['common.h:24']);
  r = at('src/legacy.c', 'e.dept->deptno', 'deptno');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['common.h:31']);
  r = at('src/legacy.c', 'strcmp(g_handlers[i].name', 'name');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['legacy.c:21']);
});

test('지역 변수 / 전역 변수 구분', () => {
  let r = at('src/legacy.c', 'return counter + load_emps', 'counter');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['legacy.c:12']);
  const localRefs = prov.provideReferences(r.d, r.pos, { includeDeclaration: true }).map(where);
  assert.deepStrictEqual(localRefs, ['legacy.c:12', 'legacy.c:13', 'legacy.c:14']);
  r = at('src/legacy.c', 'counter = old_style(1', 'counter');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['legacy.c:3']);
  assert.deepStrictEqual(prov.provideReferences(r.d, r.pos, { includeDeclaration: true }).map(where), ['legacy.c:3', 'legacy.c:44']);
});

test('Pro*C: 커서/레이블/include/호스트 변수', () => {
  let r = at('src/emp.pc', 'EXEC SQL OPEN emp_cur', 'emp_cur');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['emp.pc:26']);
  r = at('src/emp.pc', 'GOTO done', 'done');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['emp.pc:55']);
  r = at('src/emp.pc', '#include "common.h"', 'common');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['common.h:1']);
  r = at('src/emp.pc', 'FETCH emp_cur INTO', 'h_sal');
  assert.deepStrictEqual(prov.provideDefinition(r.d, r.pos).map(where), ['emp.pc:11']);
  r = at('src/emp.pc', 'raise_sal(int empno', 'empno');
  const refs = prov.provideReferences(r.d, r.pos, { includeDeclaration: false }).map(where);
  assert.deepStrictEqual(refs, ['emp.pc:74'], ':empno 호스트 변수는 파라미터 empno 의 참조');
});

test('호버: 구조체 멤버 목록과 매크로 본문', () => {
  let r = at('src/legacy.c', 'EmpRec e;', 'EmpRec');
  let h = prov.provideHover(r.d, r.pos);
  assert.match(h.contents.value, /typedef struct emp_rec/);
  assert.match(h.contents.value, /int empno;/);
  assert.match(h.contents.value, /on_change/);
  r = at('src/emp.pc', 'LOG_ERR("sql error', 'LOG_ERR');
  h = prov.provideHover(r.d, r.pos);
  assert.match(h.contents.value, /log_write\(LOG_LEVEL_ERR/);
});

test('Call Hierarchy: 호출자 / 피호출자', () => {
  const r = at('src/emp.pc', 'static void sql_error', 'sql_error');
  const [item] = prov.prepareCallHierarchy(r.d, r.pos);
  const inc = prov.provideCallHierarchyIncomingCalls(item).map((c: any) => c.from.name).sort();
  assert.deepStrictEqual(inc, ['load_emps', 'raise_sal']);
  const r2 = at('src/emp.pc', 'int load_emps(EmpList', 'load_emps');
  const [item2] = prov.prepareCallHierarchy(r2.d, r2.pos);
  const out = prov.provideCallHierarchyOutgoingCalls(item2).map((c: any) => c.to.name).sort();
  assert.deepStrictEqual(out, ['log_write', 'sql_error']);
  // 함수 포인터 등록도 호출자로
  const r3 = at('src/legacy.c', 'static int cb_two', 'cb_two');
  const [item3] = prov.prepareCallHierarchy(r3.d, r3.pos);
  assert.deepStrictEqual(prov.provideCallHierarchyIncomingCalls(item3).map((c: any) => c.from.name), ['g_handlers']);
});

test('Outline / Workspace symbols / 자동완성 / 하이라이트 / 이름 바꾸기 / 시맨틱 토큰', () => {
  const syms = prov.provideDocumentSymbols(doc('include/common.h'));
  const emp = syms.find((s: any) => s.name === 'emp_rec');
  assert.ok(emp.children.some((c: any) => c.name === 'on_change'));
  assert.deepStrictEqual(syms.find((s: any) => s.name === 'EmpList').children.map((c: any) => c.name), ['count', 'items']);

  const ws = prov.provideWorkspaceSymbols('ldemp').map((s: any) => s.name);
  assert.ok(ws.includes('load_emps'));

  const d = mock.makeDoc(path.join(FIX, 'src/new.c'), 'void t(void) {\n  EmpRec *r;\n  r->\n  load\n}\n');
  const comp = prov.provideCompletionItems(d, new mock.Position(2, 5)).items.map((i: any) => i.label.label);
  assert.ok(comp.includes('empno') && comp.includes('on_change') && !comp.includes('deptno'));
  const comp2 = prov.provideCompletionItems(d, new mock.Position(3, 6)).items.map((i: any) => i.label.label);
  assert.ok(comp2.includes('load_emps'));

  const r = at('src/legacy.c', 'int counter = a + 1', 'counter');
  const hl = prov.provideDocumentHighlights(r.d, r.pos);
  assert.strictEqual(hl.length, 3);
  const edit = prov.provideRenameEdits(r.d, r.pos, 'cnt');
  assert.strictEqual(edit.edits.length, 3);

  const st = new SemanticTokens(mgr).provideDocumentSemanticTokens(doc('src/emp.pc'));
  assert.ok(st.data.length > 50);
});

test('호버/자동완성: 정의에 붙은 주석과 구조체 멤버 주석', () => {
  index.setFile(indexFile(path.join(FIX, 'include/docs.h'), { encoding: 'auto', fallback: 'cp949' }, 1 << 30));
  const d = mock.makeDoc(
    path.join(FIX, 'src/docuse.c'),
    '#include "docs.h"\nint t(void)\n{\n    DeptInfo di;\n    di.no = find_dept(1, &di);\n    di.\n    return MAX_DNAME;\n}\n',
  );
  const hoverAt = (line: number, word: string) => {
    const col = d.lineAt(line).text.indexOf(word) + 1;
    return prov.provideHover(d, new mock.Position(line, col)).contents.value as string;
  };
  const h1 = hoverAt(3, 'DeptInfo');
  assert.ok(h1.includes('부서 정보  \n본부/팀 단위'), 'typedef 에 주석이 없으면 구조체 주석');
  assert.ok(h1.includes('int no;  // 부서번호'));
  assert.ok(h1.includes('char dname[MAX_DNAME];  // 부서명'));
  assert.ok(hoverAt(4, 'find_dept').includes('부서 조회  \nno: 부서번호'));
  assert.ok(hoverAt(6, 'MAX_DNAME').includes('최대 부서명 길이'));
  const items = prov.provideCompletionItems(d, new mock.Position(5, 7)).items;
  assert.strictEqual(items.find((i: any) => i.label.label === 'no').documentation, '부서번호');
});
