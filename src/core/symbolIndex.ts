import * as path from 'path';
import { Def, DefHit, DefKind, FileIndex, REF_STRIDE, RefFlag, RefHit, SCOPED_KINDS } from './types';

/** 실제 정의 (선언이 아닌 것) */
export const DEFINITION_KINDS: ReadonlySet<DefKind> = new Set<DefKind>([
  'function', 'macro', 'struct', 'union', 'enum', 'enumerator', 'typedef', 'variable', 'cursor',
]);
export const DECLARATION_KINDS: ReadonlySet<DefKind> = new Set<DefKind>(['prototype', 'extern']);
export const CALLABLE_KINDS: ReadonlySet<DefKind> = new Set<DefKind>(['function', 'macro', 'prototype']);

export interface CallerGroup {
  file: FileIndex;
  /** 호출을 감싸는 함수/매크로/전역변수. 파일 최상위면 undefined */
  from?: DefHit;
  hits: RefHit[];
}

export interface CalleeGroup {
  name: string;
  hits: RefHit[];
}

/**
 * 메모리 상의 심볼 색인.
 *  - defsByName: 이름 -> 정의 목록 (지역 변수/파라미터/레이블 제외)
 *  - refFiles:   이름 -> 그 이름을 참조하는 파일 집합 (역색인). 실제 위치는 파일별 refs 배열을 스캔.
 */
export class SymbolIndex {
  private readonly files = new Map<string, FileIndex>();
  private readonly defsByName = new Map<string, DefHit[]>();
  private readonly membersByContainer = new Map<string, DefHit[]>();
  private readonly refFiles = new Map<string, Set<FileIndex>>();
  private readonly nameMaps = new WeakMap<FileIndex, Map<string, number>>();
  private readonly shadowMaps = new WeakMap<FileIndex, Map<number, Set<string>>>();
  /** 변경될 때마다 증가 */
  version = 0;

  get fileCount(): number {
    return this.files.size;
  }

  stats(): { files: number; defs: number; refs: number; names: number } {
    let defs = 0;
    let refs = 0;
    for (const f of this.files.values()) {
      defs += f.defs.length;
      refs += f.refs.length / REF_STRIDE;
    }
    return { files: this.files.size, defs, refs, names: this.refFiles.size };
  }

  allFiles(): IterableIterator<FileIndex> {
    return this.files.values();
  }

  getFile(p: string): FileIndex | undefined {
    return this.files.get(p);
  }

  clear(): void {
    this.files.clear();
    this.defsByName.clear();
    this.membersByContainer.clear();
    this.refFiles.clear();
    this.version++;
  }

  setFile(fi: FileIndex): void {
    const old = this.files.get(fi.path);
    if (old) this.unlink(old);
    this.files.set(fi.path, fi);
    for (let i = 0; i < fi.defs.length; i++) {
      const d = fi.defs[i];
      if (SCOPED_KINDS.has(d.kind)) continue;
      const hit: DefHit = { file: fi, def: d, index: i };
      push(this.defsByName, d.name, hit);
      if ((d.kind === 'member' || d.kind === 'enumerator') && d.container) push(this.membersByContainer, d.container, hit);
    }
    for (const n of fi.names) {
      let s = this.refFiles.get(n);
      if (!s) this.refFiles.set(n, (s = new Set()));
      s.add(fi);
    }
    this.version++;
  }

  removeFile(p: string): void {
    const old = this.files.get(p);
    if (!old) return;
    this.unlink(old);
    this.files.delete(p);
    this.version++;
  }

  private unlink(fi: FileIndex): void {
    for (const d of fi.defs) {
      if (SCOPED_KINDS.has(d.kind)) continue;
      pull(this.defsByName, d.name, fi);
      if (d.container) pull(this.membersByContainer, d.container, fi);
    }
    for (const n of fi.names) {
      const s = this.refFiles.get(n);
      if (!s) continue;
      s.delete(fi);
      if (!s.size) this.refFiles.delete(n);
    }
  }

  // ───────────────────────── definitions ─────────────────────────

