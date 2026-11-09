import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { indexText } from '../core/fileIndexer';
import { makeMatcher } from '../core/glob';
import { loadIndex, saveIndex } from '../core/store';
import { SymbolIndex } from '../core/symbolIndex';
import { FileIndex } from '../core/types';
import { indexFiles } from '../core/workerPool';

export interface Settings {
  include: string[];
  exclude: string[];
  encoding: string;
  fallbackEncoding: string;
  maxSize: number;
  workers: number;
  languages: string[];
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('vstags');
  return {
    include: c.get<string[]>('include', ['**/*.c', '**/*.h', '**/*.pc', '**/*.pcc']),
    exclude: c.get<string[]>('exclude', []),
    encoding: c.get<string>('encoding', 'auto'),
    fallbackEncoding: c.get<string>('fallbackEncoding', 'cp949'),
    maxSize: c.get<number>('maxFileSizeKB', 4096) * 1024,
    workers: c.get<number>('workers', 0),
    languages: c.get<string[]>('languages', ['c', 'cpp', 'proc']),
  };
}

/**
 * 색인의 생명주기 관리:
 *   - 시작 시 캐시(전용 태그 파일) 로드 -> mtime/size 비교로 변경분만 재색인
 *   - 파일 감시자로 생성/변경/삭제를 따라감
 *   - 열려 있는 문서는 저장 전이라도 실시간으로 파싱 (live)
 */
export class IndexManager implements vscode.Disposable {
  readonly index = new SymbolIndex();
  readonly log = vscode.window.createOutputChannel('vstags');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly storeFile: string;
  private settings = readSettings();
  private isExcluded: (p: string) => boolean = () => false;
  private isIncluded: (p: string) => boolean = () => true;
  private queue = new Set<string>();
  private deletes = new Set<string>();
  private queueTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private busy: Promise<void> = Promise.resolve();
  private cancelled = false;
  private readonly liveCache = new Map<string, { version: number; fi: FileIndex }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  lastBuild: { files: number; removed: number; ms: number; at: Date } | undefined;
  /** 진행 중인 조용한(quiet) 동기화 - 중복 요청을 합치기 위함 */
  private quietSync: Promise<void> | undefined;
  /** 마지막 동기화 완료 시각 (0 이면 아직 첫 동기화 전) */
  private lastSyncAt = 0;

