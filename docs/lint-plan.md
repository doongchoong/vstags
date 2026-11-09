# 코드 컨벤션 검사 (lint) 계획

회사 C / Pro\*C 코드 컨벤션 가이드를 VS Code 경고로 보여주는 기능. **실험 기능, 기본 꺼짐** (`vstags.lint.enabled`).

## 방침

- 표시는 "권장" 느낌: L1 = Warning (노란 밑줄), L2 = Information (파란 밑줄). Error 는 쓰지 않음
- 레거시/신규 구분 없이 모든 코드에 같은 규칙 (베이스라인 없음). 대신 **화면에 보이는 파일만** 검사 (안 보이게 되면 결과를 지움. 탭을 닫아도 문서 닫힘 이벤트가 늦게 와서 열린 문서 기준이면 결과가 쌓임)
- 규칙별로 끄거나 심각도를 바꿀 수 있음 (`vstags.lint.rules`)
- VS Code 는 파일당 1000개까지만 표시 (심각도 순, 받은 순서대로): 같은 규칙이 10줄 이상 연달아 걸리면(빈 줄/주석 줄은 이어진 것으로) 블록 하나로 묶고 각 위치는 관련 정보(하위 항목)로. 안전 검사는 묶지 않고 같은 심각도 안에서 먼저 보냄
- 접두어 ↔ 타입 표는 가이드 내용을 기본값으로 하고 설정(`vstags.lint.prefixes`)으로 바꿀 수 있음 (회사 스타일 고착 방지)
- **확실한 경우만 경고, 모르면 침묵**: 정의를 찾지 못한 타입/매크로는 추정하지 않음
- DB 관련(indicator, 스키마, 집계함수 NULL, 1403/FETCH 규칙, DECLARE SECTION 안 재정의 타입)은 제외
- 시뮬레이터에는 영향 없음

## 접두어 규칙

```
[h_] [g_] [p…] ( sz | ac | [a] (n|o|d|c|s|f|u|t) ) + 대문자로 시작하는 본문
```

| 접두어 | 대상 |
|---|---|
| `n` | int, int32 |
| `o` | long, int64 |
| `d` | double |
| `c` | char |
| `s` | short |
| `f` | float |
| `u` | unsigned 계열 |
| `t` | 구조체/공용체, Pro\*C `VARCHAR` (배열 크기는 길이로 보고 무시) |
| `sz` | NUL 로 끝나는 char 배열. 크기는 `+ 1` 로 끝나야 함 (매크로 본문이 `+ 1` 로 끝나면 인정) |
| `ac` | NUL 없는 char 배열. 크기에 `+ 1` 금지 |
| `a` + 타입 | 그 외 배열 (`an`, `ad`, `at` …). char 2차원 배열은 `a` + `sz`/`ac` |
| `p` | 포인터 (단계마다 하나). `char *` 은 `psz` / `pac` / `pc` 모두 허용 (의도 표시) |
| `g_` | 전역 변수 (반드시 static). 함수 안 static 변수도 전역처럼 `g_` |
| `h_` | `EXEC SQL BEGIN/END DECLARE SECTION` 안의 변수. 전역이면 `h_g_` 순서 |

- typedef 는 색인을 따라감 (`int16` → s, `uint8` → u, `float64` → d …). `int32_t` 같은 stdint 표준 이름은 내장 매핑
- 그 외 모르는 타입, enum, void 포인터, 함수 포인터는 접두어 검사 안 함
- 짧은 변수(`i`, `j`) 예외 없음

## 규칙 목록

### L1 (Warning)

| ID | 내용 |
|---|---|
| `comment-line` | `//` 주석 금지 |
| `header-guard` | `.h` 에 헤더가드(`#ifndef`/`#define`…`#endif`, `#if !defined`, `#pragma once`)가 있는지만 확인. 이름 형식은 보지 않음 |
| `prefix-type` | 접두어 ↔ 타입 (위 표) |
| `sz-plus-one` | `sz` 배열 크기는 `+ 1` 로 끝나야 함 |
| `ac-no-plus-one` | `ac` 배열 크기에 `+ 1` 금지 |
| `global-static` | 전역 변수는 static |
| `global-prefix` | 전역 / 함수 안 static 변수는 `g_`, 그 외(지역/파라미터/멤버)에는 `g_` 금지 |
| `no-extern` | extern 변수 금지 |
| `host-prefix` | DECLARE SECTION 안 변수는 `h_`, 밖에는 `h_` 금지, `h_g_` 순서 |

