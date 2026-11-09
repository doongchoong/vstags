/* require('vscode') 를 테스트용 목으로 돌린다. 다른 import 보다 먼저 불러야 함. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return require.resolve('./vscodeMock');
  return origResolve.call(this, request, ...rest);
};
