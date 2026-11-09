export type DefKind =
  | 'function'
  | 'prototype'
  | 'macro'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumerator'
  | 'typedef'
  | 'variable'
  | 'extern'
  | 'member'
  | 'local'
  | 'param'
  | 'label'
  | 'cursor';

/** 파일 범위로만 의미가 있는 정의 (workspace 검색/전역 정의 이동에서 제외) */
export const SCOPED_KINDS: ReadonlySet<DefKind> = new Set<DefKind>(['local', 'param', 'label']);

export interface Def {
  name: string;
  kind: DefKind;
  /** 0-based */
  line: number;
  col: number;
  /** 함수/구조체/매크로의 끝 줄 */
  endLine?: number;
  /** member/enumerator 가 속한 struct/union/enum 이름 */
  container?: string;
  /** 변수/멤버/파라미터/typedef 의 기본 타입 이름 (struct 태그 또는 typedef 이름) */
  type?: string;
  /** 호버 등에 보여줄 선언 텍스트 */
  sig?: string;
  isStatic?: boolean;
  /** local/param/label: 속한 함수 정의의 defs 인덱스 */
  scope?: number;
  /** 정의 바로 위에 붙은 주석 / 같은 줄 오른쪽 주석 (기호 제거, 앞부분만) */
  doc?: string;
}

/** refs 배열에서 한 참조가 차지하는 int 개수: [nameIdx, line, col, flags, enclosingDefIdx] */
export const REF_STRIDE = 5;

export const enum RefFlag {
  Call = 1,
  /** '.' 또는 '->' 뒤 (구조체 멤버 접근) */
  Member = 2,
  /** 대입/증감 대상 */
  Write = 4,
  /** EXEC SQL 블록 안 (:host 변수, WHENEVER DO 등) */
  Sql = 8,
  /** #if / #ifdef / #undef 등 전처리 조건 */
  PP = 16,
  /** & 로 주소를 취함 (함수 포인터 등록 등) */
  Addr = 32,
}

export interface FileIndex {
  path: string;
  mtime: number;
  size: number;
  defs: Def[];
  /** refs 가 참조하는 이름 테이블 */
  names: string[];
  refs: Int32Array;
  includes: string[];
}

export interface RefHit {
  file: FileIndex;
  name: string;
  line: number;
  col: number;
  flags: number;
  /** 참조를 감싸는 정의 (함수/매크로/전역변수 초기화식) 인덱스, 없으면 -1 */
  enclosing: number;
}

export interface DefHit {
  file: FileIndex;
  def: Def;
  index: number;
}
