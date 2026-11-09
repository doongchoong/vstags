import { Stmt } from './ast';

/** 시뮬레이션할 문장 고르기: 선택 범위 / 커서부터 함수 끝까지 */

export function childLists(s: Stmt): Stmt[][] {
  const asList = (x: Stmt | undefined): Stmt[] => (!x ? [] : x.k === 'block' ? x.body : [x]);
  switch (s.k) {
    case 'block':
      return [s.body];
    case 'if':
      return [asList(s.t), asList(s.f)];
    case 'while':
    case 'do':
    case 'for':
    case 'switch':
    case 'case':
    case 'label':
      return [asList(s.body)];
    default:
      return [];
  }
}

/** 선택 범위 [a, b] 에 걸친 문장들. 선택이 한 문장 안쪽에만 있으면 그 안으로 들어간다 */
export function selectStatements(list: Stmt[], a: number, b: number): Stmt[] {
  const hit = list.map((s, i) => [s, i] as const).filter(([s]) => s.endLine >= a && s.line <= b);
  if (!hit.length) return [];
  if (hit.length === 1) {
    const [s] = hit[0];
    if (s.line < a || s.endLine > b) {
      for (const child of childLists(s)) {
        const r = selectStatements(child, a, b);
        if (r.length) return r;
      }
    }
  }
  return list.slice(hit[0][1], hit[hit.length - 1][1] + 1);
}

/**
 * 커서 줄부터 함수 끝까지 실행할 문장들.
 *   안쪽 블록의 나머지 -> (반복문 안이면) 그 반복을 이어서 -> 바깥 블록의 나머지 -> ... -> 함수 끝
 * 커서가 빈 줄/주석이면 그 다음 문장부터.
 */
export function continuationFrom(list: Stmt[], line: number): Stmt[] {
  const idx = list.findIndex((s) => s.endLine >= line);
  if (idx < 0) return [];
  const s = list[idx];
  if (s.line < line) {
    for (const child of childLists(s)) {
      // 커서가 반복문/if 머리 줄에 있으면 그 문장부터
      if (!child.length || line < child[0].line) continue;
      const inner = continuationFrom(child, line);
      if (!inner.length) continue;
      const pos = { id: s.id, line: inner[0].line, endLine: s.endLine };
      const head: Stmt =
        s.k === 'for' || s.k === 'while' || s.k === 'do' || s.k === 'switch'
          ? { k: 'resume', loop: s, rest: inner, ...pos }
          : { k: 'block', body: inner, ...pos };
      return [head, ...list.slice(idx + 1)];
    }
  }
  return list.slice(idx);
}