  constructor(ctx: vscode.ExtensionContext) {
    const dir = (ctx.storageUri ?? ctx.globalStorageUri).fsPath;
    this.storeFile = path.join(dir, 'index.vtags.gz');
    this.status.command = 'vstags.showStatus';
    this.status.show();
    this.applySettings();

    this.disposables.push(
      this.log,
      this.status,
      this.changeEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vstags')) {
          this.applySettings();
          if (e.affectsConfiguration('vstags.encoding') || e.affectsConfiguration('vstags.fallbackEncoding')) void this.rebuild();
          else if (e.affectsConfiguration('vstags.include') || e.affectsConfiguration('vstags.exclude')) void this.sync();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()),
      vscode.workspace.onDidCloseTextDocument((d) => this.liveCache.delete(d.uri.toString())),
      // 다른 창(터미널, 탐색기 등)에 갔다가 돌아오면 변경분 확인.
      // 네트워크 드라이브처럼 파일 감시 이벤트가 오지 않는 환경 보완용.
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused || !this.lastSyncAt) return;
        if (!vscode.workspace.getConfiguration('vstags').get<boolean>('syncOnFocus', true)) return;
        if (Date.now() - this.lastSyncAt < 10_000) return;
        void this.sync({ quiet: true });
      }),
    );
    this.createWatcher();
  }

  get storePath(): string {
    return this.storeFile;
  }

  get languages(): string[] {
    return this.settings.languages;
  }

  private applySettings(): void {
    this.settings = readSettings();
    this.isExcluded = makeMatcher(this.excludeGlobs());
    this.isIncluded = makeMatcher(this.settings.include);
  }

  /** vstags.exclude + files.exclude + search.exclude */
  private excludeGlobs(): string[] {
    const globs = [...this.settings.exclude];
    for (const key of ['files.exclude', 'search.exclude']) {
      const obj = vscode.workspace.getConfiguration().get<Record<string, unknown>>(key) ?? {};
      for (const [g, v] of Object.entries(obj)) if (v === true) globs.push(g);
    }
    return globs;
  }

  private createWatcher(): void {
    const pattern = this.settings.include.length === 1 ? this.settings.include[0] : `{${this.settings.include.join(',')}}`;
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const enqueue = (uri: vscode.Uri, del: boolean) => {
      if (uri.scheme !== 'file') return;
      const p = uri.fsPath;
      if (this.isExcluded(p)) return;
      if (del) {
        this.deletes.add(p);
        this.queue.delete(p);
      } else {
        this.queue.add(p);
        this.deletes.delete(p);
      }
      if (this.queueTimer) clearTimeout(this.queueTimer);
      this.queueTimer = setTimeout(() => void this.flushQueue(), 400);
    };
    this.disposables.push(
      w,
      w.onDidCreate((u) => enqueue(u, false)),
      w.onDidChange((u) => enqueue(u, false)),
      w.onDidDelete((u) => enqueue(u, true)),
    );
  }

  private flushQueue(): Promise<void> {
    const paths = [...this.queue];
    const dels = [...this.deletes];
    this.queue.clear();
    this.deletes.clear();
    return this.serialize(async () => {
      for (const p of dels) this.index.removeFile(p);
      if (paths.length) await this.indexPaths(paths, false);
      if (paths.length || dels.length) {
        this.changeEmitter.fire();
        this.scheduleSave();
      }
    });
  }

  /** 색인 작업은 한 번에 하나씩 */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch((e) => this.log.appendLine(`error: ${e instanceof Error ? e.stack : e}`));
    return this.busy;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 5000);
  }

  async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      await saveIndex(this.storeFile, this.index.allFiles());
    } catch (e) {
      this.log.appendLine(`save failed: ${e}`);
    }
  }

  /** 시작: 캐시 로드 후 변경분 동기화 */
  async start(): Promise<void> {
    const t0 = Date.now();
    const cached = await loadIndex(this.storeFile);
    if (cached) {
      for (const fi of cached) this.index.setFile(fi);
      this.log.appendLine(`loaded ${cached.length} files from cache in ${Date.now() - t0}ms (${this.storeFile})`);
      this.changeEmitter.fire();
    }
    this.updateStatus();
    await this.sync();
  }

  async rebuild(): Promise<void> {
    await this.serialize(async () => {
      this.index.clear();
      this.liveCache.clear();
    });
    await this.sync();
  }

  /**
   * 작업 영역 파일 목록과 색인을 비교해서 추가/변경/삭제 반영 (mtime/size 비교).
   * quiet: 창 포커스 등 자동 트리거. 상태 표시줄을 깜빡이지 않고, 이미 대기 중이면 합친다.
   */
  sync(opts: { quiet?: boolean } = {}): Promise<void> {
    if (opts.quiet && this.quietSync) return this.quietSync;
    const run = this.serialize(async () => {
      const t0 = Date.now();
      if (!opts.quiet) this.status.text = '$(sync~spin) vstags: scanning…';
      const include = this.settings.include.length === 1 ? this.settings.include[0] : `{${this.settings.include.join(',')}}`;
      const excl = this.excludeGlobs();
      const exclude = excl.length ? `{${excl.join(',')}}` : null;
      const uris = await vscode.workspace.findFiles(include, exclude);
      const present = new Set<string>();
      const todo: string[] = [];
      await Promise.all(
        chunk(uris.filter((u) => u.scheme === 'file'), 256).map(async (part) => {
          for (const u of part) {
            const p = u.fsPath;
            present.add(p);
            const old = this.index.getFile(p);
            if (!old) {
              todo.push(p);
              continue;
            }
            try {
              const st = await fs.promises.stat(p);
              if (st.mtimeMs !== old.mtime || st.size !== old.size) todo.push(p);
            } catch {
              /* 사라진 파일은 아래에서 제거 */
            }
          }
        }),
      );
      let removed = 0;
      for (const fi of [...this.index.allFiles()]) {
        if (!present.has(fi.path)) {
          this.index.removeFile(fi.path);
          removed++;
        }
      }
      if (todo.length) await this.indexPaths(todo, true);
      const ms = Date.now() - t0;
      this.lastBuild = { files: todo.length, removed, ms, at: new Date() };
      this.lastSyncAt = Date.now();
      if (!opts.quiet || todo.length || removed) {
        this.log.appendLine(`sync${opts.quiet ? ' (focus)' : ''}: ${uris.length} files, ${todo.length} (re)indexed, ${removed} removed, ${ms}ms`);
      }
      this.updateStatus();
      if (todo.length || removed) {
        this.changeEmitter.fire();
        await this.save();
      }
    });
    if (opts.quiet) {
      this.quietSync = run;
      void run.finally(() => {
        if (this.quietSync === run) this.quietSync = undefined;
      });
    }
    return run;
  }

  private async indexPaths(paths: string[], showProgress: boolean): Promise<void> {
    const run = async (report?: (done: number, total: number) => void) => {
      const { errors } = await indexFiles(
        paths,
        { enc: { encoding: this.settings.encoding, fallback: this.settings.fallbackEncoding }, maxSize: this.settings.maxSize, workers: this.settings.workers },
        (fi) => this.index.setFile(fi),
        (p) => report?.(p.done, p.total),
        () => this.cancelled,
      );
      for (const e of errors) this.log.appendLine(`index error: ${e.path}: ${e.message}`);
    };
    if (!showProgress || paths.length < 200) {
      await run();
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'vstags' },
      async (progress) => {
        let last = 0;
        await run((done, total) => {
          const pct = Math.floor((done / total) * 100);
          this.status.text = `$(sync~spin) vstags ${pct}% (${done}/${total})`;
          if (pct !== last) {
            progress.report({ message: `indexing ${done}/${total}` });
            last = pct;
          }
        });
      },
    );
  }

  private updateStatus(): void {
    const s = this.index.stats();
    this.status.text = `$(database) vstags ${s.files.toLocaleString()}`;
    this.status.tooltip = `vstags: ${s.files} files, ${s.defs} symbols, ${s.refs} references\n클릭하면 상태 보기`;
  }

  // ───────────────────────── live documents ─────────────────────────

  isTracked(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' ? this.settings.languages.includes(doc.languageId) || this.isIncluded(doc.uri.fsPath) : false;
  }

  /** 현재 문서 내용을 파싱한 결과 (문서 버전별 캐시) */
  live(doc: vscode.TextDocument): FileIndex {
    const key = doc.uri.toString();
    const c = this.liveCache.get(key);
    if (c && c.version === doc.version) return c.fi;
    const fi = indexText(doc.uri.fsPath, doc.getText());
    this.liveCache.set(key, { version: doc.version, fi });
    return fi;
  }

  /** 저장 안 된(dirty) 문서들의 실시간 색인 - 참조 검색 시 디스크 색인 대신 사용 */
  overrides(): Map<string, FileIndex> {
    const m = new Map<string, FileIndex>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && d.uri.scheme === 'file' && this.isTracked(d)) m.set(d.uri.fsPath, this.live(d));
    }
    return m;
  }

  dispose(): void {
    this.cancelled = true;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      saveIndex(this.storeFile, this.index.allFiles()).catch(() => undefined); // 종료 중 저장 실패는 다음 시작 때 재색인으로 복구
    }
    for (const d of this.disposables) d.dispose();
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
