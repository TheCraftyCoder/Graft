import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doNotTrack, explainOff, inCi, offReason, telemetryOn } from '../src/telemetry/gate.js';
import { posthogKey } from '../src/telemetry/key.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

function home(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  writeFileSync(join(dir, '.graft', 'telemetry.json'), JSON.stringify({ installId: 'x', enabled: true }));
  return dir;
}

test('telemetry is compiled out and env keys cannot re-enable it', () => {
  const prior = process.env.GRAFT_POSTHOG_KEY;
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  const h = home('gate-hard-off');
  try {
    assert.equal(posthogKey(), '');
    assert.equal(offReason(h, {}), 'no-key');
    assert.equal(telemetryOn(h, {}), false);
    assert.equal(track('query', { command: 'ask', surface: 'cli' }, { home: h, env: {} }), null);
    assert.deepEqual(peek(h), []);
  } finally {
    if (prior === undefined) delete process.env.GRAFT_POSTHOG_KEY;
    else process.env.GRAFT_POSTHOG_KEY = prior;
  }
});

test('legacy environment helpers remain well-defined', () => {
  assert.equal(doNotTrack({ DO_NOT_TRACK: '0' }), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: '' }), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'true' }), true);
  assert.equal(inCi({ CI: 'false' }), false);
  assert.equal(inCi({ CI: 'true' }), true);
  assert.equal(inCi({ GITHUB_ACTIONS: 'true' }), true);
});

test('status text says this build records and sends no usage metrics', () => {
  assert.match(explainOff('no-key'), /permanently disabled/i);
  assert.match(explainOff('no-key'), /no usage metrics are recorded or sent/i);
});
