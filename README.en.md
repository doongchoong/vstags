# vstags — C / Pro\*C Code Navigator

[한국어](README.md) · English

## Why

Reading a large legacy C / Pro*C code base mostly means jumping to definitions, finding callers and finding references. The usual tools get in the way:

- An LSP language server (clangd etc.) cannot be used in the environment.
- It was hard to find a tag-based extension for ctags / cscope.
- The existing C/C++ extension does not read `.pc` files with embedded `EXEC SQL`, and it needs `compile_commands.json` to work properly.
- Development happens locally, not on a server environment.
- A simple debugging aid and a linter for the company coding convention were needed [experimental].

vstags brings what ctags + cscope do into VSCode language features. It works from the source files alone: no build settings and no precompiler.

## Key features

- **Navigation**: go to definition/declaration, find references / callers / assignments, Call Hierarchy, symbol search, Outline
- **Runs locally**: works on a local PC, no server environment needed
- **Editing help**: hover (definition preview with comments), `p->` member completion, rename, semantic highlighting
- **Loose parsing**: indexes from the source alone, with no build settings and no Oracle precompiler. Hard-to-parse parts (`EXEC SQL`, conditional compilation, K&R, etc.) are skipped instead of causing failures, and only the useful information (host variables, cursors, `WHENEVER … DO fn()`, etc.) is extracted.
- **[Experimental] source-based debugging (off by default)**: a block simulator that steps through a block in the debugger UI without running the code (see the [Korean README](README.md))
- **[Experimental] linter (off by default)**: company coding-convention checks (see the [Korean README](README.md))
- **Fast and light**: incremental indexing; 3,000 files / 1.5M lines in about 1.5 s

## Installation

Install the latest `.vsix` file from the `release/` folder in VSCode: open the **Extensions** view, click the **`…`** menu, and choose **Install from VSIX…**.
Changes per version are listed in `CHANGELOG.md` (also shown on the *Changelog* tab of the extension page).

## Details

### Features

| Feature | How to use | Notes |
|---|---|---|
| Go to Definition | `F12` / Ctrl+click / `Alt+F12` (peek) | functions, macros, struct/union/enum, typedef, global/local variables, parameters, enumerators, labels, Pro*C cursors |
| Go to Declaration | right-click → Go to Declaration | prototypes / `extern` in headers |
| Find References | `Shift+F12`, `Shift+Alt+F12` | tells shadowed locals from globals, and members (`.x` / `->x`) from plain identifiers |
| Call Hierarchy | `Shift+Alt+H` | callers / callees tree; function-pointer table registrations and `WHENEVER SQLERROR DO fn()` count as calls |
| Callers list (cscope `3`) | `Ctrl+Alt+C` / right-click → Find Callers | lists call sites in a peek window |
| Find Assignments | right-click → Find Assignments | `x = …`, `x++`, `p->x += …` |
| EXEC SQL usages | command: *Find SQL Host Variable Usages* | only places used as `:h_var` |
| Files including this file (cscope `8`) | command: *Find Files #including This File* | includes `EXEC SQL INCLUDE` |
| Symbol search (ctags `:tag`) | `Ctrl+T` or `Ctrl+Alt+T` | `Ctrl+Alt+T` takes kind prefixes: `f:` function, `m:` macro, `s:` struct/type, `v:` variable, `e:` enumerator, `c:` cursor, `mb:` member |
| Outline / Breadcrumb | `Ctrl+Shift+O`, OUTLINE in the explorer | members under structs, enumerators under enums |
| Hover | mouse over | function signature, multi-line macro body, struct/typedef members, comments right above or to the right of a definition (including member comments) |
| Completion | while typing / `p->` | after `p->` the variable's type is tracked and only that struct's members are offered |
| Highlight same symbol | move the cursor | read / write distinguished |
| Rename | `F2` | locals within the function, globals across the workspace (preview: `Shift+Enter`) |
| Semantic highlighting | automatic | colors macros / types / enumerators / globals / parameters |
| Pro*C syntax highlighting | automatic | registers `.pc` as the `proc` language; `EXEC SQL` blocks are highlighted as SQL |
| Export ctags file | command: *Export ctags-compatible 'tags' file* | share with vim etc. |

### How Pro\*C is handled

SQL is skipped instead of causing parse failures, and only the useful information is extracted.

- `EXEC SQL … ;`, `EXEC ORACLE … ;` and `EXEC TOOLS/IAF …` are skipped, not passed to the C parser. Strings inside SQL (`'O''Brien;'`) and semicolons in `--` or `/* */` comments are not mistaken for the end of a statement.
- `EXEC SQL EXECUTE BEGIN … END; END-EXEC;` (PL/SQL blocks) and `CREATE PROCEDURE … END-EXEC` are skipped up to `END-EXEC`.
- From the skipped SQL these are extracted:
  - `:host_var`, `:var:ind` → references to that C variable (included in Find References and Rename)
  - `EXEC SQL WHENEVER SQLERROR DO fn(...)` → recorded as a **call** to `fn` (shows in Call Hierarchy)
  - `WHENEVER … GOTO label` → label reference
  - `DECLARE c CURSOR` → cursor definition; `OPEN/FETCH/CLOSE c` and `WHERE CURRENT OF c` → cursor references
  - `EXEC SQL INCLUDE file;` → include relation
- Declarations inside `BEGIN/END DECLARE SECTION` (including `VARCHAR h_name[30];`) are indexed as ordinary C declarations.

