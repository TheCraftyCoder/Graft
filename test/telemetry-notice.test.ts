import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { firstRunNotice, formatDebug, formatStatus } from '../src/telemetry/notice.js';
import { enqueue } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

function home(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  return dir;
}

test('no telemetry notice is shown because this build cannot collect or send metrics', () => {
  const h = home('notice-disabled');
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  try {
    assert.equal(firstRunNotice(h, {}), null);
  } finally {
    delete process.env.GRAFT_POSTHOG_KEY;
  }
});

test('telemetry status is explicit that metrics are permanently disabled', () => {
  const out = formatStatus(home('notice-status'), {});
  assert.match(out, /telemetry: off/i);
  assert.match(out, /permanently disabled/i);
  assert.match(out, /no usage metrics are recorded or sent/i);
  assert.doesNotMatch(out, /endpoint:/i);
  assert.doesNotMatch(out, /enable:/i);
});

test('debug can inspect a legacy local queue while promising no send path', () => {
  const h = home('notice-legacy');
  enqueue({ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc' }, h);
  const out = formatDebug(h);
  assert.match(out, /legacy queued event/i);
  assert.match(out, /cannot send/i);
  assert.match(out, /"event": "query"/);
});
