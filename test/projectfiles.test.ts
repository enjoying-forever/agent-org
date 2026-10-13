// The Files tab: the project folder listed, a file read and changed from the page, and what it will not do.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as gitops from '../src/gitops.ts';
import * as pf from '../src/projectfiles.ts';
import { tmpDir } from './helpers.ts';
import { startServer } from './web.ts';

function project(t: Parameters<typeof tmpDir>[0]): string {
  const root = tmpDir(t);
  mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, '.agent-org', 'worktrees'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'app.ts'), 'a\r\nb\r\n');
  writeFileSync(path.join(root, 'README.md'), '\uFEFF# hi\n');
  writeFileSync(path.join(root, 'b10.txt'), 'x');
  writeFileSync(path.join(root, 'b9.txt'), 'x');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  return root;
}

test('a folder lists folders first, by name as people sort them, without git and agent-org inside', (t) => {
  const root = project(t);
  const names = pf.list(root, '').entries.map((e) => `${e.name}${e.dir ? '/' : ''}`);
  assert.deepEqual(names, ['src/', 'b9.txt', 'b10.txt', 'logo.png', 'README.md']);
  assert.deepEqual(pf.list(root, 'src').entries.map((e) => e.name), ['deep', 'app.ts']);
});

test('only paths inside the project, and not into git or agent-org', (t) => {
  const root = project(t);
  for (const bad of ['..', '../x', 'src/../../x', 'C:/Windows', '\\\\server\\share', '.git', '.git/config', '.agent-org/worktrees', '.GIT']) {
    assert.throws(() => pf.list(root, bad), pf.FileError, bad);
  }
  assert.throws(() => pf.read(root, 'missing.txt'), (e: pf.FileError) => e.status === 404);
});

test('a link inside the project that leads out of it is refused', (t) => {
  const root = project(t);
  const outside = tmpDir(t);
  writeFileSync(path.join(outside, 'secret.txt'), 'no');
  try {
    symlinkSync(outside, path.join(root, 'out'), 'junction'); // a junction needs no rights on Windows
  } catch {
    t.skip('links cannot be made here');
    return;
  }
  assert.throws(() => pf.read(root, 'out/secret.txt'), /leads out of the project folder/);
  assert.ok(!pf.list(root, '').entries.some((e) => e.name === 'secret.txt'));
});

test('a file is read as text, stored as it was: its line ends and its byte-order mark kept', (t) => {
  const root = project(t);
  const f = pf.read(root, 'src/app.ts');
  assert.deepEqual([f.text, f.eol, f.bom], ['a\nb\n', 'crlf', false]);
  const r = pf.write(root, 'src/app.ts', 'a\nb\nc\n', f.version);
  assert.ok(r.written);
  assert.equal(readFileSync(path.join(root, 'src', 'app.ts'), 'utf8'), 'a\r\nb\r\nc\r\n');
  const md = pf.read(root, 'README.md');
  assert.deepEqual([md.text, md.bom], ['# hi\n', true]);
  pf.write(root, 'README.md', '# hello\n', md.version);
  assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), '\uFEFF# hello\n');
});

test('a file that is not text, or too big, is not opened (nor written)', (t) => {
  const root = project(t);
  const png = pf.read(root, 'logo.png');
  assert.equal(png.text, undefined);
  assert.match(png.why ?? '', /not a text file/);
  assert.throws(() => pf.write(root, 'logo.png', 'x', png.version, true), /not a text file/);
  writeFileSync(path.join(root, 'big.log'), 'x'.repeat(pf.OPEN_MAX + 1));
  assert.match(pf.read(root, 'big.log').why ?? '', /too big/);
});

test('a save over a change made since the page read the file is not written, unless said so', (t) => {
  const root = project(t);
  const f = pf.read(root, 'b9.txt');
  writeFileSync(path.join(root, 'b9.txt'), 'changed by an agent');
  assert.deepEqual(pf.write(root, 'b9.txt', 'mine', f.version).written, false);
  assert.equal(readFileSync(path.join(root, 'b9.txt'), 'utf8'), 'changed by an agent');
  assert.ok(pf.write(root, 'b9.txt', 'mine', f.version, true).written);
  assert.equal(readFileSync(path.join(root, 'b9.txt'), 'utf8'), 'mine');
});

test('the page: list, read, save; not over an agent writing the file unless said so', async (t) => {
  const server = await startServer(t);
  const root = server.hub.baseTeam.project_root;
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'main.py'), 'print(1)\n');
  const { dirs } = await server.ok(`/api/files?dirs=${encodeURIComponent(JSON.stringify(['', 'src', 'gone']))}`);
  assert.deepEqual(dirs.src.entries.map((e: pf.Entry) => e.name), ['main.py']);
  assert.ok(dirs.gone.error, 'a folder gone since: said so, the others still listed');
  const f = await server.ok('/api/file?path=src/main.py');
  assert.equal(f.text, 'print(1)\n');
  assert.deepEqual(await server.ok(`/api/file?path=src/main.py&version=${f.version}`), { same: true, held_by: '' });

  server.hub.session('worker-a').claim('src/main.py');
  const held = await server.ok('/api/file-save', { path: 'src/main.py', text: 'print(2)\n', version: f.version });
  assert.deepEqual([held.saved, held.held_by], [false, 'worker-a']);
  assert.equal(readFileSync(path.join(root, 'src', 'main.py'), 'utf8'), 'print(1)\n');
  const saved = await server.ok('/api/file-save', { path: 'src/main.py', text: 'print(2)\n', version: f.version, over_lease: true });
  assert.ok(saved.saved);
  assert.equal(readFileSync(path.join(root, 'src', 'main.py'), 'utf8'), 'print(2)\n');
  assert.ok(server.hub.store.eventsAfter(0).some((e) => e.text === 'edited src/main.py while worker-a was writing it'));

  const [status, out] = await server.request('/api/file-save', { path: '../team.yaml', text: 'x', version: '' });
  assert.deepEqual([status, /project folder/.test(out.error)], [400, true]);
});

test('branch mode: what the owner saves is committed to main, so the agents take it in and land after it', async (t) => {
  const server = await startServer(t);
  server.settings({ isolation: 'branches' });
  const root = server.hub.baseTeam.project_root;
  writeFileSync(path.join(root, 'app.py'), 'x = 1\n');
  gitops.init(root);
  const f = await server.ok('/api/file?path=app.py');
  const saved = await server.ok('/api/file-save', { path: 'app.py', text: 'x = 2\n', version: f.version });
  assert.ok(saved.saved && saved.committed, JSON.stringify(saved));
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  assert.match(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /you: edit app\.py/);
});
