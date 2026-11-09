/* package.json 이 기여하는 JSON 파일 검증 + Pro*C TextMate 문법 토큰화 (VSCode 와 같은 vscode-textmate 엔진) */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import * as onig from 'vscode-oniguruma';
import * as tm from 'vscode-textmate';

const ROOT = path.resolve(__dirname, '../..');
const GRAMMARS = path.join(ROOT, 'node_modules/tm-grammars/grammars');

test('기여 JSON 파일이 모두 엄격한 JSON 으로 파싱됨', () => {
  // VSCode 는 문법 파일을 JSON.parse 로 읽는다. 잘못된 이스케이프(\s, \d)가 있으면 문법 전체가 로드되지 않는다.
  for (const f of ['package.json', 'language-configuration.json', 'syntaxes/proc.tmLanguage.json']) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  }
  const lc = JSON.parse(fs.readFileSync(path.join(ROOT, 'language-configuration.json'), 'utf8'));
  assert.strictEqual(new RegExp(lc.wordPattern).exec('  h_empno->x')![0], 'h_empno');
});

async function tokenize(file: string): Promise<{ line: number; text: string; scopes: string[] }[]> {
  const wasm = fs.readFileSync(path.join(ROOT, 'node_modules/vscode-oniguruma/release/onig.wasm'));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const files: Record<string, string> = {
    'source.proc': path.join(ROOT, 'syntaxes/proc.tmLanguage.json'),
    'source.c': path.join(GRAMMARS, 'c.json'),
    'source.sql': path.join(GRAMMARS, 'sql.json'),
  };
  const reg = new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s: string[]) => new onig.OnigScanner(s),
      createOnigString: (s: string) => new onig.OnigString(s),
    }),
    loadGrammar: async (scope: string) => (files[scope] ? tm.parseRawGrammar(fs.readFileSync(files[scope], 'utf8'), files[scope]) : null),
  });
  const g = (await reg.loadGrammar('source.proc'))!;
  let st = tm.INITIAL;
  const out: { line: number; text: string; scopes: string[] }[] = [];
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const r = g.tokenizeLine(line, st);
      st = r.ruleStack;
      for (const t of r.tokens) {
        const text = line.slice(t.startIndex, t.endIndex);
        if (text.trim()) out.push({ line: i + 1, text: text.trim(), scopes: t.scopes });
      }
    });
  return out;
}

test('Pro*C 문법: 주석/EXEC SQL/호스트 변수/PL/SQL 블록', async () => {
  const toks = await tokenize(path.join(ROOT, 'test-fixtures/src/emp.pc'));
  const find = (line: number, text: string) => {
    const t = toks.find((x) => x.line === line && x.text === text);
    assert.ok(t, `token '${text}' on line ${line}; have: ${toks.filter((x) => x.line === line).map((x) => x.text).join(' | ')}`);
    return t!.scopes.join(' ');
  };
  // 1행: /* emp.pc - Pro*C 샘플 */
  assert.match(find(1, '/*'), /^source\.proc comment\.block/);
  assert.match(find(1, 'emp.pc - Pro*C 샘플'), /comment\.block/);
  // EXEC SQL INCLUDE sqlca;
  assert.match(find(5, 'EXEC'), /keyword\.control\.directive\.proc/);
  assert.match(find(5, 'INCLUDE'), /meta\.embedded\.block\.sql/);
  // 선언부 C 코드는 C 로
  assert.match(find(10, 'int'), /storage\.type/);
  // 커서 선언 안의 SQL 주석과 문자열 속 세미콜론
  assert.match(find(29, ':'), /punctuation\.definition\.variable\.proc/);
  assert.match(find(29, 'h_empno'), /variable\.other\.host\.proc/);
  assert.match(find(30, 'Brien;'), /string/); // 문자열 안의 ';' 에서 문장이 끝나지 않음
  assert.match(find(30, ';'), /punctuation\.terminator\.statement\.proc/);
  // EXEC SQL 이 끝난 뒤 함수 정의는 다시 C
  assert.doesNotMatch(find(32, 'int'), /meta\.embedded\.block\.sql/);
  // 함수 안 FETCH 의 호스트 변수
  assert.match(find(44, 'h_sal'), /meta\.block\.c .*variable\.other\.host\.proc/);
  // PL/SQL 블록: END; 에서 끝나지 않고 END-EXEC; 까지 SQL
  assert.match(find(65, 'END'), /meta\.embedded\.block\.sql/);
  assert.match(find(65, ';'), /meta\.embedded\.block\.sql/);
  assert.match(find(66, 'END-EXEC'), /keyword\.control\.directive\.proc/);
  assert.doesNotMatch(find(68, 'return'), /meta\.embedded\.block\.sql/);
});

test('Pro*C 문법: 동적 SQL EXECUTE 와 한 줄 PL/SQL 블록', async () => {
  const toks = await tokenize(path.join(ROOT, 'test-fixtures/src/emp.pc'));
  const line = (n: number) => toks.filter((x) => x.line === n);
  const at = (n: number, text: string, i = 0) => line(n).filter((x) => x.text === text)[i].scopes.join(' ');
  // EXEC SQL EXECUTE stmt1 USING :h_empno;  -> 일반 EXEC SQL, 첫 ';' 에서 끝
  assert.match(at(85, ';'), /punctuation\.terminator\.statement\.proc/);
  assert.doesNotMatch(at(86, 'EXEC'), /meta\.embedded\.block\.sql/);
  // 한 줄 PL/SQL: 중간의 'END;' 가 아니라 END-EXEC; 에서 끝
  assert.match(at(86, 'END'), /meta\.embedded\.block\.sql/);
  assert.match(at(86, ';', 0), /meta\.embedded\.block\.sql/); // 'END;' 의 ';'
  assert.match(at(86, ';', 1), /punctuation\.terminator\.statement\.proc/); // END-EXEC 뒤 ';'
  assert.match(at(86, 'END-EXEC'), /keyword\.control\.directive\.proc/);
  assert.doesNotMatch(at(87, 'return'), /meta\.embedded\.block\.sql/);
});
