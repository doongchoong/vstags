import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../core/lexer';
import { Simulator } from './interp';
import { AUTO_LEN, isCharType, Obj, Ptr, UNKNOWN } from './memory';
import { prepareTokens, SimParser } from './parser';

/**
 * 변수값 스냅샷: 한 함수에서 쓰던 변수값을 이름 붙여 저장해 두었다가, 시뮬레이션 중에 한 번에 덮어쓴다.
 * 줄 번호는 저장하지 않는다 (코드가 바뀌어도 함수 이름 + 변수 경로로 다시 찾음).
 *   values: { "n": "0", "rec->empno": "7369", "h_ename": "\"KIM\"", "list->items[0].sal": "800" }
 * 값 형식은 입력 상자와 같다 (10, -1.5, 'A', "문자열", NULL).
 */
export interface Snapshot {
  name: string;
  function: string;
  /** 저장할 때의 파일 (참고용) */
  file?: string;
  saved: string;
  values: Record<string, string>;
}

const MAX_DEPTH = 6;
const MAX_ELEMS = 200;

function cstr(o: Obj): string | undefined {
  if (o.type.k !== 'array') return undefined;
  const n = o.type.len === AUTO_LEN ? (o.elems?.length ?? 0) : o.type.len;
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = o.elems?.[i]?.v;
    if (typeof c !== 'number') return undefined;
    if (c === 0) return s;
    s += String.fromCharCode(c);
  }
  return undefined;
}

/** 프레임(함수)에서 지금 아는 값들을 경로별로 모은다. 모르는 값(?)은 넣지 않는다 */
export function collectValues(frame: Simulator): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (o: Obj, p: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const t = o.type;
    switch (t.k) {
      case 'int':
      case 'float':
        if (typeof o.v === 'number') out[p] = String(o.v);
        return;
      case 'ptr': {
        if (o.v === null) {
          out[p] = 'NULL';
          return;
        }
        if (!o.v || o.v === UNKNOWN) return;
        const target = o.v as Ptr;
        // 모르는 포인터를 위해 만든 대상만 따라간다 (다른 변수를 가리키면 그 변수 쪽에 이미 저장됨)
        if (target.base.autoOf === undefined || target.index !== 0) return;
        if (isCharType(t.to)) {
          const s = cstr(target.base);
          if (s !== undefined) out[p] = JSON.stringify(s);
          return;
        }
        (target.base.elems ?? []).forEach((e, i) => e && i < MAX_ELEMS && visit(e, `${p}[${i}]`, depth + 1));
        return;
      }
      case 'array': {
        if (isCharType(t.of)) {
          const s = cstr(o);
          if (s !== undefined) out[p] = JSON.stringify(s);
          return;
        }
        (o.elems ?? []).forEach((e, i) => e && i < MAX_ELEMS && visit(e, `${p}[${i}]`, depth + 1));
        return;
      }
      case 'struct': {
        if (t.name === 'VARCHAR') {
          // 내용을 다 알면 문자열 하나로, 아니면 아는 멤버(len 등)만 따로
          const len = o.fields?.get('len')?.v;
          const arr = o.fields?.get('arr');
          let s: string | undefined = typeof len === 'number' && arr ? '' : undefined;
          for (let i = 0; s !== undefined && i < (len as number); i++) {
            const c = arr!.elems?.[i]?.v;
            s = typeof c === 'number' ? s + String.fromCharCode(c) : undefined;
          }
          if (s !== undefined) {
            out[p] = JSON.stringify(s);
            return;
          }
        }
        for (const [name, f] of o.fields ?? []) visit(f, `${p}.${name}`, depth + 1);
        return;
      }
    }
  };
  for (const [name, o] of frame.visibleVars()) visit(o, name, 0);
  return out;
}

/** 경로 하나에 값 넣기. char* 에 "문자열" 이면 가리키는 버퍼에 쓴다 */
export function applyValue(frame: Simulator, p: string, text: string): void {
  const e = new SimParser(prepareTokens(p, lex(p)), frame.world).parseExpr();
  const o = frame.lvalue(e);
  if (o.type.k === 'ptr' && isCharType(o.type.to) && /^".*"$/s.test(text.trim())) {
    const s = JSON.parse(text.trim()) as string;
    frame.writeCStr(frame.strRefOf(e), s);
    frame.mem.commit();
    return;
  }
  frame.setUserValue(o, text);
}

/** 스냅샷 값을 프레임에 덮어쓴다 */
export function applyValues(
  frame: Simulator,
  values: Record<string, string>,
  onApplied?: (path: string, text: string) => void,
): { applied: string[]; failed: { path: string; reason: string }[] } {
  const applied: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const [p, text] of Object.entries(values)) {
    try {
      applyValue(frame, p, text);
      applied.push(p);
      onApplied?.(p, text);
    } catch (err) {
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, failed };
}

// ───────────── 파일 저장소: <root>/.vstags/snapshots/<함수>/<이름>.json ─────────────

export function snapshotDir(root: string): string {
  return path.join(root, '.vstags', 'snapshots');
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || '_';

export function snapshotPath(root: string, fn: string, name: string): string {
  return path.join(snapshotDir(root), safe(fn), `${safe(name)}.json`);
}

export function saveSnapshot(root: string, s: Snapshot): string {
  const file = snapshotPath(root, s.function, s.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', 'utf8');
  return file;
}

/** 저장된 스냅샷 전부 (파일 경로 포함). 깨진 파일은 건너뜀 */
export function listSnapshots(root: string): (Snapshot & { path: string })[] {
  const dir = snapshotDir(root);
  const out: (Snapshot & { path: string })[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const fnDir of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!fnDir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, fnDir.name))) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, fnDir.name, f);
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8')) as Snapshot;
        if (s && typeof s.values === 'object') out.push({ ...s, name: s.name ?? f.slice(0, -5), function: s.function ?? fnDir.name, path: p });
      } catch {
        /* 깨진 파일 */
      }
    }
  }
  return out.sort((a, b) => a.function.localeCompare(b.function) || a.name.localeCompare(b.name));
}