  definitions(name: string): DefHit[] {
    return this.defsByName.get(name) ?? [];
  }

  /**
   * 정의로 이동할 후보를 우선순위대로 고른다.
   *   1) 현재 파일의 정의
   *   2) 다른 파일의 non-static 정의
   *   3) 다른 파일의 static 정의
   *   4) 선언 (prototype / extern)
   * 가장 높은 순위의 그룹만 반환한다.
   */
  rankedDefinitions(name: string, fromPath: string | undefined, kinds?: ReadonlySet<DefKind>, excludePath?: string): DefHit[] {
    const all = this.definitions(name).filter(
      (h) => h.def.kind !== 'member' && (!kinds || kinds.has(h.def.kind)) && h.file.path !== excludePath,
    );
    const tiers: DefHit[][] = [[], [], [], []];
    for (const h of all) {
      const k = h.def.kind;
      const same = h.file.path === fromPath;
      if (k === 'cursor' && !same) continue; // Pro*C 커서는 파일 범위
      if (DEFINITION_KINDS.has(k)) {
        if (same) tiers[0].push(h);
        else if (h.def.isStatic) tiers[2].push(h);
        else tiers[1].push(h);
      } else if (DECLARATION_KINDS.has(k)) {
        tiers[3].push(h);
      }
    }
    return tiers.find((t) => t.length) ?? [];
  }

  declarations(name: string): DefHit[] {
    return this.definitions(name).filter((h) => DECLARATION_KINDS.has(h.def.kind));
  }

  members(container: string): DefHit[] {
    return this.membersByContainer.get(container) ?? [];
  }

  /** typedef 사슬을 따라가 최종 타입(구조체 태그) 이름을 얻는다 */
  resolveType(type: string | undefined): string | undefined {
    let t = type;
    for (let i = 0; t && i < 8; i++) {
      if (this.membersByContainer.has(t)) return t;
      const td = this.definitions(t).find((h) => h.def.kind === 'typedef');
      if (!td || !td.def.type || td.def.type === t) return t;
      t = td.def.type;
    }
    return t;
  }

  /**
   * `a.b->c` 처럼 멤버 접근 경로의 타입을 따라가서 마지막 멤버의 후보를 찾는다.
   * @param baseType chain[0] 변수의 타입 (지역 변수면 호출자가 알려줌)
   * @param chain    [a, b] (마지막 멤버 c 를 제외한 경로)
   * @param member   c
   */
  resolveMember(baseType: string | undefined, chain: string[], member: string): DefHit[] {
    let type = baseType;
    if (!type && chain.length) {
      const v = this.definitions(chain[0]).find((h) => h.def.kind === 'variable' || h.def.kind === 'extern');
      type = v?.def.type;
    }
    type = this.resolveType(type);
    for (let i = 1; type && i < chain.length; i++) {
      const m = this.members(type).find((h) => h.def.name === chain[i]);
      type = this.resolveType(m?.def.type);
    }
    const all = this.definitions(member).filter((h) => h.def.kind === 'member');
    if (type) {
      const exact = all.filter((h) => h.def.container === type);
      if (exact.length) return exact;
    }
    return all;
  }

  // ───────────────────────── references ─────────────────────────

  private nameMap(fi: FileIndex): Map<string, number> {
    let m = this.nameMaps.get(fi);
    if (!m) {
      m = new Map();
      for (let i = 0; i < fi.names.length; i++) m.set(fi.names[i], i);
      this.nameMaps.set(fi, m);
    }
    return m;
  }

  /** 함수(scope) 별 지역 변수/파라미터 이름 집합 */
  private shadowMap(fi: FileIndex): Map<number, Set<string>> {
    let m = this.shadowMaps.get(fi);
    if (!m) {
      m = new Map();
      for (const d of fi.defs) {
        if ((d.kind === 'local' || d.kind === 'param') && d.scope !== undefined) {
          let s = m.get(d.scope);
          if (!s) m.set(d.scope, (s = new Set()));
          s.add(d.name);
        }
      }
      this.shadowMaps.set(fi, m);
    }
    return m;
  }

