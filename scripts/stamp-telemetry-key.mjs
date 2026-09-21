/**
 * Privacy fork: usage telemetry is permanently disabled.
 *
 * Upstream stamps a PostHog ingestion key into dist/telemetry/key.js during
 * `npm prepare`. This fork deliberately never does that. Keep this script as a
 * successful no-op because package.json still invokes it during prepare and
 * downstream npm workflows may rely on that lifecycle hook existing.
 */
console.log('· telemetry key stamping skipped — usage telemetry is disabled in this build.');