### Other handling

- **Conditional compilation**: `#if 0` blocks are skipped. When branches have mismatched braces (`#ifdef A / if (a) { / #else / if (b) { / #endif`), only the first branch is followed so function scopes do not break (the same approach as ctags). Branches with balanced braces are all indexed.
- **Old-style C**: K&R function definitions, implicit int, `PROTO((…))` macros, `extern "C" {`, function-pointer variables / typedefs / members, anonymous struct/union, bit-fields.
- **Encoding**: the default (`auto`) reads valid UTF-8 as UTF-8 and anything else as CP949. If **all your sources are CP949**, this is recommended:

  ```jsonc
  "files.encoding": "windows949",   // encoding VSCode opens files with
  "vstags.encoding": "cp949"        // skip UTF-8 detection; short Korean comments can be mistaken for UTF-8
  ```

- **Incremental indexing**: the cache is read at startup and only files whose mtime/size changed are re-indexed. A file watcher follows saves, creations and deletions; open documents are parsed live from their unsaved content.
- **Other people's changes**: `git pull` / `svn update` are picked up by the file watcher. On network drives where watch events do not arrive, changes are checked **every time you return to the VSCode window** (at most every 10 seconds, `vstags.syncOnFocus`). You can also run *vstags: Sync Index* (changes only) or *Rebuild Index* (everything), or click `vstags` in the status bar.
- **Parallel indexing**: worker threads. 3,000 files / 1.5M lines in about 1.5 s (cache 2.3 MB, 0.5 s to load on restart).

### Settings

| Setting | Default | Description |
|---|---|---|
| `vstags.include` | `**/*.c, **/*.h, **/*.pc, **/*.pcc` | files to index |
| `vstags.exclude` | `.git`, `node_modules`, `.vstags` | excluded (`files.exclude` and `search.exclude` also apply) |
| `vstags.languages` | `["c", "cpp", "proc"]` | language ids to attach features to. VSCode often opens `.h` as C++, hence `cpp`. If results overlap with the C/C++ extension, drop `cpp` or set `"files.associations": {"*.h": "c"}` |
| `vstags.encoding` | `auto` | `auto` / `cp949` / `utf-8`. Changing it triggers a full re-index |
| `vstags.fallbackEncoding` | `cp949` | encoding for non-UTF-8 files when `auto` |
| `vstags.maxFileSizeKB` | 4096 | larger files are skipped |
| `vstags.syncOnFocus` | true | check for changed files when the window regains focus (at most every 10 s) |
| `vstags.workers` | 0 (auto) | number of index workers |
| `vstags.callHierarchy.includeFunctionPointers` | true | also list places where a function name is used as a value (callback registration) as callers |
| `vstags.semanticHighlighting` | `auto` | always for `.pc`; for `.c` only when no C/C++ extension is present |
| `vstags.enableCompletion` / `enableHover` | true | |
| `vstags.simulator.*` | | [experimental] block simulator (see the [Korean README](README.md)) |
| `vstags.lint.*` | | [experimental] coding-convention lint (see the [Korean README](README.md)) |

### Experimental features (off by default)

- **Block simulator** (`"vstags.simulator.enabled": true`): instead of running the code, step through a function block in the debugger UI. You give values to the variables the block uses and move one statement at a time; when a value is unknown it stops and asks instead of guessing. It models SQL results, calls to other functions, string/memory functions and buffer overflows. Details are in the [Korean README](README.md).
- **Coding-convention lint** (`"vstags.lint.enabled": true`): shows Hungarian-notation prefix, global/static/extern, `sqlca.sqlcode` check, `memset` size and buffer-copy size problems for the files you are looking at, as warnings or information (never errors). Each rule can be turned off or re-leveled in `vstags.lint.rules`. Details are in the [Korean README](README.md) and in `docs/lint-plan.md`.

### CLI and tag file

The index is stored per workspace (`ExtensionContext.storageUri`) as `index.vtags.gz` (gzipped JSON Lines, one line per file: definitions + name table + references as an `Int32Array`). *vstags: Show Index Status → Show Log* shows where.

The same engine runs from the command line (to generate tags on a build server, or to check the parser):

```bash
node out/cli.js <dir> stats
node out/cli.js <dir> defs load_emps
node out/cli.js <dir> refs h_empno
node out/cli.js <dir> callers sql_error
node out/cli.js <dir> callees load_emps
node out/cli.js <dir> search ldemp
node out/cli.js <dir> dump src/emp.pc
node out/cli.js <dir> ctags ./tags
```

### Limitations

- It is a heuristic parser that does not run the preprocessor. Macros that change the grammar itself (`BEGIN_FUNC(name) … END_FUNC`) may not be recognized correctly.
- Type tracking for `p->a.b` uses the path within one line plus the declared type of the variable. For paths through casts or function return values, every member with that name is offered.
- For static functions with the same name, the one in the current file wins; if there is none, all are shown.
- The `.pc` extension collides with pkg-config files. If your source tree has pkg-config files, add them to `vstags.exclude`.

### Development

During development, open this folder in VSCode and press `F5` (Run vstags Extension) to try it on `test-fixtures`.

```bash
npm test                   # parser unit tests + provider tests on a vscode mock
npm run release -- patch   # see the release steps in the Korean README
```

Source layout: `src/core/` engine independent of VSCode (shared with the CLI), `src/vscode/` providers / commands / index manager, `src/sim/` experimental block simulator, `src/lint/` experimental lint.
