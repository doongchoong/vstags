# vstags — C / Pro\*C 코드 내비게이터

한국어 · [English](README.en.md)

## 왜 만들었나

오래된 대형 C / Pro*C 소스를 읽을 때 가장 자주 하는 일은 정의로 이동, 호출자 찾기, 참조 찾기입니다. 기존 도구는 이럴 때 불편했습니다.

- LSP 언어 서버(clangd 등)를 사용할 수 없는 상황입니다.
- ctags / cscope 의 태그 기반 확장을 찾기 어려웠습니다.
- 기존 C/C++ 확장은 `EXEC SQL` 이 섞인 `.pc` 파일을 잘 읽지 못하며, `compile_commands.json` 설정이 있어야 제대로 동작합니다.
- 서버 환경이 아닌 로컬에서 개발합니다.
- 간단한 디버깅, 그리고 회사 코딩 컨벤션을 위한 린터가 필요했습니다 [실험 기능].

vstags 는 ctags + cscope 가 하던 일을 VSCode 언어 기능으로 옮기되, 컴파일 설정이나 프리컴파일러 없이 소스만 있으면 동작하도록 만들었습니다.

## 핵심 기능

- **탐색**: 정의/선언 이동, 참조·호출자·대입 위치 찾기, Call Hierarchy, 심볼 검색, Outline
- **로컬에서 바로**: 서버 환경 없이 로컬 PC 에서 동작
- **편집 보조**: 호버(마우스를 올린 심볼의 정의 미리보기, 주석 포함), `p->` 자동완성, 이름 바꾸기, 시맨틱 하이라이트
- **느슨한 파싱**: 컴파일 설정이나 Oracle 프리컴파일러 없이 소스만으로 색인합니다. 파싱이 어려운 부분(`EXEC SQL`, 조건부 컴파일, K&R 등)은 실패하지 않고 건너뛰며, 쓸모 있는 정보(호스트 변수, 커서, `WHENEVER … DO fn()` 등)만 뽑아냅니다.
- **[실험] 소스 기반 디버깅 (기본 꺼짐)**: 코드를 실행하지 않고 디버거 화면에서 블록을 한 줄씩 따라가는 블록 시뮬레이터
- **[실험] 린터 (기본 꺼짐)**: 회사 코딩 컨벤션 검사
- **빠르고 가벼움**: 변경된 파일만 다시 색인, 3,000 파일 / 150만 줄을 약 1.5초에 색인

## 설치

`release/` 폴더의 최신 `.vsix` 파일을 VSCode 에서 **확장 → `…` → VSIX 에서 설치** 로 설치합니다.
버전별 변경 내용은 `CHANGELOG.md` 에 있습니다 (VSCode 확장 화면의 *Changelog* 탭에도 표시됨).

## 자세한 설명

### 기능

