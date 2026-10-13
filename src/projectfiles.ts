// The project folder as the owner's page shows it: its folders listed one at a time, a text file read, and
// changed. Only inside the project folder (a link or a junction that leads out of it is refused too), never in
// git's or agent-org's own folders, and only text: a file that is not text, or too big, is shown but not opened.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const OPEN_MAX = 1024 * 1024; // the largest file opened for reading and writing in the page
export const LIST_MAX = 2000; // entries listed in one folder
const HIDDEN = new Set(['.git', '.agent-org']); // git's own, and agent-org's (the agents' copies in branch mode)
const BOM = '﻿';

export class FileError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Entry { name: string; dir: boolean; size: number; mtime: number }
export interface Listing { path: string; entries: Entry[]; more: number }
export interface Opened {
  path: string; size: number; version: string;
  text?: string; eol?: 'lf' | 'crlf'; bom?: boolean; // a text file
  why?: string; // why it is not opened: not text, or too big
}

/** The folder `rel` names, inside `root`: [its full path, the path as the page shows it ('' for the root)]. */
export function inside(root: string, rel: string): [string, string] {
  const base = path.resolve(root);
  const text = String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (text.includes('\0') || /^[a-z]:/i.test(text) || text.startsWith('//')) throw new FileError('Only paths in the project folder.');
  const full = path.resolve(base, text);
  const shown = path.relative(base, full).split(path.sep).join('/');
  if (shown.startsWith('..') || path.isAbsolute(shown)) throw new FileError('Only paths in the project folder.');
  if (shown && HIDDEN.has(shown.split('/')[0].toLowerCase())) throw new FileError(`${shown} is kept by git or agent-org, not shown here.`);
  // where it really is: a link or a junction inside the folder must not lead out of it
  let real: string;
  try {
    real = realpathSync.native(full);
  } catch {
    throw new FileError(`${shown || 'The project folder'} is not there (any more).`, 404);
  }
  const back = path.relative(realpathSync.native(base), real);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new FileError(`${shown} leads out of the project folder.`);
  return [full, shown];
}

/** One folder of the project: folders first, then files, each by name. */
export function list(root: string, rel: string): Listing {
  const [full, shown] = inside(root, rel);
  if (!statSync(full).isDirectory()) throw new FileError(`${shown} is not a folder.`);
  const entries: Entry[] = [];
  for (const d of readdirSync(full, { withFileTypes: true })) {
    if (!shown && HIDDEN.has(d.name.toLowerCase())) continue;
    try {
      const s = statSync(path.join(full, d.name)); // through a link: what it leads to
      entries.push({ name: d.name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: Math.floor(s.mtimeMs / 1000) });
    } catch {
      // gone, or a broken link
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: shown, entries: entries.slice(0, LIST_MAX), more: Math.max(0, entries.length - LIST_MAX) };
}

const versionOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex').slice(0, 16);

/** A file's text, with how it was stored (its line ends, a byte-order mark), and a version to save against. */
export function read(root: string, rel: string): Opened {
  const [full, shown] = inside(root, rel);
  const s = statSync(full);
  if (!s.isFile()) throw new FileError(`${shown} is not a file.`);
  if (s.size > OPEN_MAX) return { path: shown, size: s.size, version: '', why: `It is too big to open here (over ${OPEN_MAX / 1024 / 1024} MB).` };
  const bytes = readFileSync(full);
  const version = versionOf(bytes);
  let text: string;
  try {
    if (bytes.subarray(0, 8000).includes(0)) throw new Error('binary');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { path: shown, size: s.size, version, why: 'It is not a text file.' };
  }
  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { path: shown, size: s.size, version, text: text.replace(/\r\n/g, '\n'), eol: crlf > lf ? 'crlf' : 'lf', bom };
}

/** What a file holds now: its version (to see whether it changed since the page read it), '' if it is gone. */
export function versionNow(root: string, rel: string): string {
  try {
    const [full] = inside(root, rel);
    const s = statSync(full);
    return s.isFile() && s.size <= OPEN_MAX ? versionOf(readFileSync(full)) : '';
  } catch {
    return '';
  }
}

/** Write `text` to an existing text file, stored as it was (line ends, byte-order mark). `version` is what the
 * page read: if the file changed since, nothing is written (unless `force`) and the answer says so. */
export function write(root: string, rel: string, text: string, version: string, force = false): { written: boolean; version: string; path: string; size: number } {
  const now = read(root, rel); // a file there, inside, and text
  if (now.text === undefined) throw new FileError(`${now.path}: ${now.why}`);
  if (typeof text !== 'string') throw new FileError('send the text');
  if (Buffer.byteLength(text) > OPEN_MAX) throw new FileError(`At most ${OPEN_MAX / 1024 / 1024} MB.`);
  if (!force && now.version !== version) return { written: false, version: now.version, path: now.path, size: now.size };
  let body = text.replace(/\r\n/g, '\n');
  if (now.eol === 'crlf') body = body.replace(/\n/g, '\r\n');
  if (now.bom) body = BOM + body;
  const [full] = inside(root, rel);
  writeFileSync(full, body, 'utf8');
  const bytes = readFileSync(full);
  return { written: true, version: versionOf(bytes), path: now.path, size: bytes.length };
}