  /** 함수 fnIdx 안에서 name 이 지역 변수/파라미터로 가려지는지 */
  isShadowed(fi: FileIndex, fnIdx: number, name: string): boolean {
    return fnIdx >= 0 && !!this.shadowMap(fi).get(fnIdx)?.has(name);
  }

  /** 한 파일에서 name 의 참조 */
  fileRefs(fi: FileIndex, name: string, filter?: (flags: number, enclosing: number) => boolean): RefHit[] {
    const ni = this.nameMap(fi).get(name);
    if (ni === undefined) return [];
    const out: RefHit[] = [];
    const r = fi.refs;
    for (let k = 0; k < r.length; k += REF_STRIDE) {
      if (r[k] !== ni) continue;
      const flags = r[k + 3];
      const enc = r[k + 4];
      if (filter && !filter(flags, enc)) continue;
      out.push({ file: fi, name, line: r[k + 1], col: r[k + 2], flags, enclosing: enc });
    }
    return out;
  }

  /**
   * 전역 심볼 name 의 모든 참조.
   * @param overrides 저장 안 된 문서처럼 색인 대신 사용할 FileIndex (path 기준)
   */
  references(
    name: string,
    opts: { filter?: (flags: number) => boolean; excludeShadowed?: boolean; overrides?: Map<string, FileIndex> } = {},
  ): RefHit[] {
    const out: RefHit[] = [];
    const seen = new Set<string>();
    const visit = (fi: FileIndex) => {
      if (seen.has(fi.path)) return;
      seen.add(fi.path);
      const use = opts.overrides?.get(fi.path) ?? fi;
      out.push(
        ...this.fileRefs(use, name, (flags, enc) => {
          if (opts.filter && !opts.filter(flags)) return false;
          if (opts.excludeShadowed && this.isShadowed(use, enc, name)) return false;
          return true;
        }),
      );
    };
    if (opts.overrides) for (const fi of opts.overrides.values()) visit(fi);
    for (const fi of this.refFiles.get(name) ?? []) visit(fi);
    return out;
  }

  /**
   * name 을 호출하는 곳들을 감싸는 함수별로 묶어서 반환 (Call Hierarchy incoming).
   * includePointerRefs: 호출이 아닌 단순 언급(함수 포인터 등록 등)도 포함
   */
  callers(name: string, includePointerRefs: boolean, overrides?: Map<string, FileIndex>): CallerGroup[] {
    const hits = this.references(name, {
      excludeShadowed: true,
      overrides,
      filter: (f) =>
        !(f & RefFlag.Member) && !(f & RefFlag.PP) && (!!(f & RefFlag.Call) || (includePointerRefs && !(f & RefFlag.Write))),
    });
    const groups = new Map<string, CallerGroup>();
    for (const h of hits) {
      const key = h.file.path + '#' + h.enclosing;
      let g = groups.get(key);
      if (!g) {
        const d = h.enclosing >= 0 ? h.file.defs[h.enclosing] : undefined;
        g = { file: h.file, from: d ? { file: h.file, def: d, index: h.enclosing } : undefined, hits: [] };
        groups.set(key, g);
      }
      g.hits.push(h);
    }
    return [...groups.values()];
  }

  /** 함수 fnIdx 가 호출하는 이름들 (Call Hierarchy outgoing) */
  callees(fi: FileIndex, fnIdx: number): CalleeGroup[] {
    const groups = new Map<string, RefHit[]>();
    const r = fi.refs;
    for (let k = 0; k < r.length; k += REF_STRIDE) {
      if (r[k + 4] !== fnIdx) continue;
      const flags = r[k + 3];
      if (!(flags & RefFlag.Call) || flags & RefFlag.Member) continue;
      const name = fi.names[r[k]];
      if (this.isShadowed(fi, fnIdx, name)) continue; // 함수 포인터 파라미터 호출
      let g = groups.get(name);
      if (!g) groups.set(name, (g = []));
      g.push({ file: fi, name, line: r[k + 1], col: r[k + 2], flags, enclosing: fnIdx });
    }
    return [...groups].map(([name, hits]) => ({ name, hits }));
  }

