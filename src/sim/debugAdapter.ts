import * as path from 'path';
import * as vscode from 'vscode';
import { lex } from '../core/lexer';
import { SymbolIndex } from '../core/symbolIndex';
import { Expr } from './ast';
import { AskSignal, fmtRV, formatObj, Question, SimEvent, Simulator } from './interp';
import { AUTO_LEN, isCharType, NeedValue, Obj, Ptr, typeName, Unsupported, UNKNOWN } from './memory';
import { prepareTokens, SimParser } from './parser';
import { Journal, replay, returnAnswer, ReturnChoice } from './journal';
import { buildSimulator, SimOptions } from './session';
import { applyValues, collectValues } from './snapshot';

/**
 * 블록 시뮬레이터를 VSCode 디버거 UI 로 보여주는 인라인 Debug Adapter (DAP 를 직접 구현).
 *  - 변수 창: 블록에서 쓰는 변수 (? = 모르는 값). 더블클릭으로 값 입력
 *  - F10/F11: 한 문장씩, F5: 중단점/값 필요/질문까지 진행
 *  - 모르는 값이 필요하면 예외처럼 멈추고 입력 상자를 띄움
 */

interface Req {
  seq: number;
  type: string;
  command: string;
  arguments?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface SimLaunchArgs {
  file: string;
  startLine: number;
  endLine: number;
}

type Mode = 'entry' | 'step' | 'continue' | 'out' | 'jump';

/** 입력 상자에서 '건너뛰기' 를 고름 */
const SKIP_INPUT: unique symbol = Symbol('skip-input');
const SKIP_ITEM = { label: '$(debug-step-over) 이 문장 건너뛰기', id: 'skip', description: '값을 정하지 않고 이 문장을 실행하지 않고 넘어감' };

/** 변수 창 참조 번호: 1 = 시작 함수, 1000+깊이 = 호출된 함수, 2 = sqlca */
const frameRef = (depth: number) => (depth === 0 ? 1 : 1000 + depth);
const refDepth = (ref: number) => (ref === 1 ? 0 : ref >= 1000 && ref < 2000 ? ref - 1000 : -1);

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

export class SimDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private seq = 1;
  private sim?: Simulator;
  private gen?: Generator<SimEvent, string, void>;
  private title = '';
  private readonly breakpoints = new Map<string, Set<number>>();
  private running = false;
  private pauseRequested = false;
  private lastMode: 'step' | 'continue' | 'out' = 'step';
  /** Shift+F11: 이 깊이 이하로 돌아오면 멈춤 */
  private outDepth = -1;
  private stopInfo: { text: string; description: string } | undefined;
  private readonly refs = new Map<number, Obj>();
  private readonly refOf = new Map<Obj, number>();
  private nextRef = 100;
  private terminated = false;
  /** 뒤로 가기용: 입력 기록과 지나온 문장 */
  private journal = new Journal();
  /** 뒤로 가기용: 처음부터 다시 만들 때 쓰는 시작 정보 (시작 시점의 소스) */
  private launchInfo?: { args: SimLaunchArgs; src: string; opts: SimOptions };
  /** 변수 창 객체가 속한 프레임 깊이 (값 입력을 기록할 때 프레임을 알기 위해) */
  private readonly objDepth = new WeakMap<Obj, number>();

  constructor(private readonly getIndex: () => SymbolIndex) {}

  dispose(): void {
    this.emitter.dispose();
  }

  handleMessage(m: vscode.DebugProtocolMessage): void {
    const r = m as unknown as Req;
    if (r.type !== 'request') return;
    this.dispatch(r).catch((e: unknown) => this.respond(r, undefined, e instanceof Error ? e.message : String(e)));
  }

  // ───────────── DAP 송신 ─────────────

