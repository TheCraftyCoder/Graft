import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { peek } from '../src/telemetry/queue.js';
import { trackFirstRunIfNew, trackInstallIfNew } from '../src/telemetry/track.js';
import { readState } from '../src/telemetry/identity.js';
import { tmpRepo } from './helpers.js';

test('install and first-run telemetry stay inert even when an env key is supplied', () => {
  const home = tmpRepo('tel-install-disabled');
  mkdirSync(join(home, '.graft'), { recursive: true });
  const prior = process.env.GRAFT_POSTHOG_KEY;
  process.env.GRAFT_POSTHOG_KEY = 'phc_should_never_be_used';
  try {
    trackInstallIfNew({ home, env: {} });
    trackFirstRunIfNew({ home, env: {} });
    assert.deepEqual(peek(home), []);
    assert.equal(readState(home)?.installedVersion, undefined);
    assert.equal(readState(home)?.firstRunAt, undefined);
  } finally {
    if (prior === undefined) delete process.env.GRAFT_POSTHOG_KEY;
    else process.env.GRAFT_POSTHOG_KEY = prior;
  }
});
