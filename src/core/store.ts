import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { FileIndex } from './types';

/**
 * vstags 전용 태그 파일 포맷 (gzip 된 JSON Lines).
 *   1행: {"format":"vstags","version":N,...}
 *   이후: 파일 하나당 한 줄 {path, mtime, size, defs, names, includes, refs(base64 Int32Array)}
 * 파서가 바뀌면 FORMAT_VERSION 을 올려서 전체 재색인을 유도한다.
 */
export const FORMAT_VERSION = 5;

export async function saveIndex(file: string, files: Iterable<FileIndex>): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gz.on('error', reject);
  });
  gz.pipe(out);
  const write = async (s: string) => {
    if (!gz.write(s + '\n')) await new Promise<void>((r) => gz.once('drain', () => r()));
  };
  await write(JSON.stringify({ format: 'vstags', version: FORMAT_VERSION, created: Date.now() }));
  for (const fi of files) {
    const refs = Buffer.from(fi.refs.buffer, fi.refs.byteOffset, fi.refs.byteLength).toString('base64');
    await write(JSON.stringify({ path: fi.path, mtime: fi.mtime, size: fi.size, defs: fi.defs, names: fi.names, includes: fi.includes, refs }));
  }
  gz.end();
  await done;
  await fs.promises.rename(tmp, file);
}

export async function loadIndex(file: string): Promise<FileIndex[] | null> {
  try {
    await fs.promises.access(file);
  } catch {
    return null;
  }
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const out: FileIndex[] = [];
  let first = true;
  try {
    for await (const line of rl) {
      if (!line) continue;
      const o = JSON.parse(line);
      if (first) {
        first = false;
        if (o.format !== 'vstags' || o.version !== FORMAT_VERSION) {
          rl.close();
          input.destroy();
          return null;
        }
        continue;
      }
      const b = Buffer.from(o.refs, 'base64');
      const refs = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      out.push({ path: o.path, mtime: o.mtime, size: o.size, defs: o.defs, names: o.names, includes: o.includes, refs });
    }
  } catch {
    return null; // 손상된 파일 -> 재색인
  }
  return out;
}
