import { parentPort } from 'worker_threads';
import { EncodingOptions, indexFile } from './fileIndexer';
import { FileIndex } from './types';

export interface WorkRequest {
  id: number;
  paths: string[];
  enc: EncodingOptions;
  maxSize: number;
}

export interface WorkResponse {
  id: number;
  results: FileIndex[];
  errors: { path: string; message: string }[];
}

parentPort?.on('message', (req: WorkRequest) => {
  const results: FileIndex[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const p of req.paths) {
    try {
      results.push(indexFile(p, req.enc, req.maxSize));
    } catch (e) {
      errors.push({ path: p, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const transfer = results.map((r) => r.refs.buffer as ArrayBuffer);
  parentPort!.postMessage({ id: req.id, results, errors } satisfies WorkResponse, transfer);
});