### L2 (Information)

| ID | 내용 |
|---|---|
| `sql-include` | `EXEC SQL INCLUDE` 금지 |
| `camel-case` | 접두어 다음 본문은 대문자로 시작, `_` 없음 |
| `struct-typedef` | struct/union 은 typedef 와 함께 정의 |
| `typedef-suffix` | typedef 구조체 이름은 `_t` 로 끝남 |
| `struct-param-by-value` | 구조체 파라미터는 포인터로 |
| `internal-static` | 헤더에 선언이 없는 함수는 static |
| `static-local` | 함수 안 static 변수 비권장 |
| `if-assign` | `if (...)` 조건 안의 대입 |

### 안전 검사 (Warning)

| ID | 내용 |
|---|---|
| `sqlcode-check` | 실행되는 EXEC SQL(SELECT/INSERT/UPDATE/DELETE/MERGE/FETCH/OPEN/EXECUTE/PREPARE/CALL/CONNECT/LOCK) 뒤, 다음 SQL 실행이나 함수 끝 전에 `sqlca.*` / `SQLCODE` 확인이 없음. 그걸 쓰는 매크로(예: `DB_SQLCODE`)·함수는 색인으로 자동 인식, 못 잡으면 `vstags.lint.sqlCheckNames` 에 등록. 그 위치에 `EXEC SQL WHENEVER SQLERROR …`(CONTINUE 제외)가 살아 있으면 통과 |
| `memset-size` | `memset(p, x, sizeof(p))` 처럼 포인터 크기, 또는 대상과 다른 변수의 크기 |
| `uninit-local` | 지역 구조체 / 지역 `sz` 배열을 초기화 전에 사용. 초기화로 인정: 선언 초기값(`= {0}`, `= ""`), `memset`/`bzero`(또는 그걸 부르는 매크로)의 첫 인자, 구조체 통째 대입, `sz[0] = …`. OUT 인자로 처음 넘기거나 `strcpy`/`sprintf` 로 처음 덮어써도 경고 |
| `copy-size` | sz/ac 복사: 문자열 상수가 대상보다 김, 원본 배열이 대상보다 큼, `strncpy`/`memcpy`/`memmove` 길이가 대상보다 큼, sz 에 `strncpy(…, sizeof(대상))` (NUL 자리 없음), ac 대상에 `strcpy`/`strcat`/`sprintf`, ac 원본을 `strcpy`. 양쪽 크기가 상수로 확정될 때만 판단 (한글은 EUC-KR 기준 2바이트) |

## 제외

1소스 1헤더, 메타사전 단어, include 순서, 함수명 동사, IN/OUT 순서, 반환값 검사, 패키지 접두어, DB 관련 전부.

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `vstags.lint.enabled` | false | 켜기 |
| `vstags.lint.rules` | {} | 규칙 ID → `warning` / `information` / `hint` / `off` |
| `vstags.lint.prefixes` | 가이드 표 | 접두어 → 타입 이름 목록 (`int`, `long`, `struct`, `VARCHAR`, typedef 이름 …) |
| `vstags.lint.sqlCheckNames` | [] | sqlcode 확인으로 칠 매크로/함수 이름 (자동 인식이 안 될 때) |

## 구현

- `src/lint/lint.ts`: VS Code 와 무관한 검사 본체. 현재 문서의 파싱 결과 + 색인(typedef/매크로/멤버/함수 참조)으로 판단
- `src/lint/register.ts`: 열린 문서의 진단(Diagnostics) 표시, 입력 후 잠시 뒤 다시 검사
- lexer: 주석이 `//` 인지 표시
