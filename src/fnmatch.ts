/**
 * Python's fnmatch.fnmatchcase: '*' matches anything (slashes too), '?' one character,
 * '[abc]' / '[!abc]' a set. Case-sensitive; callers fold case themselves where they need to.
 */

const cache = new Map<string, RegExp>();

export function fnmatchcase(name: string, pattern: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${translate(pattern)}$`, 's');
    if (cache.size > 2000) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(name);
}

function translate(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    i += 1;
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      let j = i;
      if (j < pattern.length && pattern[j] === '!') j += 1;
      if (j < pattern.length && pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        out += '\\[';
      } else {
        let set = pattern.slice(i, j).replace(/\\/g, '\\\\');
        i = j + 1;
        if (set.startsWith('!')) set = `^${set.slice(1)}`;
        else if (set.startsWith('^')) set = `\\${set}`;
        out += `[${set}]`;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return out;
}
