import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_IDLE_MS, flushClosedSessions, summarizeSession } from '../src/telemetry/sessions.js';
import { peek } from '../src/telemetry/queue.js';
import { readSession } from '../src/claude/state.js';
import { tmpRepo } from './helpers.js';

test('closed-session telemetry is never queued or marked summarized', () => {
  const repo = tmpRepo('sess-disabled');
  const home = tmpRepo('sess-disabled-home');
  mkdirSync(join(repo, 'graft', '.cache', 'session'), { recursive: true });
  mkdirSync(join(home, '.graft'), { recursive: true });
  const path = join(repo, 'graft', '.cache', 'session', 's1.json');
  writeFileSync(path, JSON.stringify({ graftReads: 8, sourceReads: 2, savedTokens: 7400 }));
  const old = new Date(Date.now() - SESSION_IDLE_MS - 1000);
  utimesSync(path, old, old);
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  try {
    assert.equal(flushClosedSessions(repo, Date.now(), home, {}), 0);
    assert.equal(summarizeSession(repo, 's1', { home, env: {}, host: 'cursor' }), 0);
    assert.deepEqual(peek(home), []);
    assert.equal(readSession(repo, 's1').summarized, false);
  } finally {
    delete process.env.GRAFT_POSTHOG_KEY;
  }
});