| 기능 | 사용법 | 비고 |
|---|---|---|
| 정의로 이동 | `F12` / Ctrl+클릭 / `Alt+F12`(peek) | 함수, 매크로, struct/union/enum, typedef, 전역/지역 변수, 파라미터, 열거자, 레이블, Pro\*C 커서 |
| 선언으로 이동 | 우클릭 → Go to Declaration | 헤더의 prototype / `extern` |
| 참조 찾기 | `Shift+F12`, `Shift+Alt+F12` | 지역 변수가 전역을 가리는 경우(shadowing) 구분, 멤버(`.x`/`->x`)와 일반 식별자 구분 |
| 호출 계층 | `Shift+Alt+H` (Call Hierarchy) | 호출자/피호출자 트리. 함수 포인터 테이블 등록, `WHENEVER SQLERROR DO fn()` 도 호출로 인식 |
| 호출자 목록 (cscope `3`) | `Ctrl+Alt+C` / 우클릭 → Find Callers | peek 창에 호출 위치 나열 |
| 대입 위치 찾기 | 우클릭 → Find Assignments | `x = …`, `x++`, `p->x += …` |
| EXEC SQL 사용처 | 명령: *Find SQL Host Variable Usages* | `:h_var` 로 쓰인 곳만 |
| include 하는 파일 (cscope `8`) | 명령: *Find Files #including This File* | `EXEC SQL INCLUDE` 포함 |
| 심볼 검색 (ctags `:tag`) | `Ctrl+T` 또는 `Ctrl+Alt+T` | `Ctrl+Alt+T` 는 종류 접두사 지원: `f:` 함수, `m:` 매크로, `s:` 구조체/타입, `v:` 변수, `e:` 열거자, `c:` 커서, `mb:` 멤버 |
| Outline / Breadcrumb | `Ctrl+Shift+O`, 탐색기의 OUTLINE | 구조체 아래 멤버, enum 아래 열거자 |
| 호버 | 마우스 올리기 | 함수 시그니처, 매크로 본문(여러 줄), 구조체/typedef 의 멤버 목록, 정의 바로 위·오른쪽 주석 (멤버 주석 포함) |
| 자동완성 | 입력 중 / `p->` | `p->` 뒤에서는 변수 타입을 추적해 해당 구조체 멤버만 제안 |
| 같은 심볼 강조 | 커서 이동 | 읽기/쓰기 구분 |
| 이름 바꾸기 | `F2` | 지역 변수는 함수 범위만, 전역은 작업 영역 전체 (미리보기: `Shift+Enter`) |
| 시맨틱 하이라이트 | 자동 | 매크로/타입/열거자/전역변수/파라미터를 색으로 구분 |
| Pro\*C 문법 강조 | 자동 | `.pc` 를 `proc` 언어로 등록, `EXEC SQL` 블록은 SQL 로 강조 |
| ctags 파일 내보내기 | 명령: *Export ctags-compatible 'tags' file* | vim 등과 공유 |

#### cscope 질의 대응표

| cscope | vstags |
|---|---|
| 0 Find this C symbol | `Shift+F12` (참조) |
| 1 Find this global definition | `F12` |
| 2 Find functions called by this function | `Shift+Alt+H` → Outgoing calls |
| 3 Find functions calling this function | `Ctrl+Alt+C` 또는 `Shift+Alt+H` |
| 4 Find this text string / 6 egrep | VSCode 검색 (`Ctrl+Shift+F`) |
| 7 Find this file | `Ctrl+P` |
| 8 Find files #including this file | *Find Files #including This File* |
| 9 Find assignments to this symbol | *Find Assignments* |

### Pro\*C 처리 방식

SQL 은 파싱하지 않고 건너뛰되, 필요한 정보만 뽑아냅니다.

- `EXEC SQL … ;`, `EXEC ORACLE … ;`, `EXEC TOOLS/IAF …` 는 C 파서에 넘기지 않고 건너뜁니다.
  SQL 안의 문자열(`'O''Brien;'`)이나 `--`/`/* */` 주석 속 세미콜론을 문장 끝으로 오인하지 않습니다.
- `EXEC SQL EXECUTE BEGIN … END; END-EXEC;` (PL/SQL 블록)과 `CREATE PROCEDURE … END-EXEC` 는 `END-EXEC` 까지 건너뜁니다.
- 건너뛰는 SQL 안에서 다음은 뽑아냅니다:
  - `:host_var`, `:var:ind` → 해당 C 변수의 참조 (참조 찾기/이름 바꾸기에 포함)
  - `EXEC SQL WHENEVER SQLERROR DO fn(...)` → `fn` **호출**로 기록 (Call Hierarchy 에 나옴)
  - `WHENEVER … GOTO label` → 레이블 참조
  - `DECLARE c CURSOR` → 커서 정의, `OPEN/FETCH/CLOSE c`, `WHERE CURRENT OF c` → 커서 참조
  - `EXEC SQL INCLUDE file;` → include 관계
- `BEGIN/END DECLARE SECTION` 안의 선언(`VARCHAR h_name[30];` 포함)은 일반 C 선언으로 색인됩니다.

