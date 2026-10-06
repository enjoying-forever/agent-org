// The page's defences: one-time sign-in, session cookie, headers, and what a POST must look like.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as ui from '../src/ui.ts';
import { type Answer, request, startServer } from './web.ts';

async function web(t: TestContext) {
  const server = await startServer(t, { token: null }); // no token: only a signed-in page gets in
  const call = (method: string, target: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Answer> =>
    request(server.port, method, target, opts);
  return {
    server, call, origin: `http://127.0.0.1:${server.port}`,
    async signIn(): Promise<string> {
      const answer = await call('GET', `/?code=${server.served.access.newCode()}`);
      assert.equal(answer.status, 303);
      return String(answer.headers['set-cookie']?.[0] ?? '').split(';')[0];
    },
  };
}

const pageHeaders = (cookie: string, more: Record<string, string> = {}): Record<string, string> => ({ Cookie: cookie, 'X-Agent-Org': '1', ...more });

test('nothing without signing in', async (t) => {
  const w = await web(t);
  const answer = await w.call('GET', '/api/state', { headers: { 'X-Agent-Org': '1' } });
  assert.ok(answer.status === 403 && answer.body.includes('not signed in'));
  assert.equal((await w.call('GET', '/')).status, 200); // the page itself loads, to show how to sign in
});

test('a sign-in link works once', async (t) => {
  const w = await web(t);
  const code = w.server.served.access.newCode();
  let answer = await w.call('GET', `/?code=${code}`);
  const cookie = String(answer.headers['set-cookie']?.[0]);
  assert.ok(answer.status === 303 && answer.headers.location === '/');
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict')); // no script can read it; no other site sends it
  answer = await w.call('GET', `/?code=${code}`); // the same link again: nothing
  assert.ok(answer.status === 303 && answer.headers['set-cookie'] === undefined);
});

test('a sign-in link expires', async (t) => {
  const w = await web(t);
  const access = w.server.served.access;
  const code = access.newCode();
  access.now = () => Date.now() / 1000 + ui.CODE_TTL + 1;
  assert.equal((await w.call('GET', `/?code=${code}`)).headers['set-cookie'], undefined);
});

test("the session needs the page's own header", async (t) => {
  const w = await web(t);
  const cookie = await w.signIn();
  assert.equal((await w.call('GET', '/api/state', { headers: { Cookie: cookie } })).status, 403); // e.g. a link from elsewhere
  assert.equal((await w.call('GET', '/api/state', { headers: pageHeaders(cookie) })).status, 200);
  assert.equal((await w.call('GET', '/api/state', { headers: pageHeaders(`${ui.COOKIE}=guess`) })).status, 403);
});

test('every answer carries the security headers', async (t) => {
  const w = await web(t);
  for (const target of ['/', '/static/app.js', '/api/state']) {
    const { headers } = await w.call('GET', target);
    const csp = String(headers['content-security-policy']);
    assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("script-src 'self'"));
    assert.ok(headers['x-frame-options'] === 'DENY' && headers['x-content-type-options'] === 'nosniff');
    assert.ok(headers['referrer-policy'] === 'no-referrer' && headers['cache-control'] === 'no-store');
  }
});

test('what a POST must look like', async (t) => {
  const w = await web(t);
  const cookie = await w.signIn();
  const ok = pageHeaders(cookie, { 'Content-Type': 'application/json' });
  const body = { to: 'leader', text: 'hello' };
  assert.equal((await w.call('POST', '/api/send', { body, headers: ok })).status, 200);
  // a form on another site can only send text/plain or form data
  assert.equal((await w.call('POST', '/api/send', { body, headers: pageHeaders(cookie, { 'Content-Type': 'text/plain' }) })).status, 415);
  // sent from another site (the browser says so)
  assert.equal((await w.call('POST', '/api/send', { body, headers: { ...ok, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await w.call('POST', '/api/send', { body, headers: { ...ok, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await w.call('POST', '/api/send', { body, headers: { ...ok, Origin: w.origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  // bodies: too large, of unknown size, not an object, not JSON
  // a body declared too large is refused before anything is read (so only the size is sent here)
  assert.equal((await w.call('POST', '/api/send', { headers: { ...ok, 'Content-Length': String(ui.MAX_BODY + 10) }, raw: '{}' })).status, 413);
  assert.equal((await w.call('POST', '/api/send', { headers: { ...ok, 'Transfer-Encoding': 'chunked' } })).status, 411);
  assert.equal((await w.call('POST', '/api/send', { headers: ok, raw: '[1, 2]' })).status, 400);
  assert.equal((await w.call('POST', '/api/send', { headers: ok, raw: '{not json' })).status, 400);
  assert.ok([400, 413].includes((await w.call('POST', '/api/send', { headers: ok, raw: `${'['.repeat(100000)}${']'.repeat(100000)}` })).status));
});

test('other methods and CORS preflight are refused', async (t) => {
  const w = await web(t);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const answer = await w.call(method, '/api/send');
    assert.ok(answer.status === 405 && answer.headers['access-control-allow-origin'] === undefined);
  }
});

test('other host names are refused', async (t) => {
  const w = await web(t);
  assert.equal((await w.call('GET', '/', { headers: { Host: 'evil.example:80' } })).status, 403); // DNS rebinding
});

test('a crash shows no details', async (t) => {
  const w = await web(t);
  const cookie = await w.signIn();
  const before = ui.GET_ROUTES['/api/state'];
  ui.GET_ROUTES['/api/state'] = () => { throw new TypeError('secret detail at C:\\Users\\someone'); };
  t.after(() => { ui.GET_ROUTES['/api/state'] = before; });
  const errors = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write; // it is logged for the owner, not shown
  let answer: Answer;
  try {
    answer = await w.call('GET', '/api/state', { headers: pageHeaders(cookie) });
  } finally {
    process.stderr.write = errors;
  }
  assert.ok(answer.status === 500 && !answer.body.includes('secret detail') && !answer.body.includes('TypeError'));
});
