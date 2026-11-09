/**
 * 관대한(error-tolerant) C / Pro*C 렉서.
 *
 * - 주석/문자열/문자 리터럴을 건너뛰고 식별자, 숫자, 구두점, 전처리 지시문을 토큰화한다.
 * - 종결되지 않은 문자열/문자 리터럴은 줄 끝에서 끊어서 이후 파싱이 무너지지 않게 한다.
 * - `EXEC SQL ... ;` / `EXEC ORACLE ... ;` / `EXEC SQL EXECUTE BEGIN ... END-EXEC;` 블록은
 *   C 파서에 넘기지 않고 통째로 건너뛰되, 그 안의 유용한 정보만 특수 토큰으로 내보낸다.
 *     :host_var            -> SqlHost
 *     WHENEVER ... DO fn   -> SqlCall
 *     WHENEVER ... GOTO l  -> SqlGoto
 *     DECLARE c CURSOR     -> SqlCursorDef
 *     OPEN/FETCH/CLOSE c   -> SqlCursorRef
 *     INCLUDE file         -> SqlInclude
 *   그리고 문장 끝에 SqlStmt 를 하나 내보낸다 (C 의 ';' 처럼 문장 경계 역할).
 *
 * 컬럼은 JS 문자열 인덱스(UTF-16) 기준이며 VSCode 의 컬럼과 같다.
 */

export const enum Tk {
  Ident = 1,
  Number,
  Str,
  Chr,
  Punct,
  /** 전처리 지시문 시작. v = 지시문 이름 (define, include, if ...) */
  PPStart,
  /** 전처리 지시문 끝 (줄 끝) */
  PPEnd,
  SqlHost,
  SqlCall,
  SqlGoto,
  SqlCursorDef,
  SqlCursorRef,
  SqlInclude,
  SqlStmt,
}

export interface Token {
  k: Tk;
  v: string;
  line: number;
  col: number;
  off: number;
  end: number;
}

const PUNCT3 = new Set(['<<=', '>>=', '...']);
const PUNCT2 = new Set([
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '::',
]);

const EXEC_KINDS = new Set(['SQL', 'ORACLE', 'TOOLS', 'IAF']);
const FETCH_SKIP = new Set(['NEXT', 'PRIOR', 'FIRST', 'LAST', 'CURRENT', 'RELATIVE', 'ABSOLUTE', 'FROM']);

function isIdStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
}
function isIdPart(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** 주석 (정의 위/옆 설명을 붙이기 위해 따로 모음). ownLine: 그 줄에 주석 앞 코드가 없음 */
export interface Comment {
  line: number;
  endLine: number;
  col: number;
  ownLine: boolean;
  text: string;
  /** false 면 `//` 주석 */
  block: boolean;
}

/** @param comments 주어지면 주석을 여기에 모은다 (토큰 흐름에는 영향 없음) */
export function lex(src: string, comments?: Comment[]): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 0;
  let lineStart = 0;
  let inPP = false;
  let atLineStart = true;

  const push = (k: Tk, v: string, s: number, e: number) => {
    toks.push({ k, v, line, col: s - lineStart, off: s, end: e });
  };

  /** 블록 주석 건너뛰기. i 는 '/*' 위치. 반환: 주석 다음 위치 */
  const skipBlockComment = (pos: number): number => {
    pos += 2;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c === 42 && src.charCodeAt(pos + 1) === 47) return pos + 2;
      if (c === 10) {
        line++;
        lineStart = pos + 1;
      }
      pos++;
    }
    return n;
  };

  /** 따옴표 리터럴. 종결되지 않으면 줄 끝에서 멈춘다. */
  const skipQuoted = (pos: number, q: number): number => {
    pos++;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c === 92) {
        // escape (줄 연속 포함)
        if (src.charCodeAt(pos + 1) === 10) {
          line++;
          lineStart = pos + 2;
        } else if (src.charCodeAt(pos + 1) === 13 && src.charCodeAt(pos + 2) === 10) {
          line++;
          lineStart = pos + 3;
          pos++;
        }
        pos += 2;
        continue;
      }
      if (c === q) return pos + 1;
      if (c === 10) return pos; // 종결 안 된 리터럴
      pos++;
    }
    return n;
  };

  /**
   * EXEC SQL / EXEC ORACLE 블록 스캔.
   * start: 'EXEC' 위치, pos: 'SQL' 등 다음 위치.
   */
  const scanExec = (start: number, pos: number, kind: string) => {
    interface W { up: string; raw: string; line: number; col: number; off: number; end: number }
    const words: W[] = [];
    let plsql = false;
    let expectCursor = false;
    let expectDo = false;
    let expectGoto = false;
    let includeStart = -1;
    const emit = (k: Tk, w: { raw: string; line: number; col: number; off: number; end: number }) => {
      toks.push({ k, v: w.raw, line: w.line, col: w.col, off: w.off, end: w.end });
    };

    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c === 10) {
        if (inPP) break; // 지시문 안의 EXEC SQL 은 줄 끝에서 끝
        line++;
        pos++;
        lineStart = pos;
        continue;
      }
      if (c === 92 && inPP) {
        // 지시문 줄 연속
        let j = pos + 1;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 13)) j++;
        if (src.charCodeAt(j) === 10) {
          line++;
          pos = j + 1;
          lineStart = pos;
          continue;
        }
      }
      if (c === 32 || c === 9 || c === 13 || c === 12) {
        pos++;
        continue;
      }
      // 주석
      if (c === 45 && src.charCodeAt(pos + 1) === 45) {
        while (pos < n && src.charCodeAt(pos) !== 10) pos++;
        continue;
      }
      if (c === 47 && src.charCodeAt(pos + 1) === 42) {
        pos = skipBlockComment(pos);
        continue;
      }
      if (c === 47 && src.charCodeAt(pos + 1) === 47) {
        while (pos < n && src.charCodeAt(pos) !== 10) pos++;
        continue;
      }
      if (c === 39 || c === 34) {
        // SQL 문자열 ('' 이스케이프는 연속된 두 리터럴로 자연스럽게 처리됨)
        const q = c;
        pos++;
        while (pos < n && src.charCodeAt(pos) !== q) {
          if (src.charCodeAt(pos) === 10) {
            if (inPP) break;
            line++;
            lineStart = pos + 1;
          }
          pos++;
        }
        if (pos < n && src.charCodeAt(pos) === q) pos++;
        continue;
      }
      if (c === 59) {
        // ';'
        if (!plsql) {
          pos++;
          break;
        }
        pos++;
        continue;
      }
      if (c === 58) {
        // ':' host variable
        let j = pos + 1;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        if (j < n && isIdStart(src.charCodeAt(j))) {
          let e = j + 1;
          while (e < n && isIdPart(src.charCodeAt(e))) e++;
          emit(Tk.SqlHost, { raw: src.slice(j, e), line, col: j - lineStart, off: j, end: e });
          pos = e;
          continue;
        }
        pos++;
        continue;
      }
      if (isIdStart(c) || c === 35) {
        let e = pos + 1;
        while (e < n && (isIdPart(src.charCodeAt(e)) || src.charCodeAt(e) === 35)) e++;
        const raw = src.slice(pos, e);
        const up = raw.toUpperCase();
        const w: W = { up, raw, line, col: pos - lineStart, off: pos, end: e };

        // END-EXEC
        if (up === 'END' && src.charCodeAt(e) === 45 && src.slice(e + 1, e + 5).toUpperCase() === 'EXEC') {
          pos = e + 5;
          if (plsql) {
            // 다음 ';' 까지
            while (pos < n && src.charCodeAt(pos) !== 59 && src.charCodeAt(pos) !== 10) pos++;
            if (src.charCodeAt(pos) === 59) pos++;
            break;
          }
          continue;
        }

        if (expectCursor) {
          if (FETCH_SKIP.has(up)) {
            // FETCH NEXT FROM c1
          } else {
            emit(Tk.SqlCursorRef, w);
            expectCursor = false;
          }
        } else if (expectDo) {
          expectDo = false;
          if (up === 'CALL') {
            expectDo = true;
          } else if (up !== 'BREAK' && up !== 'CONTINUE') {
            emit(Tk.SqlCall, w);
          }
        } else if (expectGoto) {
          if (up === 'TO') {
            // GO TO label
          } else {
            emit(Tk.SqlGoto, w);
            expectGoto = false;
          }
        }

        words.push(w);
        const wi = words.length - 1;
        if (wi === 1 && words[0].up === 'EXECUTE' && (up === 'BEGIN' || up === 'DECLARE')) plsql = true;
        if (words[0].up === 'CREATE' && wi <= 4 && /^(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)$/.test(up)) plsql = true;
        if (up === 'CURSOR' && wi >= 2 && words[wi - 2].up === 'DECLARE') emit(Tk.SqlCursorDef, words[wi - 1]);
        if ((up === 'OPEN' || up === 'CLOSE' || up === 'FETCH') && wi <= 3) expectCursor = true;
        if (up === 'OF' && wi >= 1 && words[wi - 1].up === 'CURRENT') expectCursor = true;
        if (words[0].up === 'WHENEVER') {
          if (up === 'DO') expectDo = true;
          if (up === 'GOTO' || up === 'GO') expectGoto = true;
        }
        if (wi === 0 && up === 'INCLUDE') includeStart = e;
        pos = e;
        continue;
      }
      pos++;
    }

    if (includeStart >= 0 && kind === 'SQL') {
      const raw = src.slice(includeStart, pos).replace(/;\s*$/, '').trim().replace(/^["'<]|["'>]$/g, '');
      if (raw) toks.push({ k: Tk.SqlInclude, v: raw, line, col: 0, off: includeStart, end: pos });
    }
    toks.push({ k: Tk.SqlStmt, v: 'EXEC ' + kind, line, col: 0, off: start, end: pos });
    i = pos;
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    if (c === 10) {
      if (inPP) {
        push(Tk.PPEnd, '', i, i);
        inPP = false;
      }
      line++;
      i++;
      lineStart = i;
      atLineStart = true;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) {
      i++;
      continue;
    }
    if (c === 92) {
      // 줄 연속
      let j = i + 1;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 13)) j++;
      if (j < n && src.charCodeAt(j) === 10) {
        i = j + 1;
        line++;
        lineStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        const s0 = i;
        while (i < n && src.charCodeAt(i) !== 10) i++;
        comments?.push({ line, endLine: line, col: s0 - lineStart, ownLine: atLineStart && !inPP, text: src.slice(s0 + 2, i).replace(/\r$/, ''), block: false });
        continue;
      }
      if (d === 42) {
        const s0 = i;
        const l0 = line;
        const c0 = i - lineStart;
        i = skipBlockComment(i);
        comments?.push({ line: l0, endLine: line, col: c0, ownLine: atLineStart && !inPP, text: src.slice(s0 + 2, src.startsWith('*/', i - 2) ? i - 2 : i), block: true });
        continue;
      }
    }

    if (c === 35 && atLineStart && !inPP) {
      // 전처리 지시문
      let j = i + 1;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
      let e = j;
      while (e < n && isIdPart(src.charCodeAt(e))) e++;
      const name = src.slice(j, e);
      push(Tk.PPStart, name, i, e);
      inPP = true;
      atLineStart = false;
      i = e;
      if (name === 'include' || name === 'include_next' || name === 'import') {
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        const open = src.charCodeAt(i);
        if (open === 60 || open === 34) {
          const close = open === 60 ? 62 : 34;
          let k = i + 1;
          while (k < n && src.charCodeAt(k) !== close && src.charCodeAt(k) !== 10) k++;
          push(Tk.Str, src.slice(i + 1, k), i, k + 1);
          i = src.charCodeAt(k) === close ? k + 1 : k;
        }
      } else if (name === 'error' || name === 'warning' || name === 'pragma' || name === 'ident' || name === 'sccs') {
        // 자유 텍스트: 줄 끝까지 무시 (아포스트로피 등으로 리터럴이 꼬이지 않게)
        while (i < n && src.charCodeAt(i) !== 10) {
          if (src.charCodeAt(i) === 92 && (src.charCodeAt(i + 1) === 10 || (src.charCodeAt(i + 1) === 13 && src.charCodeAt(i + 2) === 10))) {
            i += src.charCodeAt(i + 1) === 13 ? 3 : 2;
            line++;
            lineStart = i;
            continue;
          }
          i++;
        }
      }
      continue;
    }
    atLineStart = false;

    if (isIdStart(c)) {
      let e = i + 1;
      while (e < n && isIdPart(src.charCodeAt(e))) e++;
      const v = src.slice(i, e);
      if (e - i === 4 && v.toUpperCase() === 'EXEC') {
        let k = e;
        while (k < n) {
          const ck = src.charCodeAt(k);
          if (ck === 32 || ck === 9 || ck === 13) k++;
          else if (ck === 10 && !inPP) {
            k++;
          } else break;
        }
        let ke = k;
        while (ke < n && isIdPart(src.charCodeAt(ke))) ke++;
        const kind = src.slice(k, ke).toUpperCase();
        if (EXEC_KINDS.has(kind)) {
          // EXEC 와 SQL 사이의 줄바꿈을 반영
          for (let q = e; q < k; q++) {
            if (src.charCodeAt(q) === 10) {
              line++;
              lineStart = q + 1;
            }
          }
          scanExec(i, ke, kind);
          continue;
        }
      }
      // 접두사가 붙은 문자열/문자 리터럴: L"..", u8"..", U'..'
      const nc = src.charCodeAt(e);
      if ((nc === 34 || nc === 39) && (v === 'L' || v === 'u' || v === 'U' || v === 'u8')) {
        const end = skipQuoted(e, nc);
        push(nc === 34 ? Tk.Str : Tk.Chr, '', i, end);
        i = end;
        continue;
      }
      push(Tk.Ident, v, i, e);
      i = e;
      continue;
    }

    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      let e = i + 1;
      while (e < n) {
        const d = src.charCodeAt(e);
        if (isIdPart(d) || d === 46) {
          e++;
        } else if ((d === 43 || d === 45) && /[eEpP]/.test(src[e - 1])) {
          e++;
        } else break;
      }
      push(Tk.Number, src.slice(i, e), i, e);
      i = e;
      continue;
    }

    if (c === 34 || c === 39) {
      const startLine = line;
      const startCol = i - lineStart;
      const end = skipQuoted(i, c);
      toks.push({ k: c === 34 ? Tk.Str : Tk.Chr, v: '', line: startLine, col: startCol, off: i, end });
      i = end;
      continue;
    }

    const s3 = src.substr(i, 3);
    if (PUNCT3.has(s3)) {
      push(Tk.Punct, s3, i, i + 3);
      i += 3;
      continue;
    }
    const s2 = src.substr(i, 2);
    if (PUNCT2.has(s2)) {
      push(Tk.Punct, s2, i, i + 2);
      i += 2;
      continue;
    }
    push(Tk.Punct, src[i], i, i + 1);
    i++;
  }
  if (inPP) push(Tk.PPEnd, '', n, n);
  return toks;
}
