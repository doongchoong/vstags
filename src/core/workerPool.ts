import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { EncodingOptions, indexFile } from './fileIndexer';
import { FileIndex } from './types';
import type { WorkRequest, WorkResponse } from './worker';

export interface IndexOptions {
  enc: EncodingOptions;
  maxSize: number;
  workers: number;
}

export interface IndexProgress {
  done: number;
  total: number;
}

const CHUNK = 64;

/**
 * 워커 스레드로 파일들을 병렬 색인한다. 결과는 도착하는 대로 onResult 로 전달.
 * 워커를 만들 수 없는 환경이면 현재 스레드에서 순차 처리한다.
 */
export async function indexFiles(
  paths: string[],
  opts: IndexOptions,
  onResult: (fi: FileIndex) => void,
  onProgress?: (p: IndexProgress) => void,
  isCancelled?: () => boolean,
): Promise<{ errors: { path: string; message: string }[] }> {
  const errors: { path: string; message: string }[] = [];
  const total = paths.length;
  let done = 0;
  if (!total) return { errors };

  const n = Math.max(1, Math.min(opts.workers > 0 ? opts.workers : Math.max(1, os.cpus().length - 1), 16, Math.ceil(total / CHUNK)));

  if (total < 32) {
    for (const p of paths) {
      if (isCancelled?.()) break;
      try {
        onResult(indexFile(p, opts.enc, opts.maxSize));
      } catch (e) {
        errors.push({ path: p, message: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.({ done: ++done, total });
    }
    return { errors };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < total; i += CHUNK) chunks.push(paths.slice(i, i + CHUNK));
  let next = 0;
  let reqId = 0;
  const workerFile = path.join(__dirname, 'worker.js');

  await Promise.all(
    Array.from({ length: n }, async () => {
      let w: Worker;
      try {
        w = new Worker(workerFile);
      } catch {
        // 워커 생성 실패 시 메인 스레드에서 처리
        while (next < chunks.length && !isCancelled?.()) {
          for (const p of chunks[next++]) {
            try {
              onResult(indexFile(p, opts.enc, opts.maxSize));
            } catch (e) {
              errors.push({ path: p, message: e instanceof Error ? e.message : String(e) });
            }
            onProgress?.({ done: ++done, total });
          }
        }
        return;
      }
      try {
        while (next < chunks.length && !isCancelled?.()) {
          const chunk = chunks[next++];
          const req: WorkRequest = { id: ++reqId, paths: chunk, enc: opts.enc, maxSize: opts.maxSize };
          const res = await new Promise<WorkResponse>((resolve, reject) => {
            const onMsg = (m: WorkResponse) => {
              if (m.id !== req.id) return;
              w.off('message', onMsg);
              w.off('error', onErr);
              resolve(m);
            };
            const onErr = (e: Error) => {
              w.off('message', onMsg);
              reject(e);
            };
            w.on('message', onMsg);
            w.once('error', onErr);
            w.postMessage(req);
          });
          for (const r of res.results) onResult(r);
          errors.push(...res.errors);
          done += chunk.length;
          onProgress?.({ done, total });
        }
      } finally {
        await w.terminate();
      }
    }),
  );
  return { errors };
}
