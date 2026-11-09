/* IndexManager 동기화 동작 (vscode 목 사용) */
/* eslint-disable @typescript-eslint/no-explicit-any */
import './useMock';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';

/* eslint-disable @typescript-eslint/no-var-requires */
const mock = require('./vscodeMock');
const { IndexManager } = require('../vscode/indexManager');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('파일 감시 이벤트 없이 바뀐 파일도 창 포커스 시 반영 (네트워크 드라이브 시나리오)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-'));
  const a = path.join(root, 'a.c');
  fs.writeFileSync(a, 'int old_fn(void) { return 0; }\n');
  fs.writeFileSync(path.join(root, 'b.pc'), 'int other(void) { return old_fn(); }\n');
  mock.workspace._root = root;
  const ctx = { storageUri: mock.Uri.file(path.join(root, '.store')), globalStorageUri: mock.Uri.file(path.join(root, '.gstore')) };
  const mgr = new IndexManager(ctx);
  await mgr.start();
  assert.strictEqual(mgr.index.definitions('old_fn').length, 1);

  // 다른 개발자가 수정 (감시 이벤트 없음). mtime 이 확실히 바뀌도록 잠시 대기
  await sleep(20);
  fs.writeFileSync(a, 'int new_fn(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'c.h'), '#define ADDED 1\n');
  fs.unlinkSync(path.join(root, 'b.pc'));

  // 10초 이내 재포커스는 무시
  mock.events.windowState.fire({ focused: true });
  await sleep(50);
  assert.strictEqual(mgr.index.definitions('new_fn').length, 0, '스로틀 동안은 동기화 안 함');

  // 스로틀 경과로 간주
  (mgr as any).lastSyncAt = 1;
  const calls = mock.workspace.findFilesCalls;
  mock.events.windowState.fire({ focused: false });
  mock.events.windowState.fire({ focused: true });
  mock.events.windowState.fire({ focused: true }); // 동시에 여러 번 와도 한 번만
  await (mgr as any).quietSync;
  assert.strictEqual(mock.workspace.findFilesCalls - calls, 1, '중복 포커스 이벤트는 합쳐짐');
  assert.strictEqual(mgr.index.definitions('old_fn').length, 0);
  assert.strictEqual(mgr.index.definitions('new_fn').length, 1);
  assert.strictEqual(mgr.index.definitions('ADDED').length, 1);
  assert.strictEqual(mgr.index.definitions('other').length, 0, '삭제된 파일 제거');
  assert.deepStrictEqual({ files: mgr.lastBuild.files, removed: mgr.lastBuild.removed }, { files: 2, removed: 1 });

  // 수동 Sync: 변경 없으면 재색인 0
  await mgr.sync();
  assert.strictEqual(mgr.lastBuild.files, 0);

  // 재시작: 캐시에서 로드 후 변경 없음
  mgr.dispose();
  const mgr2 = new IndexManager(ctx);
  await mgr2.start();
  assert.strictEqual(mgr2.index.definitions('new_fn').length, 1);
  assert.strictEqual(mgr2.lastBuild.files, 0, '캐시가 최신이면 재색인 없음');
  mgr2.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test('파일 감시 이벤트로 즉시 반영', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vstags-'));
  const a = path.join(root, 'w.c');
  fs.writeFileSync(a, 'int before(void) { return 0; }\n');
  mock.workspace._root = root;
  const mgr = new IndexManager({ storageUri: mock.Uri.file(path.join(root, '.store')), globalStorageUri: mock.Uri.file(root) });
  await mgr.start();
  fs.writeFileSync(a, 'int after(void) { return 0; }\n');
  mock.events.watcherChange.fire(mock.Uri.file(a));
  await sleep(700); // 400ms 디바운스 + 색인
  assert.strictEqual(mgr.index.definitions('after').length, 1);
  assert.strictEqual(mgr.index.definitions('before').length, 0);
  await mgr.save(); // 5초 뒤 예약된 저장을 바로 실행 (임시 폴더 삭제 전)
  mgr.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