### 그 밖의 처리

- **조건부 컴파일**: `#if 0` 블록은 건너뜁니다. `#ifdef A / if (a) { / #else / if (b) { / #endif` 처럼 분기마다 중괄호가 어긋나는 경우는 첫 분기만 따라가므로 함수 범위가 깨지지 않습니다 (ctags 와 같은 방식). 중괄호가 맞는 분기는 모두 색인합니다.
- **K&R 함수 정의** (`int f(a, b) int a; char *b; {`), 암시적 int, `PROTO((…))` 매크로, `extern "C" {`, 함수 포인터 변수/typedef/멤버, 익명 struct/union, 비트필드.
- **인코딩**: 기본값(`auto`)은 올바른 UTF-8 이면 UTF-8, 아니면 CP949 로 읽습니다.
  **소스가 전부 CP949 라면** 다음처럼 설정하는 것이 좋습니다:
  ```jsonc
  "files.encoding": "windows949",   // VSCode 가 파일을 여는 인코딩 (확장 완성형 포함)
  "vstags.encoding": "cp949"        // UTF-8 판별 생략, 짧은 한글 주석이 우연히 UTF-8 로 오인되는 일 방지
  ```
- **증분 색인**: 시작할 때 캐시를 읽고 mtime/size 가 바뀐 파일만 다시 색인합니다. 파일 감시자가 저장/생성/삭제를 반영하고, 열린 문서는 저장 전 내용도 실시간으로 파싱합니다.
- **다른 개발자의 변경 반영**: `git pull`/`svn update` 등은 파일 감시자가 즉시 반영합니다.
  네트워크 드라이브처럼 감시 이벤트가 오지 않는 환경을 위해 **VSCode 창으로 돌아올 때마다(최소 10초 간격) 변경분을 확인**합니다 (`vstags.syncOnFocus`).
  수동으로는 *vstags: Sync Index* (변경분만) / *Rebuild Index* (전체) 명령을 쓰거나 상태 표시줄의 `vstags` 를 클릭하세요.
- **병렬 색인**: 워커 스레드로 병렬 처리합니다. 3,000 파일 / 150만 줄을 약 1.5초에 색인합니다 (캐시 2.3MB, 재시작 시 로드 0.5초).

### 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `vstags.include` | `**/*.c, **/*.h, **/*.pc, **/*.pcc` | 색인 대상 |
| `vstags.exclude` | `.git`, `node_modules`, `.vstags` | 제외 (+ `files.exclude`, `search.exclude` 자동 적용) |
| `vstags.languages` | `["c", "cpp", "proc"]` | 기능을 붙일 language id. VSCode 는 `.h` 를 C++ 로 여는 경우가 많아 `cpp` 포함. C/C++ 확장과 결과가 겹치면 `cpp` 를 빼거나 `"files.associations": {"*.h": "c"}` |
| `vstags.encoding` | `auto` | `auto` / `cp949` / `utf-8`. 바꾸면 전체 재색인 |
| `vstags.fallbackEncoding` | `cp949` | `auto` 일 때 UTF-8 이 아닌 파일의 인코딩 |
| `vstags.maxFileSizeKB` | 4096 | 이보다 큰 파일은 건너뜀 |
| `vstags.syncOnFocus` | true | 창으로 돌아올 때 변경된 파일 확인 (최소 10초 간격) |
| `vstags.workers` | 0 (자동) | 색인 워커 수 |
| `vstags.callHierarchy.includeFunctionPointers` | true | 함수 이름이 값으로 쓰인 곳(콜백 등록)도 호출자로 표시 |
| `vstags.semanticHighlighting` | `auto` | `.pc` 는 항상, `.c` 는 C/C++ 확장이 없을 때만 |
| `vstags.enableCompletion` / `enableHover` | true | |
| `vstags.simulator.enabled` | false | [실험] 블록 시뮬레이터 |
| `vstags.simulator.logFunctions` | `{}` | [실험] 시뮬레이터에서 printf 처럼 출력할 로깅 함수 → prefix |
| `vstags.simulator.types` | `{}` | [실험] 시뮬레이터용 회사 타입 정의 (예: `{"MONEY": "double"}`) |
| `vstags.simulator.ignore` | `[]` | [실험] 시뮬레이터에서 무시할 함수/매크로 (`*` `?` 와일드카드) |
| `vstags.lint.enabled` | false | [실험] 코드 컨벤션 검사 |
| `vstags.lint.rules` | `{}` | [실험] 규칙 ID → `warning` / `information` / `hint` / `off` |
| `vstags.lint.prefixes` | 가이드 표 | [실험] 접두어 → 타입 이름 목록 |
| `vstags.lint.sqlCheckNames` | `[]` | [실험] sqlcode 확인으로 칠 매크로/함수 (자동 인식이 안 될 때) |

