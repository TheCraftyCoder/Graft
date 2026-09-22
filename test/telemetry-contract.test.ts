import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENTS, countBucket, durationBucket, errorCode, filesBucket,
  isTrackedCommand, langsValue, savedTokensBucket,
} from '../src/telemetry/contract.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

test('track is inert in this privacy build, even with a telemetry key env var', () => {
  const home = tmpRepo('tel-contract-disabled');
  mkdirSync(join(home, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  try {
    assert.equal(track('query', { command: 'ask', surface: 'cli' }, { home, env: {} }), null);
    assert.deepEqual(peek(home), []);
  } finally {
    delete process.env.GRAFT_POSTHOG_KEY;
  }
});

test('the legacy contract remains stable for parsing old local queues', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), [
    'brain_signup_opened', 'brain_signup_settled', 'build_completed', 'build_failed',
    'first_run', 'init_completed', 'install', 'query', 'session_summary',
  ]);
  assert.equal(isTrackedCommand('ask'), true);
  assert.equal(isTrackedCommand('init'), false);
  assert.equal(isTrackedCommand('_telemetry-flush'), false);
});

test('bucket helpers remain deterministic', () => {
  assert.equal(filesBucket(0), '0');
  assert.equal(filesBucket(50), '50-199');
  assert.equal(durationBucket(999), '<1s');
  assert.equal(durationBucket(1000), '1-5s');
  assert.equal(countBucket(4), '1-4');
  assert.equal(countBucket(5), '5-19');
  assert.equal(savedTokensBucket(999), '<1k');
  assert.equal(savedTokensBucket(1000), '1-5k');
});

test('language and error sanitizers remain deterministic', () => {
  assert.equal(langsValue(['ts', 'go', 'TS']), 'go,ts');
  assert.equal(langsValue(['ts', '../../etc/passwd']), 'ts');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'EACCES' })), 'E_PERMISSION');
  assert.equal(errorCode(Object.assign(new Error('x'), { status: 429 })), 'E_RATE_LIMIT');
  assert.equal(errorCode(new Error('unknown')), 'E_UNKNOWN');
});
