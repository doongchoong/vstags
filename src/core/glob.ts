/**
 * 간단한 glob -> RegExp 변환 (**, *, ?, {a,b}, [abc] 지원).
 * 경로 구분자는 '/' 로 정규화해서 비교한다. 대소문자 무시 (Windows 대응).
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inGroup = 0;
  const g = glob.replace(/\\/g, '/');
  if (!g.startsWith('/') && !/^[a-zA-Z]:/.test(g)) re += '(?:^|/)';
  else re += '^';
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const j = g.indexOf(']', i);
      if (j > i) {
        re += '[' + g.slice(i + 1, j).replace(/^!/, '^') + ']';
        i = j;
      } else re += '\\[';
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  return new RegExp(re.replace(/^\(\?:\^\|\/\)\(\?:\.\*\/\)\?/, '(?:^|/)') + '$', 'i');
}

export function makeMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p: string) => {
    const n = p.replace(/\\/g, '/');
    return res.some((r) => r.test(n));
  };
}