### 전용 태그 파일 & CLI

색인은 작업 영역별 저장소(`ExtensionContext.storageUri`)에 `index.vtags.gz` 로 저장됩니다
(gzip 된 JSON Lines, 파일당 한 줄: 정의 목록 + 이름 테이블 + 참조 `Int32Array`). 위치는 *vstags: Show Index Status → Show Log* 에서 확인.

같은 엔진을 명령행에서도 쓸 수 있습니다 (빌드 서버에서 tags 생성, 파서 확인용):

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

### 한계

- 전처리기를 실제로 실행하지 않는 휴리스틱 파서입니다. 문법 자체를 바꾸는 매크로(`BEGIN_FUNC(name) … END_FUNC`)는 정확히 인식하지 못할 수 있습니다.
- `p->a.b` 의 타입 추적은 한 줄 안의 경로 + 변수 선언 타입 기준입니다. 캐스트나 함수 반환값을 거친 경로는 이름이 같은 모든 멤버를 후보로 보여줍니다.
- 이름이 같은 static 함수는 현재 파일 것을 우선하고, 없으면 모두 보여줍니다.
- `.pc` 확장자는 pkg-config 파일과 겹칩니다. 소스 트리에 pkg-config 파일이 있다면 `vstags.exclude` 에 추가하세요.

### [실험] 블록 시뮬레이터 (기본 꺼짐)

코드를 실제로 실행하지 않고, 머릿속으로 하던 로직 점검을 디버거 화면에서 할 수 있게 한 기능입니다.
블록에서 쓰는 변수에 값을 넣고 한 줄씩 진행합니다. 모르는 값이 필요하면 추측하지 않고 멈춥니다.

켜기: 설정 `"vstags.simulator.enabled": true`

사용법:
1. 함수 안에서 시작할 곳에 커서 → 우클릭 → **Simulate Block (블록 시뮬레이션, 실험)**
   - **커서만**: 그 줄(빈 줄/주석이면 다음 문장)부터 **함수 끝까지**. 반복문 몸체 중간이면 반복도 이어서 돕니다
   - **범위 선택**: 선택한 문장들만
2. 디버거 화면이 열리고 첫 문장에서 멈춥니다. **변수 창**에 블록에서 쓰는 변수가 `?` 로 보입니다.
   더블클릭해서 값을 넣으세요: `10`, `-1.5`, `'A'`, `"SCOTT"`, `NULL` (`?` 를 넣으면 다시 모르는 값)
3. `F10` 한 문장씩, `F5` 계속 (중단점 지원). 조사식(Watch)/디버그 콘솔에서 `rec->sal * 2` 같은 식도 계산됩니다.
4. 모르는 값이 필요해지면 예외처럼 멈추고 **입력 상자**가 뜹니다. 값을 넣으면 그 문장부터 이어서 진행합니다.
   입력 상자의 **⤼ 버튼**(또는 `skip` 입력)을 누르면 값을 정하지 않고 그 문장을 건너뜁니다. 반환값/SQL 결과/조건 질문에도 같은 항목이 있습니다.
