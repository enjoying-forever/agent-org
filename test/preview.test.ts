// The page's browser: the local addresses the team's work shows.
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Server, Tools } from '../src/mcp_server.ts';
import { localUrls, type PageView, type ViewOptions } from '../src/preview.ts';
import * as ui from '../src/ui.ts';
import { startServer } from './web.ts';

test('local addresses in terminal output and messages, newest first, each once', () => {
  const vite = '\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n';
  const seen = [
    { text: 'Serving on http://0.0.0.0:8000. Press Ctrl+C.', at: 10 },
    { text: vite, at: 20 }, // the port in another color: the codes between are taken out
    { text: 'Done: open http://127.0.0.1:3000/app/index.html, or https://example.com (not ours).', at: 30 },
    { text: 'again http://localhost:8000/', at: 5 }, // older than the first sighting: stays where that put it
    { text: 'agent-org itself: http://127.0.0.1:8765/?code=x', at: 40 },
  ];
  assert.deepEqual(localUrls(seen, 8765), ['http://127.0.0.1:3000/app/index.html', 'http://localhost:5173/', 'http://localhost:8000/']);
  assert.deepEqual(localUrls([{ text: 'nothing here, https://github.com', at: 1 }]), []);
});

test('the page asks for them', async (t) => {
  const server = await startServer(t);
  server.app.hub.session('leader').send('you', 'The shop runs at http://localhost:4321 now.');
  assert.deepEqual((await server.ok('/api/previews')).urls, ['http://localhost:4321/']);
});

test("an agent's view_page goes through the agent-org window, with a picture for a program that takes one", async (t) => {
  const server = await startServer(t);
  const app = server.app;
  const asked: [string, ViewOptions][] = [];
  const look: PageView = { url: 'http://localhost:5173/', title: 'Shop', text: 'Apples 2.40', errors: ['Uncaught TypeError: x is undefined'],
    notes: ['click #buy: clicked'], image: 'AAAA', width: 390, height: 844 };
  app.window.shell = { show: () => {}, hide: () => {}, quit: () => {}, view: async (url, opts) => { asked.push([url, opts]); return look; } };
  ui.writeInstance(server.port, app.window.launcher);
  const hub = app.hub;
  // Claude takes pictures: text and the screenshot
  const [text, err, pictures] = await new Tools(hub.session('leader')).call('view_page', { url: '5173', steps: ['click #buy'], mobile: true });
  assert.ok(!err, text);
  assert.deepEqual(asked[0], ['http://localhost:5173/', { width: 390, height: 844, steps: ['click #buy'] }]);
  assert.ok(text.includes('Shop - http://localhost:5173/ (390x844, screenshot below)') && text.includes('- click #buy: clicked')
    && text.includes('Uncaught TypeError') && text.includes('Apples 2.40'), text);
  assert.deepEqual(pictures, [{ data: 'AAAA', mimeType: 'image/jpeg' }]);
  // a file in the agent's copy of the project
  await new Tools(hub.session('researcher')).call('view_page', { url: 'site/index.html' });
  assert.equal(asked[1][0], pathToFileURL(path.join(hub.rootOf('researcher'), 'site', 'index.html')).href);
  // Grok gets the text only
  const [, , none] = await new Tools(hub.session('researcher')).call('view_page', { url: 'http://localhost:5173/' });
  assert.equal(none, undefined);
  // the owner sees who looked at what
  assert.ok((await server.ok('/api/events?after=0')).events.some((e: any) => e.role === 'leader' && e.text.includes('looked at http://localhost:5173/')));
  // and over MCP the picture is image content
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  const mcp = new Server(hub.session('leader'), input, output);
  const done = mcp.serve();
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'view_page', arguments: { url: '5173' } } })}\n`);
  const reply = JSON.parse(await new Promise<string>((resolve) => { let b = ''; output.on('data', (c: string) => { b += c; if (b.includes('\n')) resolve(b.split('\n')[0]); }); }));
  assert.deepEqual(reply.result.content.slice(1), [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
  input.end();
  await done;
  // without the window: said plainly
  app.window.shell = null;
  const [why, failed] = await new Tools(hub.session('leader')).call('view_page', { url: '5173' });
  assert.ok(failed && why.includes('runs without its window'), why);
});
