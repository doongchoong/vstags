import * as path from 'path';
import { DefKind, FileIndex } from './types';

const KIND_LETTER: Record<DefKind, string> = {
  function: 'f',
  prototype: 'p',
  macro: 'd',
  struct: 's',
  union: 'u',
  enum: 'g',
  enumerator: 'e',
  typedef: 't',
  variable: 'v',
  extern: 'x',
  member: 'm',
  cursor: 'C',
  local: 'l',
  param: 'z',
  label: 'L',
};

/**
 * vim/emacs 등에서 쓸 수 있는 Exuberant/Universal ctags 호환 tags 파일 내용.
 * 지역 변수/파라미터/레이블은 제외.
 */
export function toCtags(files: Iterable<FileIndex>, root: string): string {
  const lines: string[] = [];
  for (const fi of files) {
    const rel = path.relative(root, fi.path).replace(/\\/g, '/');
    for (const d of fi.defs) {
      if (d.kind === 'local' || d.kind === 'param' || d.kind === 'label') continue;
      let l = `${d.name}\t${rel}\t${d.line + 1};"\t${KIND_LETTER[d.kind]}\tline:${d.line + 1}`;
      if (d.container && (d.kind === 'member' || d.kind === 'enumerator')) {
        l += `\t${d.kind === 'enumerator' ? 'enum' : 'struct'}:${d.container}`;
      }
      if (d.isStatic) l += '\tfile:';
      lines.push(l);
    }
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '!_TAG_FILE_FORMAT\t2\t/extended format/\n' +
    '!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/\n' +
    '!_TAG_PROGRAM_NAME\tvstags\t//\n' +
    lines.join('\n') +
    '\n'
  );
}