5. **여기까지 쭉 건너뛰기**: 멈춘 상태에서 가고 싶은 줄에 커서 → 우클릭 → **Jump to Cursor** (또는 **vstags: Jump to Cursor (커서까지 건너뛰기)**).
   그 사이 코드는 실행하지 않고, 지금까지 넣은 값은 그대로 둔 채 그 줄에서 멈춥니다. 반복문 몸체 안으로 가면 반복도 이어집니다.
   지금 실행 중인 함수 안에서만 이동할 수 있습니다 (들어간 함수 안이면 그 함수 안).
6. **뒤로 가기**: 디버그 도구 모음의 **Step Back** (한 문장 뒤로) / **Reverse Continue** (이전 중단점까지, 없으면 처음으로).
   지금까지 넣은 값·고른 답을 기록해 두었다가 **처음부터 빠르게 다시 실행**해서 그 위치에서 멈춥니다 (묻지 않음).
   되돌아간 지점 이후의 입력은 버려지므로, 다시 진행하면 그 이후는 새로 묻습니다 — 다른 값/SQL 결과를 넣어 보기 좋습니다.
   시뮬레이션 도중 소스를 고쳤다면 같은 위치로 돌아가지 못할 수 있습니다 (시작할 때의 소스 기준).
7. **넘기고 싶은 부분**은 멈춘 상태에서 디버그 도구 모음의 **⤼ 문장 건너뛰기** (명령 `vstags: Skip Statement`).
   `if`/`for`/`while`/`switch` 앞에서 누르면 **블록 통째로** 넘어가고, 값을 묻는 중에 누르면 그 문장을 넘어갑니다.
   자주 쓴다면 키보드 단축키에 `vstags.sim.skip` 을 연결하세요.
8. 늘 넘기는 로그/출력 매크로·함수는 설정에 등록: `"vstags.simulator.ignore": ["PRINT_*", "TRACE_*", "log_*"]`
   (매크로 문장은 통째로 없어지고, 함수는 호출하지 않고 0 반환). 실행 중에 "이번 시뮬레이션 동안 항상 무시" 를 고를 수도 있습니다.
9. 회사 **로깅 함수를 출력**하려면: `"vstags.simulator.logFunctions": { "log_write": "[LOG] ", "LOG_ERR": "[ERR {fn}:{line}] " }`
   printf 처럼 포맷해서 디버그 콘솔에 prefix 와 함께 찍습니다 (모르는 값은 `?`, 묻지 않음). 포맷 문자열 위치가 자동으로 안 맞으면 `"log_write:4"` 처럼 지정.
10. **변수값 스냅샷**: 멈춘 상태에서 실행 및 디버그 패널의 **vstags 변수값 모음** 제목줄 💾 (또는 *vstags: 현재 변수값 저장*) → 이름 입력.
    지금 함수에서 정해진 변수값(구조체 멤버, 문자열, 포인터가 가리키는 대상 포함)을 `.vstags/snapshots/<함수>/<이름>.json` 에 저장합니다 (줄 번호 없음).
    다음 시뮬레이션에서 같은 패널의 목록(지금 함수 것이 위)을 누르면 그 값으로 변수를 한 번에 덮어씁니다. 함수 첫 줄에서 적용해도 초기값 없는 선언(`int n;`)을 지나며 값이 유지됩니다.

동작 방식:

