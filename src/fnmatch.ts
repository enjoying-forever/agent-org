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

/** One part of a pattern: '*', or one character it takes (`chars`: all it takes, when that is a short list). */
type Tok = { star: true } | { star: false; has: (c: string) => boolean; chars: string[] | null; any?: true };

function tokens(pattern: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    i += 1;
    if (c === '*') {
      if (!out.length || !out[out.length - 1].star) out.push({ star: true }); // '**' is '*'
    } else if (c === '?') {
      out.push({ star: false, has: () => true, chars: null, any: true });
    } else if (c === '[' && translate(pattern.slice(i - 1)).startsWith('[')) { // a set (an unclosed '[' is a plain one)
      let j = i;
      if (pattern[j] === '!') j += 1;
      if (pattern[j] === ']') j += 1;
      while (pattern[j] !== ']') j += 1;
      const set = pattern.slice(i - 1, j + 1);
      i = j + 1;
      const re = new RegExp(`^${translate(set)}$`, 's');
      const body = set.slice(1, -1);
      let chars: string[] | null = null;
      if (!body.startsWith('!')) { // which characters it takes, when that is a short list (a-z is 26)
        chars = [];
        for (let k = 0; k < body.length && chars !== null; k++) {
          if (body[k + 1] === '-' && k + 2 < body.length) {
            const [from, to] = [body.charCodeAt(k), body.charCodeAt(k + 2)];
            if (to - from > 256) chars = null;
            else for (let n = from; n <= to; n++) chars.push(String.fromCharCode(n));
            k += 2;
          } else {
            chars.push(body[k]);
          }
        }
      }
      out.push({ star: false, has: (x) => re.test(x), chars });
    } else {
      out.push({ star: false, has: (x) => x === c, chars: [c] });
    }
  }
  return out;
}

/** Whether every name `inner` matches is matched by `outer` too - so a manager with `outer` may hand on `inner`.
 * Errs on the side of no: a pattern that only seems narrower (src/?.ts under src/a*) is not within it. */
export function patternWithin(inner: string, outer: string): boolean {
  const a = tokens(inner);
  const b = tokens(outer);
  const seen = new Map<number, boolean>();
  const within = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) return known;
    let yes: boolean;
    if (i === a.length) {
      yes = b.slice(j).every((t) => t.star); // only the empty name is left
    } else if (j === b.length) {
      yes = false;
    } else {
      const [p, o] = [a[i], b[j]];
      if (o.star) {
        yes = within(i, j + 1) || within(i + 1, j); // outer's '*' takes nothing more, or takes p's part too
      } else if (p.star) {
        yes = false; // any length against one character
      } else {
        yes = p.chars !== null ? p.chars.every((c) => o.has(c)) && within(i + 1, j + 1)
          : o.any === true && within(i + 1, j + 1); // '?' or [!x]: only within '?'
      }
    }
    seen.set(key, yes);
    return yes;
  };
  return within(0, 0);
}
