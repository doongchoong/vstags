import { Tk, Token } from './lexer';

/**
 * 조건부 컴파일(#if/#ifdef/#else/#endif) 정리.
 *
 * 실제 매크로 값을 모르므로 모든 분기를 따라가는 것이 기본이지만, 그러면 아래처럼
 * 분기마다 여는 괄호가 하나씩 있는 코드에서 중괄호 깊이가 꼬인다.
 *
 *   #ifdef A
 *       if (a) {
 *   #else
 *       if (b) {
 *   #endif
 *
 * 규칙 (ctags 와 비슷한 방식):
 *   - `#if 0` 분기는 버리고, `#if 1` 이후의 형제 분기는 버린다.
 *   - 남은 분기가 모두 "균형"(중괄호/소괄호 증감 0, 문장 경계에서 끝남)이면 모두 유지.
 *   - 하나라도 균형이 아니면 첫 번째 분기만 유지.
 * 지시문 토큰 자체는 항상 유지한다 (#ifdef FOO 의 FOO 참조 기록용).
 */

interface Branch {
  head: Token[];
  body: Item[];
}
interface Cond {
  branches: Branch[];
  tail: Token[];
}
type Item = Token | Cond;

const BOUNDARY = new Set([';', '}', '{', ',', ':']);

/**
 * @param firstBranchOnly true 면 균형 여부와 관계없이 항상 한 분기만 따라간다 (시뮬레이터용:
 *        양쪽 분기를 다 실행하면 같은 변수에 두 번 대입하는 식이 되므로).
 */
export function filterConditionals(toks: Token[], firstBranchOnly = false): Token[] {
  let p = 0;
  const N = toks.length;

  const readDirective = (): Token[] => {
    const out: Token[] = [];
    while (p < N) {
      const t = toks[p++];
      out.push(t);
      if (t.k === Tk.PPEnd) break;
    }
    return out;
  };

  const parseItems = (inCond: boolean): Item[] => {
    const items: Item[] = [];
    while (p < N) {
      const t = toks[p];
      if (t.k === Tk.PPStart) {
        const name = t.v;
        if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
          items.push(parseCond());
          continue;
        }
        if (name === 'elif' || name === 'else' || name === 'endif') {
          if (inCond) return items;
          readDirective(); // 짝 없는 지시문은 버림
          continue;
        }
      }
      items.push(t);
      p++;
    }
    return items;
  };

  const parseCond = (): Cond => {
    const branches: Branch[] = [];
    let head = readDirective();
    for (;;) {
      const body = parseItems(true);
      branches.push({ head, body });
      if (p >= N) return { branches, tail: [] };
      const d = readDirective();
      if (d[0].v === 'endif') return { branches, tail: d };
      head = d;
    }
  };

  const items = parseItems(false);
  const out: Token[] = [];
  flatten(items, out, firstBranchOnly);
  return out;
}

function flatten(items: Item[], out: Token[], firstOnly: boolean): void {
  for (const it of items) {
    if ('k' in it) out.push(it);
    else flattenCond(it, out, firstOnly);
  }
}

/** #if 0 / #if 1 / #elif 0 같은 리터럴 조건 판정. 0 => false, 1 => true, 그 외 undefined */
function literalCond(head: Token[]): boolean | undefined {
  const name = head[0].v;
  if (name !== 'if' && name !== 'elif') return undefined;
  const body = head.filter((t) => t.k !== Tk.PPStart && t.k !== Tk.PPEnd);
  if (body.length === 1 && body[0].k === Tk.Number) {
    if (/^0+[uUlL]*$/.test(body[0].v)) return false;
    if (/^[1-9]\d*[uUlL]*$/.test(body[0].v)) return true;
  }
  return undefined;
}

function isBalanced(toks: Token[]): boolean {
  let brace = 0;
  let paren = 0;
  let last: Token | undefined;
  let inPP = false;
  for (const t of toks) {
    if (t.k === Tk.PPStart) {
      inPP = true;
      continue;
    }
    if (t.k === Tk.PPEnd) {
      inPP = false;
      continue;
    }
    if (inPP) continue;
    last = t;
    if (t.k !== Tk.Punct) continue;
    if (t.v === '{') brace++;
    else if (t.v === '}') brace--;
    else if (t.v === '(') paren++;
    else if (t.v === ')') paren--;
  }
  if (brace !== 0 || paren !== 0) return false;
  if (!last) return true;
  if (last.k === Tk.SqlStmt) return true;
  return last.k === Tk.Punct && BOUNDARY.has(last.v);
}

function flattenCond(c: Cond, out: Token[], firstOnly: boolean): void {
  const n = c.branches.length;
  const keep: boolean[] = new Array(n).fill(false);
  const bodies: Token[][] = [];
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = c.branches[i];
    const flat: Token[] = [];
    flatten(b.body, flat, firstOnly);
    bodies.push(flat);
    const lit = literalCond(b.head);
    if (lit === false) continue;
    candidates.push(i);
    if (lit === true) break;
  }
  if (!firstOnly && (candidates.length <= 1 || candidates.every((i) => isBalanced(bodies[i])))) {
    for (const i of candidates) keep[i] = true;
  } else if (candidates.length) {
    keep[candidates[0]] = true;
  }
  for (let i = 0; i < n; i++) {
    for (const t of c.branches[i].head) out.push(t);
    if (keep[i]) for (const t of bodies[i]) out.push(t);
  }
  for (const t of c.tail) out.push(t);
}
