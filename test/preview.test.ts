// The page's browser: the local addresses the team's work shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localUrls } from '../src/preview.ts';
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