| 상황 | 동작 |
|---|---|
| `EXEC SQL SELECT/FETCH … INTO :a, :b` | SQL 은 실행하지 않고 **결과(sqlcode)를 고르게** 함: `0` / `1403 NOT FOUND` / `-1` 오류 / 직접 입력. `0` 이면 INTO 변수는 `?` 가 되어 **쓰이는 시점에 값을 물어봄** ("가져왔다 치고") |
| `UPDATE/INSERT/DELETE` | 결과 선택 + 디버그 콘솔에 **호스트 변수를 실제 값으로 바꾼 SQL** 출력 (`… WHERE empno = 7369`) |
| `WHENEVER NOT FOUND GOTO done` 등 | 파일상 앞에 선언된 WHENEVER 가 적용됨 (Pro*C 와 같은 규칙). 블록 밖 레이블로 가면 종료 |
| 블록 안에서 다른 함수 호출 | **선언된 반환 타입에 맞게 반환값을 물어봄**: 숫자 / `char *` 면 문자열·나중에(쓰일 때)·NULL / 구조체 포인터면 새 대상·NULL. 함수 안으로 들어가기, 무시 (로그 함수 등) |
| 정의를 모르는 타입 (`int64`, `MONEY` 등) | 크기를 가정하지 않고 넣은 값을 그대로 둠 (자르지 않음). 정확히 보려면 `vstags.simulator.types` 에 지정 |
| 함수 안으로 들어가기 (**F11** 또는 질문에서 선택) | 정의로 이동해서 실행. 포인터로 넘긴 구조체는 **같은 객체**라 담아 둔 값이 이어지고, 안에서 바꾼 값도 돌아옴. 값으로 넘긴 구조체는 복사본. **return 값이 호출한 문장으로 돌아옴**. 전역 변수는 공유. 호출 스택에 단계별로 표시, **Shift+F11** 로 호출한 쪽까지 진행 |
| `strcpy/strcat/sprintf/memset/memcpy/strcmp/strlen/atoi…` | 실제로 계산. **버퍼 넘침·배열 범위 밖·NULL 역참조·0 나누기는 ⚠ 로 멈춤** |
| `memcpy` 원본에 모르는 값 | 멈춰서 물음 (문자 배열은 첫 `\0` 까지만 확인, 구조체는 모르는 멤버를 하나씩) |
| 매크로 / 열거자 / typedef / 구조체 멤버 | 색인 정보로 해석 (`MAX_NAME + 1`, `SQL_OK()`, `LOG_LEVEL_ERR`, `EmpRec`) |
| 모르는 포인터 `list->items[n]` | 가리키는 대상을 새로 만들어 멤버별로 `?` (값 넣으면 이어짐) |
| 해석할 수 없는 문장/식 | 멈춤 → 디버그 도구 모음의 **문장 건너뛰기** 로 넘어감 |

한계: 정의가 색인에 없는 함수(라이브러리 등)는 들어갈 수 없음, `#ifdef` 는 첫 분기만 따라감, 함수 안의 struct 정의·지정 초기화·복합 리터럴 미지원,
포인터 연산은 배열 안에서만, 한글 문자열의 `strlen` 은 글자 수 기준(CP949 바이트 수와 다름).

### [실험] 코드 컨벤션 검사 (기본 꺼짐)

설정 `vstags.lint.enabled` 를 켜면 **화면에 보이는 파일**에 회사 컨벤션 위반을 표시합니다 (문제 패널, 출처 `vstags`). 다른 탭으로 바꾸면 이전 파일의 결과는 지워집니다.
L1 규칙과 안전 검사는 Warning(노란 밑줄), L2 는 Information(파란 밑줄)이고 Error 는 쓰지 않습니다.
정의를 찾지 못한 타입/매크로는 추정하지 않고 넘어갑니다. 설계와 전체 규칙은 저장소의 `docs/lint-plan.md` 를 참고하세요.