  private send(m: object): void {
    this.emitter.fire({ seq: this.seq++, ...m } as unknown as vscode.DebugProtocolMessage);
  }
  private respond(r: Req, body?: object, error?: string): void {
    this.send({ type: 'response', request_seq: r.seq, command: r.command, success: !error, message: error, body });
  }
  private event(event: string, body?: object): void {
    this.send({ type: 'event', event, body });
  }
  private out(s: string): void {
    this.event('output', { category: 'console', output: s + '\n' });
  }

  // ───────────── 요청 처리 ─────────────

  private async dispatch(r: Req): Promise<void> {
    const a = r.arguments ?? {};
    switch (r.command) {
      case 'initialize':
        this.respond(r, {
          supportsConfigurationDoneRequest: true,
          supportsSetVariable: true,
          supportsSetExpression: true,
          supportsEvaluateForHovers: true,
          supportsExceptionInfoRequest: true,
          supportsTerminateRequest: true,
          supportsGotoTargetsRequest: true,
          supportsStepBack: true,
        });
        this.event('initialized');
        return;
      case 'launch': {
        const args = a as SimLaunchArgs;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(args.file));
        const ignore = vscode.workspace.getConfiguration('vstags').get<string[]>('simulator.ignore', []);
        const readSource = (p: string) => vscode.workspace.textDocuments.find((d) => norm(d.uri.fsPath) === norm(p))?.getText();
        const src = doc.getText();
        const cfg = vscode.workspace.getConfiguration('vstags');
        const logFunctions = cfg.get<Record<string, string>>('simulator.logFunctions', {});
        const types = cfg.get<Record<string, string>>('simulator.types', {});
        const opts: SimOptions = { ignore, logFunctions, types, readSource };
        const setup = buildSimulator(this.getIndex(), args.file, src, args.startLine, args.endLine, opts);
        this.launchInfo = { args, src, opts };
        this.sim = setup.sim;
        this.gen = setup.sim.run();
        this.title = `${setup.fnName} (${setup.fromLine + 1}~${setup.toLine + 1}행)`;
        this.respond(r);
        this.out(`▶ 블록 시뮬레이션: ${this.title}`);
        this.out('  모르는 값이 필요하면 멈춥니다. 입력 상자나 변수 창/조사식에 값을 넣고 계속하세요 (예: 10  -1.5  \'A\'  "ABC"  NULL).');
        return;
      }
      case 'setBreakpoints': {
        const lines: number[] = (a.breakpoints ?? []).map((b: { line: number }) => b.line);
        if (a.source?.path) this.breakpoints.set(norm(a.source.path), new Set(lines.map((l) => l - 1)));
        this.respond(r, { breakpoints: lines.map((line) => ({ verified: true, line })) });
        return;
      }
      case 'configurationDone':
        this.respond(r);
        void this.run('entry');
        return;
      case 'threads':
        this.respond(r, { threads: [{ id: 1, name: '블록' }] });
        return;
      case 'stackTrace': {
        const frames = this.sim ? this.sim.frames().reverse() : [];
        this.respond(r, {
          stackFrames: frames.map((f) => ({
            id: f.depth + 1,
            name: f.depth === 0 ? this.title : `${f.world.funcName}()`,
            source: { name: path.basename(f.world.filePath), path: f.world.filePath },
            line: f.line + 1,
            column: 1,
          })),
          totalFrames: frames.length,
        });
        return;
      }
      case 'scopes': {
        const depth = Math.max(0, (a.frameId ?? 1) - 1);
        this.respond(r, {
          scopes: [
            { name: depth === 0 ? '블록 변수' : '변수', variablesReference: frameRef(depth), expensive: false },
            { name: 'sqlca', variablesReference: 2, expensive: false },
          ],
        });
        return;
      }
      case 'variables':
        this.respond(r, { variables: this.variables(a.variablesReference) });
        return;
      case 'setVariable': {
        const o = this.findChild(a.variablesReference, a.name);
        if (!o || !this.sim) throw new Error(`변수 '${a.name}' 를 찾지 못했습니다`);
        const frame = this.frameSim(a.variablesReference);
        frame.setUserValue(o, String(a.value));
        this.journal.record({ k: 'set', depth: this.objDepth.get(o) ?? frame.depth, path: o.path, text: String(a.value) });
        this.respond(r, { value: formatObj(o), type: typeName(o.type), variablesReference: this.childRef(o) });
        return;
      }
      case 'evaluate':
        this.respond(r, this.evaluate(String(a.expression), a.context, a.frameId));
        return;
      case 'setExpression': {
        if (!this.sim) throw new Error('시뮬레이션이 실행 중이 아닙니다');
        const fs = this.frameById(a.frameId);
        const o = fs.lvalue(this.parse(String(a.expression)));
        fs.setUserValue(o, String(a.value));
        this.journal.record({ k: 'set', depth: fs.depth, path: o.path, text: String(a.value) });
        this.respond(r, { value: formatObj(o), type: typeName(o.type), variablesReference: this.childRef(o) });
        return;
      }
      case 'continue':
        this.respond(r, { allThreadsContinued: true });
        void this.run('continue');
        return;
      case 'next':
        this.respond(r);
        void this.run('step');
        return;
      case 'stepIn':
        // F11: 이 문장에서 처음 만나는 사용자 함수 호출로 들어간다 (없으면 F10 과 같음)
        this.sim?.armStepIn();
        this.journal.record({ k: 'stepIn' });
        this.respond(r);
        void this.run('step');
        return;
      case 'stepOut': {
        // Shift+F11: 지금 함수가 끝나서 호출한 쪽으로 돌아오면 멈춤
        const depth = this.sim ? this.sim.innermost().depth : 0;
        this.respond(r);
        this.outDepth = depth - 1;
        void this.run(depth > 0 ? 'out' : 'continue');
        return;
      }
      case 'pause':
        this.pauseRequested = true;
        this.respond(r);
        return;
      case 'exceptionInfo':
        this.respond(r, { exceptionId: this.stopInfo?.text ?? '', description: this.stopInfo?.description ?? '', breakMode: 'always' });
        return;
      case 'gotoTargets': {
        // VSCode 의 'Jump to Cursor': 지금 실행 중인 함수 안의 줄이면 이동 가능
        const scope = this.sim?.jumpScope();
        const line = Number(a.line);
        const ok = !!scope && !!a.source?.path && norm(a.source.path) === norm(scope.file) && line - 1 >= scope.from && line - 1 <= scope.to;
        this.respond(r, { targets: ok ? [{ id: line, label: `${line}행으로 건너뛰기`, line }] : [] });
        return;
      }
      case 'goto':
        this.jumpTo(r, Number(a.targetId) - 1);
        return;
      case 'vstagsJump':
        this.jumpTo(r, Number(a.line));
        return;
      case 'stepBack':
      case 'reverseContinue':
        this.respond(r);
        this.stepBack(r.command === 'reverseContinue');
        return;
      case 'vstagsSnapshotCollect': {
        // 변수값 스냅샷 저장: 지금 실행 중인(가장 안쪽) 함수의 아는 값들
        if (!this.sim || this.running) throw new Error('시뮬레이션이 멈춰 있을 때만 저장할 수 있습니다');
        const f = this.sim.innermost();
        this.respond(r, { function: f.world.funcName, file: f.world.filePath, values: collectValues(f) });
        return;
      }
      case 'vstagsSnapshotApply': {
        // 변수값 스냅샷 적용: 지금 함수의 변수에 덮어쓰기 (뒤로 가기 기록에도 남김)
        if (!this.sim || this.running) throw new Error('시뮬레이션이 멈춰 있을 때만 적용할 수 있습니다');
        const f = this.sim.innermost();
        const res = applyValues(f, (a.values ?? {}) as Record<string, string>, (path, text) =>
          this.journal.record({ k: 'set', depth: f.depth, path, text }),
        );
        this.out(`⇣ 변수값 적용 '${a.name ?? ''}': ${res.applied.length}개${res.failed.length ? `, 적용 못 함 ${res.failed.length}개 (${res.failed.map((x) => x.path).join(', ')})` : ''}`);
        this.event('invalidated', { areas: ['variables'], threadId: 1 });
        this.respond(r, res);
        return;
      }
      case 'vstagsSkip':
        this.sim?.requestSkip();
        this.journal.record({ k: 'skip' });
        this.respond(r);
        void this.run(this.lastMode);
        return;
      case 'disconnect':
      case 'terminate':
        this.respond(r);
        this.terminate();
        return;
      default:
        this.respond(r);
    }
  }

  // ───────────── 실행 ─────────────

  /** 커서까지 건너뛰기: 그 사이 코드는 실행하지 않고 line(0-based) 에서 멈춘다 */
  private jumpTo(r: Req, line: number): void {
    if (!this.sim || this.terminated) throw new Error('시뮬레이션이 실행 중이 아닙니다');
    this.sim.requestJump(line); // 범위 밖이면 오류 메시지로 응답
    this.journal.record({ k: 'jump', line });
    this.respond(r);
    void this.run('jump');
  }

  /**
   * 뒤로 한 단계 (reverseContinue 면 이전 중단점까지, 없으면 처음).
   * 처음부터 새로 만들어서 기록된 입력대로 조용히 다시 실행하고 목표 문장에서 멈춘다.
   */
  private stepBack(toBreakpoint: boolean): void {
    if (!this.sim || !this.launchInfo || this.running || this.terminated) return;
    const t = this.journal.target(toBreakpoint ? (m) => !!this.breakpoints.get(norm(m.file))?.has(m.line) : undefined);
    if (!t) {
      this.out('↶ 더 되돌아갈 곳이 없습니다 (처음 위치)');
      return this.stop('step');
    }
    const { args, src, opts } = this.launchInfo;
    let setup;
    try {
      setup = buildSimulator(this.getIndex(), args.file, src, args.startLine, args.endLine, opts);
    } catch (e) {
      this.out(`↶ 되돌리기 실패: ${e instanceof Error ? e.message : e}`);
      return this.stop('step');
    }
    const gen = setup.sim.run();
    const res = replay(setup.sim, gen, this.journal, t.at);
    if (!res.ok) {
      this.out(`↶ ${res.reason}`);
      return this.stop('step');
    }
    this.sim = setup.sim;
    this.gen = gen;
    this.journal.truncate(t.at);
    this.refs.clear();
    this.refOf.clear();
    this.outDepth = -1;
    this.out(`↶ ${path.basename(t.file)} ${t.line + 1}행으로 되돌아감`);
    this.stop('step');
  }

  private async run(mode: Mode): Promise<void> {
    if (!this.gen || !this.sim || this.running || this.terminated) return;
    this.running = true;
    if (mode !== 'entry') {
      if (mode !== 'jump') this.lastMode = mode;
      this.event('continued', { threadId: 1, allThreadsContinued: true });
    }
    try {
      for (;;) {
        const r = this.gen.next();
        this.flush();
        if (r.done) {
          this.out(`■ ${r.value}`);
          this.terminate();
          return;
        }
        const ev = r.value;
        this.journal.onEvent(ev);
        if (ev.k === 'step') {
          if (mode === 'entry' || mode === 'step' || mode === 'jump') return this.stop(mode === 'step' ? 'step' : mode === 'jump' ? 'goto' : 'entry');
          if (mode === 'out' && ev.depth <= this.outDepth) return this.stop('step');
          if (this.breakpoints.get(norm(ev.file))?.has(ev.line)) return this.stop('breakpoint');
          if (this.pauseRequested) {
            this.pauseRequested = false;
            return this.stop('pause');
          }
          continue;
        }
        if (ev.k === 'ask') {
          if (await this.answer(ev.q)) continue;
          return this.stop('exception', '입력 필요', `${describe(ev.q)} — 계속(F5/F10)하면 다시 묻습니다`);
        }
        if (ev.k === 'need') {
          this.stop('exception', '값 필요', `${ev.msg} — 변수 창/조사식에서 값을 넣고 계속(F5/F10)`);
          void this.promptNeed(ev.obj, ev.msg, mode);
          return;
        }
        this.stop('exception', '지원 안 됨', `${ev.msg} — 디버그 도구 모음의 '문장 건너뛰기' 로 넘어갈 수 있습니다`);
        void this.promptUnsupported(ev.msg, mode);
        return;
      }
    } catch (e) {
      this.out(`오류: ${e instanceof Error ? e.stack : e}`);
      this.terminate();
    } finally {
      this.running = false;
    }
  }

  private stop(reason: string, text?: string, description?: string): void {
    this.stopInfo = text ? { text, description: description ?? '' } : undefined;
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, text, description: text ? `${text}: ${description}` : undefined });
    // 변수값 모음 패널: 지금 함수의 스냅샷을 위에 보여주기 위해
    const f = this.sim?.innermost();
    if (f) this.event('vstagsFrame', { function: f.world.funcName, file: f.world.filePath });
  }

  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.event('terminated');
  }

  private flush(): void {
    for (const l of this.sim?.takeOutput() ?? []) this.out(l);
  }

  // ───────────── 사용자 입력 ─────────────

  /**
   * 값 입력 상자. 제목 줄의 ⤼ 버튼이나 'skip' 입력 = 이 문장 건너뛰기.
   * @returns 입력값, SKIP_INPUT, 또는 취소(Esc) 시 undefined
   */
  private askText(opts: { title: string; prompt: string; placeholder?: string; validate?: (s: string) => string | undefined }): Promise<string | typeof SKIP_INPUT | undefined> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      box.title = opts.title;
      box.prompt = opts.prompt + "   (⤼ 버튼 또는 'skip' = 이 문장 건너뛰기, Esc = 나중에)";
      box.placeholder = opts.placeholder ?? '';
      box.ignoreFocusOut = true;
      box.buttons = [{ iconPath: new vscode.ThemeIcon('debug-step-over'), tooltip: '이 문장 건너뛰기' }];
      let done = false;
      const finish = (v: string | typeof SKIP_INPUT | undefined) => {
        if (done) return;
        done = true;
        box.hide();
        box.dispose();
        resolve(v);
      };
      box.onDidTriggerButton(() => finish(SKIP_INPUT));
      box.onDidAccept(() => {
        const v = box.value.trim();
        if (v.toLowerCase() === 'skip') return finish(SKIP_INPUT);
        const err = opts.validate?.(v);
        if (err) {
          box.validationMessage = err;
          return;
        }
        finish(box.value);
      });
      box.onDidHide(() => finish(undefined));
      box.show();
    });
  }

  /** 건너뛰기를 요청하고 같은 방식으로 이어서 실행 */
  private skipAndResume(mode: Mode): void {
    if (!this.sim || this.terminated || this.running) return;
    this.sim.requestSkip();
    this.journal.record({ k: 'skip' });
    void this.run(mode === 'entry' ? 'step' : mode);
  }

  private async promptNeed(o: Obj, msg: string, mode: Mode): Promise<void> {
    const gen = this.gen;
    const v = await this.askText({
      title: `값 입력: ${o.path}`,
      prompt: `${msg}. 형식: 10  -1.5  'A'  "ABC"  NULL`,
      placeholder: typeName(o.type),
    });
    // 입력하는 동안 뒤로 가기 등으로 실행이 바뀌었으면 이 입력은 버린다
    if (v === undefined || !this.sim || this.terminated || this.running || this.gen !== gen) return;
    if (v === SKIP_INPUT) return this.skipAndResume(mode);
    try {
      this.sim.setUserValue(o, v);
      this.journal.record({ k: 'need', text: v });
    } catch (e) {
      void vscode.window.showErrorMessage(`vstags: ${e instanceof Error ? e.message : e}`);
      return this.promptNeed(o, msg, mode);
    }
    void this.run(mode === 'entry' ? 'step' : mode);
  }

  private async promptUnsupported(msg: string, mode: Mode): Promise<void> {
    const gen = this.gen;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(debug-step-over) 이 문장 건너뛰고 진행', id: 'skip' },
        { label: '$(debug-pause) 멈춘 상태로 두기', id: 'stay' },
      ],
      { title: `지원 안 됨: ${msg}`, ignoreFocusOut: true },
    );
    if (pick?.id === 'skip' && this.gen === gen) this.skipAndResume(mode);
  }

  /** 질문에 답했으면 true. 건너뛰기를 골라도 true (실행기가 문장을 건너뜀) */
  private async answer(q: Question): Promise<boolean> {
    const sim = this.sim!;
    switch (q.kind) {
      case 'return': {
        // 선언된 반환 타입에 맞는 선택지
        const items: { label: string; id: ReturnChoice | 'skip'; description?: string }[] = [];
        if (q.canEnter) items.push({ label: '$(debug-step-into) 함수 안으로 들어가기', id: 'enter', description: '넘긴 값/구조체가 이어지고 return 값이 돌아옴 (F11 과 같음)' });
        switch (q.ret) {
          case 'str':
            items.push(
              { label: '$(edit) 반환 문자열 입력…', id: 'str', description: '예: 정상 처리되었습니다' },
              { label: '나중에 (문자열이 쓰일 때 묻기)', id: 'later' },
              { label: 'NULL 반환', id: 'null' },
            );
            break;
          case 'ptr':
            items.push({ label: '새 대상 (멤버는 쓰일 때 묻기)', id: 'new' }, { label: 'NULL 반환', id: 'null' });
            break;
          case 'struct':
            items.push({ label: '새 값 (멤버는 쓰일 때 묻기)', id: 'new' });
            break;
          case 'void':
            items.push({ label: '그냥 진행 (반환값 없음)', id: 'zero' });
            break;
          case 'num':
            items.push(
              { label: '$(edit) 반환값 입력…', id: 'value', description: '인자로 넘긴 버퍼/포인터 대상은 ? 로 바뀝니다' },
              { label: '0 반환', id: 'zero', description: '부작용 없음' },
            );
            break;
          default:
            items.push(
              { label: '$(edit) 숫자 입력…', id: 'value' },
              { label: '$(edit) 문자열 입력…', id: 'str' },
              { label: 'NULL 반환', id: 'null' },
              { label: '0 반환 / 무시', id: 'zero' },
            );
        }
        items.push({ label: `$(mute) ${q.fn}() 는 이번 시뮬레이션 동안 항상 무시`, id: 'always', description: '로그/트레이스 함수, 매크로 안에서 반복 호출될 때' }, SKIP_ITEM as { label: string; id: 'skip'; description: string });
        const title = `시뮬레이션하지 않는 함수: ${q.call}` + (q.retType ? ` → ${q.retType}` : ' (선언을 찾지 못함)');
        const pick = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
        if (!pick) return false;
        const skip = () => {
          sim.requestSkip();
          this.journal.record({ k: 'skip' });
          return true;
        };
        if (pick.id === 'skip') return skip();
        if (pick.id === 'enter') {
          sim.requestEnter(q.id);
          this.journal.record({ k: 'return', choice: 'enter', fn: q.fn });
          return true;
        }
        let value: number | undefined;
        let text: string | undefined;
        if (pick.id === 'value') {
          const v = await this.askText({ title: `${q.fn}() 반환값`, prompt: '숫자', validate: (x) => (/^\s*-?\d+(\.\d+)?\s*$/.test(x) ? undefined : '숫자를 입력하세요') });
          if (v === undefined) return false;
          if (v === SKIP_INPUT) return skip();
          value = Number(v);
        } else if (pick.id === 'str') {
          const v = await this.askText({ title: `${q.fn}() 반환 문자열`, prompt: '문자열 (따옴표는 없어도 됨)' });
          if (v === undefined) return false;
          if (v === SKIP_INPUT) return skip();
          text = v;
        }
        if (pick.id === 'always') sim.ignoredFns.add(q.fn);
        sim.provideReturn(q.id, returnAnswer(pick.id, value, text));
        this.journal.record({ k: 'return', choice: pick.id, value, text, fn: q.fn });
        return true;
      }
      case 'sqlcode': {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '0', description: '정상 처리', code: 0 },
            { label: '1403', description: 'NOT FOUND (데이터 없음)', code: 1403 },
            { label: '-1', description: '오류 (SQLERROR)', code: -1 },
            { label: '$(edit) 직접 입력…', description: '', code: NaN },
            { ...SKIP_ITEM, code: NaN },
          ],
          { title: `SQL 결과 가정 (sqlca.sqlcode) — ${q.verb}`, placeHolder: q.sql.slice(0, 300), ignoreFocusOut: true },
        );
        if (!pick) return false;
        if ('id' in pick && pick.id === 'skip') {
          sim.requestSkip();
          this.journal.record({ k: 'skip' });
          return true;
        }
        let code = pick.code;
        if (Number.isNaN(code)) {
          const v = await this.askText({ title: 'sqlca.sqlcode', prompt: '정수', validate: (s) => (/^\s*-?\d+\s*$/.test(s) ? undefined : '정수를 입력하세요') });
          if (v === undefined) return false;
          if (v === SKIP_INPUT) {
            sim.requestSkip();
            this.journal.record({ k: 'skip' });
            return true;
          }
          code = Number(v);
        }
        sim.provideSqlcode(code);
        this.journal.record({ k: 'sqlcode', code });
        return true;
      }
      case 'cond': {
        const pick = await vscode.window.showQuickPick(
          [{ label: '참 (true)', v: true }, { label: '거짓 (false)', v: false }, { ...SKIP_ITEM, v: false }],
          { title: `조건을 계산할 수 없습니다: ${q.text}`, ignoreFocusOut: true },
        );
        if (!pick) return false;
        if ('id' in pick && pick.id === 'skip') {
          sim.requestSkip();
          this.journal.record({ k: 'skip' });
        } else {
          sim.provideCond(q.id, pick.v);
          this.journal.record({ k: 'cond', v: pick.v });
        }
        return true;
      }
    }
  }

  // ───────────── 변수 창 / 조사식 ─────────────

  private children(o: Obj): [string, Obj][] {
    const sim = this.sim!;
    if (o.type.k === 'struct') return sim.world.membersOf(o.type).map((m) => [m.name, sim.mem.field(o, m.name)]);
    if (o.type.k === 'array') {
      if (isCharType(o.type.of)) return [];
      const n = o.type.len === AUTO_LEN ? (o.elems?.length ?? 0) : Math.min(o.type.len, 200);
      const out: [string, Obj][] = [];
      for (let i = 0; i < n; i++) {
        if (o.type.len === AUTO_LEN && !o.elems?.[i]) continue;
        out.push([`[${i}]`, sim.mem.element(o, i)]);
      }
      return out;
    }
    if (o.type.k === 'ptr' && o.v && o.v !== UNKNOWN) {
      try {
        return [['*', sim.elemAt(o.v as Ptr, 0)]];
      } catch {
        return [];
      }
    }
    return [];
  }

  private childRef(o: Obj): number {
    const has =
      o.type.k === 'struct' ||
      (o.type.k === 'array' && !isCharType(o.type.of)) ||
      (o.type.k === 'ptr' && !!o.v && o.v !== UNKNOWN && (o.v as Ptr).base.type.k !== 'fn');
    if (!has) return 0;
    let id = this.refOf.get(o);
    if (!id) {
      id = this.nextRef++;
      this.refOf.set(o, id);
      this.refs.set(id, o);
    }
    return id;
  }

  private entry(name: string, o: Obj) {
    return { name, value: formatObj(o), type: typeName(o.type), variablesReference: this.childRef(o), evaluateName: o.path };
  }

  /** 프레임 번호(DAP frameId = 깊이+1)의 시뮬레이터. 없으면 가장 안쪽 */
  private frameById(frameId?: number): Simulator {
    const frames = this.sim!.frames();
    return (frameId !== undefined && frames[frameId - 1]) || frames[frames.length - 1];
  }

  /** 변수 창 참조 번호의 프레임 */
  private frameSim(ref: number): Simulator {
    const d = refDepth(ref);
    return (d >= 0 && this.sim!.frames()[d]) || this.sim!.innermost();
  }

  private variables(ref: number) {
    const sim = this.sim;
    if (!sim) return [];
    if (refDepth(ref) >= 0) {
      const d = refDepth(ref);
      const f = sim.frames()[d];
      return f ? f.visibleVars().map(([n, o]) => (this.objDepth.set(o, d), this.entry(n, o))) : [];
    }
    if (ref === 2) return this.children(sim.sqlca).map(([n, o]) => (this.objDepth.set(o, 0), this.entry(n, o)));
    const o = this.refs.get(ref);
    const d = o ? (this.objDepth.get(o) ?? 0) : 0;
    return o ? this.children(o).map(([n, c]) => (this.objDepth.set(c, d), this.entry(n, c))) : [];
  }

  private findChild(ref: number, name: string): Obj | undefined {
    const sim = this.sim;
    if (!sim) return undefined;
    if (refDepth(ref) >= 0) return sim.frames()[refDepth(ref)]?.visibleVars().find(([n]) => n === name)?.[1];
    const parent = ref === 2 ? sim.sqlca : this.refs.get(ref);
    return parent ? this.children(parent).find(([n]) => n === name)?.[1] : undefined;
  }

  private parse(text: string): Expr {
    if (!this.sim) throw new Error('시뮬레이션이 실행 중이 아닙니다');
    return new SimParser(prepareTokens(text, lex(text)), this.sim.world).parseExpr();
  }

  private evaluate(text: string, context?: string, frameId?: number) {
    if (!this.sim) return { result: '', variablesReference: 0 };
    const sim = this.frameById(frameId);
    let e: Expr;
    try {
      e = this.parse(text);
    } catch (err) {
      return { result: `해석할 수 없음: ${err instanceof Error ? err.message : err}`, variablesReference: 0 };
    }
    const mark = sim.mem.mark();
    try {
      if (e.k === 'ident' || e.k === 'member' || e.k === 'index' || (e.k === 'unary' && e.op === '*')) {
        const o = sim.lvalue(e);
        return { result: formatObj(o), type: typeName(o.type), variablesReference: this.childRef(o) };
      }
      const v = sim.eval(e);
      if (context === 'repl') sim.mem.commit();
      else sim.mem.rollback(mark);
      return { result: fmtRV(v), variablesReference: 0 };
    } catch (err) {
      sim.mem.rollback(mark);
      if (err instanceof NeedValue) return { result: `? (${err.message})`, variablesReference: 0 };
      if (err instanceof AskSignal) return { result: '(함수 호출은 조사식에서 평가하지 않습니다)', variablesReference: 0 };
      if (err instanceof Unsupported) return { result: err.message, variablesReference: 0 };
      throw err;
    }
  }
}

function describe(q: Question): string {
  switch (q.kind) {
    case 'return':
      return `${q.call} 의 반환값`;
    case 'sqlcode':
      return `SQL 결과(sqlcode): ${q.sql}`;
    case 'cond':
      return `조건 ${q.text} 의 참/거짓`;
  }
}