  /** 주어진 파일 이름(basename)을 #include / EXEC SQL INCLUDE 하는 파일들 */
  includers(fileName: string): FileIndex[] {
    const base = path.basename(fileName).toLowerCase();
    const stem = base.replace(/\.[^.]*$/, '');
    const out: FileIndex[] = [];
    for (const fi of this.files.values()) {
      if (fi.includes.some((inc) => {
        const b = path.basename(inc.replace(/\\/g, '/')).toLowerCase();
        return b === base || b === stem; // EXEC SQL INCLUDE sqlca;  (확장자 생략)
      })) out.push(fi);
    }
    return out;
  }

  /** include 이름으로 색인된 파일 찾기 (#include "x.h" 정의 이동용) */
  findFilesByName(inc: string): FileIndex[] {
    const norm = inc.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(norm);
    const out: FileIndex[] = [];
    for (const fi of this.files.values()) {
      const p = fi.path.replace(/\\/g, '/').toLowerCase();
      if (p.endsWith('/' + norm) || path.basename(p) === base || path.basename(p) === base + '.h') out.push(fi);
    }
    // 경로가 더 많이 일치하는 것 우선
    return out.sort((a, b) => Number(b.path.replace(/\\/g, '/').toLowerCase().endsWith('/' + norm)) - Number(a.path.replace(/\\/g, '/').toLowerCase().endsWith('/' + norm)));
  }

  // ───────────────────────── search ─────────────────────────

  /**
   * 이름 검색 (Ctrl+T / 태그 검색).
   * 점수: 정확히 일치 < 접두사 < 부분 문자열 < 서브시퀀스(퍼지)
   */
  search(query: string, limit: number, kinds?: ReadonlySet<DefKind>): DefHit[] {
    const q = query.toLowerCase();
    if (!q) return [];
    const scored: { h: DefHit; s: number }[] = [];
    for (const [name, hits] of this.defsByName) {
      const s = matchScore(name, q);
      if (s < 0) continue;
      for (const h of hits) {
        if (kinds) {
          if (!kinds.has(h.def.kind)) continue;
        } else if (h.def.kind === 'member' && s > 1) {
          continue; // 구조체 멤버는 정확/접두사 일치일 때만 (너무 많음)
        }
        scored.push({ h, s: s * 10 + (DECLARATION_KINDS.has(h.def.kind) ? 1 : 0) });
      }
    }
    scored.sort((a, b) => a.s - b.s || a.h.def.name.length - b.h.def.name.length || (a.h.def.name < b.h.def.name ? -1 : 1));
    return scored.slice(0, limit).map((x) => x.h);
  }

  /** 접두사로 시작하는 이름 (자동완성) */
  namesWithPrefix(prefix: string, limit: number): DefHit[] {
    const out: DefHit[] = [];
    const lp = prefix.toLowerCase();
    for (const [name, hits] of this.defsByName) {
      if (!name.toLowerCase().startsWith(lp)) continue;
      const best = hits.find((h) => DEFINITION_KINDS.has(h.def.kind)) ?? hits[0];
      if (best.def.kind === 'member') continue;
      out.push(best);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function pull(m: Map<string, DefHit[]>, k: string, fi: FileIndex): void {
  const a = m.get(k);
  if (!a) return;
  const b = a.filter((h) => h.file !== fi);
  if (b.length) m.set(k, b);
  else m.delete(k);
}

function matchScore(name: string, q: string): number {
  const ln = name.toLowerCase();
  if (ln === q) return 0;
  if (ln.startsWith(q)) return 1;
  if (ln.includes(q)) return 2;
  let j = 0;
  for (let i = 0; i < ln.length && j < q.length; i++) if (ln[i] === q[j]) j++;
  return j === q.length ? 3 : -1;
}

/** 파일 안에서 줄 위치를 감싸는 함수 정의 인덱스 */
export function enclosingFunction(defs: Def[], line: number): number {
  let best = -1;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (d.kind !== 'function' || d.endLine === undefined) continue;
    if (d.line <= line && line <= d.endLine) best = i;
  }
  return best;
}