| 구분 | 규칙 |
|---|---|
| 접두어 | `[h_][g_][p…]` + (`sz` / `ac` / `[a]` + `n o d c s f u t` 중 하나) + CamelCase. typedef 는 색인을 따라감 (`int32` → n, `uint8` → u), `VARCHAR` 는 구조체(t) |
| sz / ac | `sz` 배열은 `[길이 + 1]`, `ac` 배열은 `+ 1` 없이 (매크로 본문이 `+ 1` 로 끝나도 인정) |
| 전역 / 호스트 변수 | 전역은 `static` + `g_`, 함수 안 static 도 `g_`, `extern` 금지, DECLARE SECTION 안은 `h_` (`h_g_` 순서) |
| 그 밖의 L1 | `//` 주석 금지, `.h` 헤더가드 |
| L2 | `EXEC SQL INCLUDE` 금지, struct 는 typedef 와 함께, typedef 구조체 `_t`, 구조체 파라미터는 포인터로, 헤더에 없는 함수는 static, if 안 대입 |
| 안전 검사 | EXEC SQL 뒤 `sqlca.sqlcode` 확인 누락 (`DB_SQLCODE` 같은 매크로·함수는 자동 인식, WHENEVER SQLERROR 고려), `memset` 크기 실수, 지역 구조체·`sz` 배열 초기화 전 사용, sz/ac 복사 크기 넘침·NUL 자리 없음 |

규칙별로 `vstags.lint.rules` 에서 끄거나 심각도를 바꿀 수 있고 (`{"camel-case": "off"}`), 접두어 표는 `vstags.lint.prefixes` 로 바꿀 수 있습니다.

VS Code 는 파일당 경고를 1000개까지만 표시합니다. 그래서 같은 규칙이 **10줄 이상 연달아** 걸리면(사이의 빈 줄/주석 줄은 이어진 것으로 봄) 블록 하나로 묶고, 각 위치는 문제 패널에서 하위 항목으로 보여줍니다.
안전 검사는 묶지 않고 같은 심각도 안에서 맨 앞에 두므로, 개수가 넘쳐도 잘리지 않습니다.

### 릴리스 (버전 관리)

1. 변경할 때마다 `CHANGELOG.md` 의 `## [Unreleased]` 아래에 내용을 적습니다 (추가 / 수정 / 변경).
2. 커밋한 뒤 릴리스 명령을 실행합니다.

   ```bash
   npm run release -- patch
   ```

   - `patch` (0.2.0 → 0.2.1) 버그 수정만, `minor` (0.2.0 → 0.3.0) 기능 추가, `major` 기존 사용법이 바뀌는 변경, 또는 `0.4.0` 처럼 직접 지정
   - 하는 일: 커밋 안 된 변경 확인 → `[Unreleased]` 내용 확인 → 테스트 → `package.json` 버전과 CHANGELOG 갱신 → `release/vstags-<버전>.vsix` 생성 → 커밋 `Release v<버전>` + 태그 `v<버전>`
   - push 는 하지 않습니다. 원격 저장소가 있다면 `git push --follow-tags`
   - `--dry-run` 을 붙이면 vsix 만 만들고 커밋/태그는 하지 않습니다
3. 테스트용으로 버전을 올리지 않고 만들 때는 `npm run package` (→ `release/vstags-<현재 버전>.vsix`).

### 개발

개발 중에는 이 폴더를 VSCode 로 열고 `F5` (Run vstags Extension) 로 `test-fixtures` 를 열어 확인할 수 있습니다.

```bash
npm test        # 파서 단위 테스트 + vscode 목(mock) 기반 프로바이더 테스트
```

구조:

```
src/core/       VSCode 비의존 엔진 (CLI 와 공유)
  lexer.ts        관대한 렉서 + EXEC SQL 스캐너
  preproc.ts      #if/#else 분기 정리
  parser.ts       정의/참조/지역변수 추출
  symbolIndex.ts  메모리 색인 + 질의 (정의 순위, 참조, 호출자/피호출자, 검색)
  store.ts        전용 태그 파일 저장/로드
  workerPool.ts   병렬 색인
src/vscode/     VSCode 프로바이더, 명령, 색인 관리자
src/sim/        [실험] 블록 시뮬레이터
  parser.ts       함수 본문 문장/식 파서 (매크로 전개)
  interp.ts       인터프리터 (모르는 값이면 멈춤, 문장 단위 되돌림/재실행)
  builtins.ts     C 라이브러리 함수
  debugAdapter.ts VSCode 디버거 UI 연결 (DAP)
```
