/**
 * Tests for server/app.ts — the Express app shared by the real server and
 * the test harness.
 *
 * None of this was reachable before the app was extracted from
 * server/index.ts: that module calls start() at import time, so importing it
 * to get at isLocalOrigin or the CORS layer would have booted a real server
 * against the on-disk database.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { type AddressInfo } from 'net';
import { isLocalOrigin, createApp } from '../server/app.ts';

describe('isLocalOrigin', () => {
  it('accepts loopback origins', () => {
    assert.equal(isLocalOrigin('http://localhost:5173', undefined), true);
    assert.equal(isLocalOrigin('http://127.0.0.1:4000', undefined), true);
    assert.equal(isLocalOrigin('http://[::1]:4000', undefined), true);
  });

  it('accepts the same origin as the request Host', () => {
    // The vite dev proxy rewrites Host, so this is the case that a plain
    // same-origin check would miss - covered by the RFC1918 rule below too.
    assert.equal(isLocalOrigin('http://koolenex:4000', 'koolenex:4000'), true);
    assert.equal(isLocalOrigin('http://koolenex:4000', 'other:4000'), false);
  });

  it('accepts RFC1918 and link-local addresses', () => {
    assert.equal(isLocalOrigin('http://10.0.0.4', undefined), true);
    assert.equal(isLocalOrigin('http://192.168.1.20:5173', undefined), true);
    assert.equal(isLocalOrigin('http://172.16.0.1', undefined), true);
    assert.equal(isLocalOrigin('http://172.31.255.254', undefined), true);
    assert.equal(isLocalOrigin('http://169.254.10.1', undefined), true);
    assert.equal(isLocalOrigin('http://[fd00::1]', undefined), true);
    assert.equal(isLocalOrigin('http://[fe80::1]', undefined), true);
  });

  it('accepts mDNS .local names', () => {
    assert.equal(isLocalOrigin('http://pi.local:4000', undefined), true);
    assert.equal(isLocalOrigin('http://PI.LOCAL:4000', undefined), true);
  });

  it('rejects public origins and 172.x outside the private range', () => {
    assert.equal(isLocalOrigin('https://evil.example', undefined), false);
    assert.equal(isLocalOrigin('http://8.8.8.8', undefined), false);
    assert.equal(isLocalOrigin('http://172.15.0.1', undefined), false);
    assert.equal(isLocalOrigin('http://172.32.0.1', undefined), false);
    assert.equal(
      isLocalOrigin('http://localhost.evil.example', undefined),
      false,
    );
  });

  it('rejects unparseable origins', () => {
    assert.equal(isLocalOrigin('not a url', undefined), false);
    assert.equal(isLocalOrigin('', undefined), false);
  });
});

describe('createApp CORS layer', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const db = await import('../server/db.ts');
    await db.init({ inMemory: true });
    const { app } = await createApp({ cors: 'local' });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api`;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
  });

  it('allows a request with no Origin', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  it('allows a LAN Origin', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://192.168.1.20:5173' },
    });
    assert.equal(res.status, 200);
  });

  it('rejects a public Origin through the shared error middleware', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'CORS not allowed' });
  });
});
