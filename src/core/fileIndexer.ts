import * as fs from 'fs';
import { TextDecoder } from 'util';
import { parseSource } from './parser';
import { FileIndex } from './types';

export interface EncodingOptions {
  /** 'auto' = 올바른 UTF-8 이면 UTF-8, 아니면 fallback. 그 외 값이면 항상 그 인코딩 */
  encoding: string;
  fallback: string;
}

export const DEFAULT_ENCODING: EncodingOptions = { encoding: 'auto', fallback: 'cp949' };

const CP949_LABELS = new Set(['cp949', 'windows949', 'windows-949', 'euc-kr', 'euckr', 'uhc', 'ks_c_5601-1987', 'korean']);

const decoders = new Map<string, TextDecoder>();

function decoder(enc: string, fatal: boolean): TextDecoder {
  const key = enc + (fatal ? '!' : '');
  let d = decoders.get(key);
  if (!d) {
    try {
      d = new TextDecoder(enc, { fatal });
    } catch {
      d = new TextDecoder('latin1');
    }
    decoders.set(key, d);
  }
  return d;
}

/** KS X 1001 에 정의된 행 (ICU 'euc-kr' 이 디코딩하는 범위) */
function isStdLead(b: number): boolean {
  return (b >= 0xa1 && b <= 0xac) || (b >= 0xb0 && b <= 0xc8) || (b >= 0xca && b <= 0xfd);
}

/**
 * CP949 디코딩.
 * Node/Electron 의 ICU 'euc-kr' 은 순수 EUC-KR 이라 CP949 확장 문자(똠=8C63, 갂=8141 ...)의
 * 첫 바이트를 버리고 둘째 바이트를 ASCII 로 내보낸다 (똠 -> "c").
 * 그래서 표준 EUC-KR 구간만 ICU 로 디코딩하고, 확장 문자/깨진 바이트는 한 글자(U+FFFD)로 바꿔
 * VSCode(windows949)에서 보는 것과 같은 컬럼 위치를 유지한다. 식별자는 ASCII 라 영향 없음.
 */
export function decodeCp949(buf: Uint8Array): string {
  const kr = decoder('euc-kr', false);
  const n = buf.length;
  let parts: string[] | undefined;
  let runStart = 0;
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    const t = i + 1 < n ? buf[i + 1] : -1;
    if (isStdLead(b) && t >= 0xa1 && t <= 0xfe) {
      i += 2;
      continue;
    }
    (parts ??= []).push(kr.decode(buf.subarray(runStart, i)));
    parts.push('�');
    const ext = b >= 0x81 && b <= 0xfe && ((t >= 0x41 && t <= 0x5a) || (t >= 0x61 && t <= 0x7a) || (t >= 0x81 && t <= 0xfe));
    i += ext ? 2 : 1;
    runStart = i;
  }
  if (!parts) return kr.decode(buf);
  parts.push(kr.decode(buf.subarray(runStart)));
  return parts.join('');
}

function decodeAs(buf: Uint8Array, enc: string): string {
  if (CP949_LABELS.has(enc.toLowerCase())) return decodeCp949(buf);
  return decoder(enc, false).decode(buf);
}

/**
 * 파일 바이트 -> 문자열.
 * auto: UTF-8 검증에 실패하면(한글 EUC-KR 바이트가 나오는 즉시) fallback 으로 디코딩.
 * 검증 비용은 파싱 시간의 수 % 수준이라 무시할 만하다.
 */
export function decode(buf: Uint8Array, opts: EncodingOptions = DEFAULT_ENCODING): string {
  if (opts.encoding && opts.encoding !== 'auto') return decodeAs(buf, opts.encoding);
  try {
    return decoder('utf-8', true).decode(buf);
  } catch {
    return decodeAs(buf, opts.fallback || 'cp949');
  }
}

export function indexText(path: string, text: string, mtime = 0, size = 0): FileIndex {
  const r = parseSource(text);
  return { path, mtime, size, defs: r.defs, names: r.names, refs: r.refs, includes: r.includes };
}

export function indexFile(path: string, enc: EncodingOptions, maxSize: number): FileIndex {
  const st = fs.statSync(path);
  if (st.size > maxSize) {
    return { path, mtime: st.mtimeMs, size: st.size, defs: [], names: [], refs: new Int32Array(0), includes: [] };
  }
  const text = decode(fs.readFileSync(path), enc);
  return indexText(path, text, st.mtimeMs, st.size);
}
