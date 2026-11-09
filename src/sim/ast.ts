/** 블록 시뮬레이터용 C 구문 트리 (함수 본문의 문장/식) */

export interface TypeSpec {
  /** 지정자 단어들: ['unsigned', 'long'], ['struct', 'emp_rec'], ['EmpRec'] ... */
  base: string[];
  ptr: number;
  /** 배열 차원 (int a[2][3] -> [2, 3]). 크기 생략은 null */
  dims: (Expr | null)[];
  /** 함수 포인터 (*fp)(...) */
  fnPtr?: boolean;
}

interface Pos {
  id: number;
  line: number;
  col: number;
}

export type Expr = Pos &
  (
    | { k: 'num'; v: number; float: boolean }
    | { k: 'str'; v: string }
    | { k: 'ident'; name: string }
    | { k: 'unary'; op: string; e: Expr }
    | { k: 'postfix'; op: string; e: Expr }
    | { k: 'binary'; op: string; l: Expr; r: Expr }
    | { k: 'assign'; op: string; l: Expr; r: Expr }
    | { k: 'cond'; c: Expr; t: Expr; f: Expr }
    | { k: 'call'; callee: Expr; args: Expr[] }
    | { k: 'index'; e: Expr; i: Expr }
    | { k: 'member'; e: Expr; name: string; arrow: boolean }
    | { k: 'cast'; type: TypeSpec; e: Expr }
    | { k: 'sizeof'; type?: TypeSpec; e?: Expr }
    | { k: 'init'; items: Expr[] }
  );

export interface Declarator {
  name: string;
  type: TypeSpec;
  init?: Expr;
  line: number;
}

export interface SqlHost {
  name: string;
  /** SELECT/FETCH ... INTO 의 출력 변수 */
  out: boolean;
}

export type WheneverAction =
  | { k: 'continue' }
  | { k: 'goto'; label: string }
  | { k: 'break' }
  | { k: 'loopContinue' }
  | { k: 'do'; fn: string }
  | { k: 'stop' };

interface SPos {
  id: number;
  line: number;
  endLine: number;
}

export type Stmt = SPos &
  (
    | { k: 'expr'; e: Expr }
    | { k: 'decl'; decls: Declarator[] }
    | { k: 'if'; c: Expr; t: Stmt; f?: Stmt }
    | { k: 'while'; c: Expr; body: Stmt }
    | { k: 'do'; body: Stmt; c: Expr }
    | { k: 'for'; init?: Stmt; c?: Expr; step?: Expr; body: Stmt }
    | { k: 'switch'; e: Expr; body: Stmt }
    | { k: 'case'; e?: Expr; body: Stmt } // e 없으면 default
    | { k: 'block'; body: Stmt[] }
    | { k: 'return'; e?: Expr }
    | { k: 'break' }
    | { k: 'continue' }
    | { k: 'goto'; label: string }
    | { k: 'label'; name: string; body: Stmt }
    | {
        k: 'sql';
        /** EXEC SQL ... ; 원문 */
        text: string;
        /** SELECT, FETCH, UPDATE, WHENEVER ... (대문자) */
        verb: string;
        hosts: SqlHost[];
        whenever?: { cond: 'notFound' | 'sqlerror' | 'sqlwarning'; action: WheneverAction };
      }
    | { k: 'empty' }
    | { k: 'unsupported'; msg: string }
    /**
     * 함수 중간(반복문/switch 안)에서 시작했을 때: rest 를 실행한 뒤 바깥 loop 를 이어서 돈다.
     * rest 안의 break/continue 는 loop 기준으로 처리한다. (시뮬레이터가 만드는 합성 노드)
     */
    | { k: 'resume'; loop: Stmt; rest: Stmt[] }
  );
