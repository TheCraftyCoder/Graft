import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildBatch, sendBatch } from '../src/telemetry/send.js';

let server: Server;
let hits = 0;
let port = 0;

before(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(() => { server.close(); });

const EVENTS = [{ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc' }];

test('sendBatch never opens a telemetry connection, even with key and host env vars', async () => {
  const oldKey = process.env.GRAFT_POSTHOG_KEY;
  const oldHost = process.env.GRAFT_POSTHOG_HOST;
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  process.env.GRAFT_POSTHOG_HOST = `http://127.0.0.1:${port}`;
  try {
    const res = await sendBatch(EVENTS);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /disabled/i);
    assert.equal(hits, 0, 'no HTTP request reached even the local test server');
  } finally {
    if (oldKey === undefined) delete process.env.GRAFT_POSTHOG_KEY; else process.env.GRAFT_POSTHOG_KEY = oldKey;
    if (oldHost === undefined) delete process.env.GRAFT_POSTHOG_HOST; else process.env.GRAFT_POSTHOG_HOST = oldHost;
  }
});

test('an empty batch remains a no-op success', async () => {
  assert.deepEqual(await sendBatch([]), { ok: true });
  assert.equal(hits, 0);
});

test('buildBatch never contains an ingestion key', () => {
  const batch = buildBatch(EVENTS);
  assert.equal('api_key' in batch, false);
});
