import { ReturnAnswer, SimEvent, Simulator } from './interp';
import { applyValue } from './snapshot';

/**
 * 뒤로 가기(Step Back)용 입력 기록.
 * 시뮬레이터는 같은 입력이면 항상 같은 결과가 나오므로, 상태 대신 "몇 번째 이벤트에서 사용자가 무엇을 했는지"만 남긴다.
 * 뒤로 갈 때는 처음부터 다시 실행하면서 기록을 그대로 적용하고, 목표 위치에서 멈춘다.
 */

export type Action =
  /** 값 필요(need)로 멈춘 곳에서 입력한 값 */
  | { k: 'need'; text: string }
  /** 변수 창/조사식에서 바꾼 값 (depth 번째 프레임에서 path 로 다시 찾음) */
  | { k: 'set'; depth: number; path: string; text: string }
  | { k: 'skip' }
  | { k: 'jump'; line: number }
  | { k: 'stepIn' }
  | { k: 'return'; choice: ReturnChoice; value?: number; text?: string; fn: string }
  | { k: 'sqlcode'; code: number }
  | { k: 'cond'; v: boolean };

/** 반환값 질문에서 고를 수 있는 것 */
export type ReturnChoice = 'enter' | 'value' | 'zero' | 'always' | 'str' | 'null' | 'new' | 'later';

/** 고른 것 -> 시뮬레이터에 줄 답 */
export function returnAnswer(choice: Exclude<ReturnChoice, 'enter'>, value?: number, text?: string): ReturnAnswer {
  switch (choice) {
    case 'value':
      return { value: value ?? 0, havoc: true };
    case 'str':
      return { value: 0, as: 'str', str: text ?? '', havoc: true };
    case 'null':
      return { value: 0, as: 'null', havoc: false };
    case 'new':
      return { value: 0, as: 'new', havoc: false };
    case 'later':
    case 'always':
      return { value: 0, as: 'unknown', havoc: false };
    default:
      return { value: 0, havoc: false };
  }
}

/** 지나온 문장 위치 */
export interface StepMark {
  at: number;
  line: number;
  file: string;
  depth: number;
}

export class Journal {
  actions: { at: number; a: Action }[] = [];
  steps: StepMark[] = [];
  /** 마지막으로 받은 이벤트 번호 (0부터) */
  index = -1;

  onEvent(ev: SimEvent): void {
    this.index++;
    if (ev.k === 'step') this.steps.push({ at: this.index, line: ev.line, file: ev.file, depth: ev.depth });
  }

  record(a: Action): void {
    this.actions.push({ at: this.index, a });
  }

  /** 지금보다 앞의 문장 중 마지막 것 (pred 를 만족하는 것이 없으면 맨 처음 문장) */
  target(pred?: (s: StepMark) => boolean): StepMark | undefined {
    const prev = this.steps.filter((s) => s.at < this.index);
    const hit = pred ? prev.filter(pred) : prev;
    return hit.length ? hit[hit.length - 1] : prev[0];
  }

  /** at 번째 이벤트로 되돌아간 뒤: 그 이후의 기록은 버린다 */
  truncate(at: number): void {
    this.actions = this.actions.filter((x) => x.at < at);
    this.steps = this.steps.filter((s) => s.at <= at);
    this.index = at;
  }
}

/** 기록된 입력 하나를 (다시 만든) 시뮬레이터에 적용 */
export function applyAction(sim: Simulator, ev: SimEvent, a: Action): void {
  switch (a.k) {
    case 'need':
      if (ev.k === 'need') sim.setUserValue(ev.obj, a.text);
      return;
    case 'set':
      applyValue(sim.frames()[a.depth] ?? sim.innermost(), a.path, a.text);
      return;
    case 'skip':
      sim.requestSkip();
      return;
    case 'jump':
      sim.requestJump(a.line);
      return;
    case 'stepIn':
      sim.armStepIn();
      return;
    case 'return':
      if (ev.k !== 'ask' || ev.q.kind !== 'return') return;
      if (a.choice === 'enter') sim.requestEnter(ev.q.id);
      else {
        if (a.choice === 'always') sim.ignoredFns.add(a.fn);
        sim.provideReturn(ev.q.id, returnAnswer(a.choice, a.value, a.text));
      }
      return;
    case 'sqlcode':
      sim.provideSqlcode(a.code);
      return;
    case 'cond':
      if (ev.k === 'ask' && ev.q.kind === 'cond') sim.provideCond(ev.q.id, a.v);
      return;
  }
}

/**
 * 새로 만든 시뮬레이터를 기록대로 target 번째 이벤트까지 조용히(출력 없이, 묻지 않고) 진행.
 * 기록과 다르게 흘러가서 target 전에 끝나면 실패.
 */
export function replay(
  sim: Simulator,
  gen: Generator<SimEvent, string, void>,
  journal: Journal,
  target: number,
): { ok: true; ev: SimEvent } | { ok: false; reason: string } {
  let ai = 0;
  const actions = journal.actions.filter((x) => x.at < target);
  for (let idx = 0; ; idx++) {
    const r = gen.next();
    sim.takeOutput();
    if (r.done) return { ok: false, reason: `되돌리는 도중 시뮬레이션이 끝났습니다 (${r.value}). 소스가 바뀌었나요?` };
    if (idx === target) return { ok: true, ev: r.value };
    while (ai < actions.length && actions[ai].at === idx) {
      try {
        applyAction(sim, r.value, actions[ai].a);
      } catch {
        /* 다시 적용할 수 없는 입력은 건너뜀 */
      }
      ai++;
    }
  }
}
