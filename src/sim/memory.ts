/**
 * 시뮬레이터 값 모델.
 *  - 모든 변수/멤버/배열 원소는 Obj. 스칼라 값은 Obj.v 에 있고, 모르는 값은 UNKNOWN('?').
 *  - 모르는 값을 읽으면 NeedValue 를 던진다 (모르면 진행하지 않음).
 *  - 한 문장 실행 중의 쓰기는 undo 로그에 남겨서, 중간에 값이 필요해 멈추면 되돌린 뒤 다시 실행한다.
 */

export const UNKNOWN: unique symbol = Symbol('?');

export type CType =
  | { k: 'int'; name: string; size: number; unsigned?: boolean; guessed?: boolean }
  | { k: 'float'; name: string; size: number }
  | { k: 'ptr'; to: CType }
  | { k: 'array'; of: CType; len: number }
  | { k: 'struct'; name: string; varcharLen?: number }
  | { k: 'void' }
  | { k: 'fn'; name: string };

export interface Ptr {
  base: Obj;
  index: number;
}

export type Scalar = number | Ptr | null | typeof UNKNOWN;

/** 모르는 포인터를 역참조할 때 자동으로 만드는 가상 배열의 크기 */
export const AUTO_LEN = 1 << 20;

export class Obj {
  v: Scalar = UNKNOWN;
  elems?: Obj[];
  fields?: Map<string, Obj>;
  /** 배열 원소면 소속 배열과 인덱스 */
  parent?: Obj;
  index?: number;
  /** 모르는 포인터 p 를 위해 만든 가상 배열이면 p 의 경로 */
  autoOf?: string;
  /** p->x 처럼 표시하기 위한 포인터 경로 */
  viaPtr?: string;
  /** 값의 출처 (예: 'FETCH (줄 44)') */
  origin?: string;
  constructor(public type: CType, public path: string) {}
}

export class NeedValue extends Error {
  constructor(public obj: Obj, detail?: string) {
    super(`'${obj.path}' 값이 필요합니다${detail ? ` (${detail})` : ''}`);
  }
}
export class Unsupported extends Error {}
export class SimExit extends Error {}

export interface MemberInfo {
  name: string;
  type: CType;
}

export function isCharType(t: CType): boolean {
  return t.k === 'int' && t.size === 1;
}

export function typeName(t: CType): string {
  switch (t.k) {
    case 'int':
      return t.guessed ? `${t.name} (정의 모름)` : t.name;
    case 'float':
      return t.name;
    case 'ptr':
      return typeName(t.to) + '*';
    case 'array':
      return `${typeName(t.of)}[${t.len === AUTO_LEN ? '' : t.len}]`;
    case 'struct':
      return t.name === 'VARCHAR' ? `VARCHAR[${t.varcharLen ?? ''}]` : t.name;
    case 'void':
      return 'void';
    case 'fn':
      return 'function';
  }
}

export class Memory {
  private log: { o: Obj; v: Scalar }[] = [];

  constructor(private readonly membersOf: (t: CType & { k: 'struct' }) => MemberInfo[]) {}

  mark(): number {
    return this.log.length;
  }
  commit(): void {
    this.log.length = 0;
  }
  rollback(mark: number): void {
    while (this.log.length > mark) {
      const e = this.log.pop()!;
      e.o.v = e.v;
    }
  }

  write(o: Obj, v: Scalar): void {
    this.log.push({ o, v: o.v });
    o.v = v;
  }

  element(arr: Obj, i: number): Obj {
    if (arr.type.k !== 'array') throw new Unsupported(`'${arr.path}' 는 배열이 아닙니다`);
    const len = arr.type.len;
    if (i < 0 || (len > 0 && i >= len)) throw new Unsupported(`⚠ 배열 범위 밖: ${arr.path}[${i}] (크기 ${len})`);
    arr.elems ??= [];
    let e = arr.elems[i];
    if (!e) {
      const path = arr.autoOf !== undefined ? (i === 0 ? `*${arr.autoOf}` : `${arr.autoOf}[${i}]`) : `${arr.path}[${i}]`;
      e = new Obj(arr.type.of, path);
      e.parent = arr;
      e.index = i;
      if (arr.autoOf !== undefined && i === 0) e.viaPtr = arr.autoOf;
      e.origin = arr.origin;
      arr.elems[i] = e;
    }
    return e;
  }

  field(o: Obj, name: string): Obj {
    if (o.type.k !== 'struct') throw new Unsupported(`'${o.path}' 는 구조체가 아닙니다`);
    o.fields ??= new Map();
    let f = o.fields.get(name);
    if (!f) {
      const m = this.membersOf(o.type).find((x) => x.name === name);
      if (!m) throw new Unsupported(`'${o.type.name}' 에 멤버 '${name}' 가 없습니다 (색인에서 찾지 못함)`);
      f = new Obj(m.type, o.viaPtr ? `${o.viaPtr}->${name}` : `${o.path}.${name}`);
      f.origin = o.origin;
      o.fields.set(name, f);
    }
    return f;
  }

  allFields(o: Obj): Obj[] {
    if (o.type.k !== 'struct') return [];
    return this.membersOf(o.type).map((m) => this.field(o, m.name));
  }

  /** 모르는 포인터가 가리킬 대상을 새로 만든다 (역참조 시 지연 초기화) */
  autoTarget(p: Obj): Ptr {
    const to = p.type.k === 'ptr' ? p.type.to : p.type;
    const arr = new Obj({ k: 'array', of: to.k === 'void' ? { k: 'int', name: 'char', size: 1 } : to, len: AUTO_LEN }, p.path);
    arr.autoOf = p.path;
    arr.origin = p.origin;
    const ptr = { base: arr, index: 0 };
    p.v = ptr;
    return ptr;
  }

  unknownDeep(o: Obj, origin?: string): void {
    if (origin) o.origin = origin;
    if (o.type.k === 'array') {
      for (const e of o.elems ?? []) if (e) this.unknownDeep(e, origin);
    } else if (o.type.k === 'struct') {
      for (const f of o.fields?.values() ?? []) this.unknownDeep(f, origin);
    } else this.write(o, UNKNOWN);
  }

  zeroDeep(o: Obj): void {
    if (o.type.k === 'array') {
      const n = o.type.len === AUTO_LEN ? (o.elems?.length ?? 0) : Math.min(o.type.len, 65536);
      for (let i = 0; i < n; i++) this.zeroDeep(this.element(o, i));
    } else if (o.type.k === 'struct') {
      for (const f of this.allFields(o)) this.zeroDeep(f);
    } else if (o.type.k === 'ptr') this.write(o, null);
    else if (o.type.k === 'int' || o.type.k === 'float') this.write(o, 0);
  }

  copyDeep(dst: Obj, src: Obj): void {
    if (dst.type.k === 'array' && src.type.k === 'array') {
      const n = Math.min(dst.type.len || Infinity, src.type.len || Infinity, Math.max(src.elems?.length ?? 0, 0));
      for (let i = 0; i < n; i++) {
        const s = src.elems?.[i];
        if (s) this.copyDeep(this.element(dst, i), s);
        else this.unknownDeep(this.element(dst, i));
      }
    } else if (dst.type.k === 'struct' && src.type.k === 'struct') {
      for (const m of this.membersOf(dst.type)) this.copyDeep(this.field(dst, m.name), this.field(src, m.name));
    } else this.write(dst, src.v);
  }
}
