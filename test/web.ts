/** A running agent-org server for a test, and a plain HTTP client for it (no proxy, any headers). */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { TestContext } from 'node:test';
import type { Hub } from '../src/hub.ts';
import { parseYaml, Team } from '../src/team.ts';
import * as ui from '../src/ui.ts';
import { cleanup, FakeOpener, writeTeamFile } from './helpers.ts';

export interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string; data: any }

export function request(port: number, method: string, target: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const data = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...opts.headers };
    if (data !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers['Content-Length'] = String(Buffer.byteLength(data));
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          // not JSON: the text itself
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, data: parsed });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export interface Server {
  served: ui.Served;
  app: ui.App;
  hub: Hub;
  teamFile: string;
  opener: FakeOpener;
  openedTabs: string[][];
  port: number;
  request(target: string, body?: unknown, opts?: { token?: string | null; host?: string }): Promise<[number, any]>;
  ok(target: string, body?: unknown): Promise<any>;
  /** The team as team.yaml says now. */
  config(): Record<string, any>;
  /** Give the hub team.yaml's settings plus `extra`. */
  settings(extra: Record<string, unknown>): void;
}

/** The example team served on a free port, with the token 'secret' (as a program that started it would). */
export async function startServer(t: TestContext, opts: { token?: string | null } = { token: 'secret' }): Promise<Server> {
  const teamFile = writeTeamFile(t);
  const served = await ui.serve(teamFile, 0, { token: opts.token ?? null, loadModels: false, watch: false });
  cleanup(t, () => served.close());
  const opener = new FakeOpener();
  served.app.hub.opener = opener.call;
  const openedTabs: string[][] = [];
  served.app.launcher.openTab = (tab) => { openedTabs.push(tab); };
  const server: Server = {
    served, app: served.app, get hub() { return served.app.hub; }, teamFile, opener, openedTabs, port: served.port,
    async request(target, body, o = {}) {
      const headers: Record<string, string> = {};
      const token = o.token === undefined ? 'secret' : o.token;
      if (token) headers['X-Org-Token'] = token;
      if (o.host) headers.Host = o.host;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const answer = await request(served.port, body === undefined ? 'GET' : 'POST', target, { body, headers });
      return [answer.status, answer.data];
    },
    async ok(target, body) {
      const [status, data] = await server.request(target, body);
      assert.equal(status, 200, JSON.stringify(data));
      return data;
    },
    config: () => parseYaml(readFileSync(teamFile, 'utf8')) as Record<string, any>,
    settings(extra) {
      served.app.hub.baseTeam = Team.fromDict({ ...server.config(), ...extra }, teamFile.replace(/[\\/]team\.yaml$/, ''));
    },
  };
  return server;
}
