/**
 * `src/search/colgrep.ts` — the ColGREP adapter's every failure mode must
 * resolve to `null`/`{ ok: false }` rather than throw, and a happy-path run
 * must normalize ColGREP's raw `{ unit, score }` shape into `ColgrepHit`.
 *
 * A fake `colgrep` is a Node fixture script (`fixture.mjs`) whose behaviour
 * (hits / malformed / non-zero exit / hang / argv-echo) is driven by an env
 * var, one script for every scenario.
 *
 * On POSIX it is wrapped in a `#!/bin/sh` shim named `colgrep` on `PATH`, so
 * the adapter's ordinary (non-override) PATH resolution is exercised.
 *
 * On Windows there is no such shim: `colgrep.ts` now only resolves a native
 * `.exe`/`.com` on PATH, and Node cannot directly execute a `.mjs` file as if
 * it were a binary. Windows tests instead use the adapter's
 * `GRAFT_COLGREP_BIN`/`GRAFT_COLGREP_ARGS_PREFIX` env override to spawn
 * `process.execPath` (Node itself) with the fixture script path prepended to
 * argv — the same mechanism a real native ColGREP binary's argv would take,
 * minus PATH resolution, which is covered separately by the
 * shell-script-rejection test below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { detectColgrep, runColgrep } from "../src/search/colgrep.js";

const FIXTURE_SRC = `
import { writeFileSync } from "node:fs";
const mode = process.env.COLGREP_FIXTURE_MODE || "hits";
if (process.argv.includes("--version")) {
  process.stdout.write("colgrep-fixture 9.9.9\\n");
  process.exit(0);
}
if (mode === "hits") {
  process.stdout.write(process.env.COLGREP_FIXTURE_JSON || "[]");
  process.exit(0);
} else if (mode === "echo") {
  const dumpPath = process.env.COLGREP_ARGV_DUMP;
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(process.argv.slice(2)));
  process.stdout.write("[]");
  process.exit(0);
} else if (mode === "malformed") {
  process.stdout.write("{not valid json");
  process.exit(0);
} else if (mode === "fail") {
  process.stderr.write("boom\\n");
  process.exit(3);
} else if (mode === "sleep") {
  setTimeout(() => process.exit(0), 5000);
} else {
  process.exit(0);
}
`;

const tmpRoot = mkdtempSync(join(tmpdir(), "colgrep-test-"));
const binDir = join(tmpRoot, "bin");
mkdirSync(binDir);
const fixturePath = join(binDir, "fixture.mjs");
writeFileSync(fixturePath, FIXTURE_SRC);

const isWin = process.platform === "win32";
if (!isWin) {
  const colgrepPath = join(binDir, "colgrep");
  writeFileSync(colgrepPath, `#!/bin/sh\nexec node "${fixturePath}" "$@"\n`);
  chmodSync(colgrepPath, 0o755);
}

const projectDir = join(tmpRoot, "project");
mkdirSync(projectDir, { recursive: true });

interface FixtureOpts {
  env: NodeJS.ProcessEnv;
}

/**
 * Builds the `runColgrep`/`detectColgrep` options that route to the fake
 * fixture. POSIX: the fixture dir first on `PATH` (shadowing any real
 * `colgrep` installed elsewhere), exercising ordinary PATH resolution.
 * Windows: the `GRAFT_COLGREP_BIN`/`GRAFT_COLGREP_ARGS_PREFIX` env override,
 * since there is no native-binary shim to put on PATH.
 */
function fixtureOpts(mode: string, extra: Record<string, string> = {}): FixtureOpts {
  const env: NodeJS.ProcessEnv = { ...process.env, COLGREP_FIXTURE_MODE: mode, ...extra };
  if (isWin) {
    return {
      env: {
        ...env,
        GRAFT_COLGREP_BIN: process.execPath,
        GRAFT_COLGREP_ARGS_PREFIX: JSON.stringify([fixturePath]),
      },
    };
  }
  return { env: { ...env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` } };
}

/** A PATH that can never resolve `colgrep` — only node's own directory, so
 * this is independent of whatever happens to be installed on the dev box. */
const missingEnv: NodeJS.ProcessEnv = { ...process.env, PATH: dirname(process.execPath) };

test("colgrep: happy path maps hits, normalizes \\\\?\\ + backslashes, sorts by score", async () => {
  const hitsJson = JSON.stringify([
    {
      unit: {
        name: "ProcessWidget",
        qualified_name: "services.ProcessWidget",
        file: `\\\\?\\${join(projectDir, "internal", "services", "widget_service.go")}`,
        line: 42,
        end_line: 60,
        language: "go",
        unit_type: "function",
        signature: "func ProcessWidget(ctx context.Context) error",
        docstring: "processes a widget",
      },
      score: 0.42,
    },
    {
      unit: {
        name: "helper",
        file: join(projectDir, "internal", "util.go"),
        line: 5,
        end_line: 10,
        language: "go",
        unit_type: "function",
        signature: null,
      },
      score: 0.91,
    },
  ]);

  const hits = await runColgrep("process widget", {
    cwd: projectDir,
    ...fixtureOpts("hits", { COLGREP_FIXTURE_JSON: hitsJson }),
  });
  assert.ok(hits, "expected hits, got null");
  assert.equal(hits.length, 2);

  // Higher score first, even though the fixture emitted it second.
  assert.equal(hits[0].name, "helper");
  assert.equal(hits[0].score, 0.91);
  assert.equal(hits[1].name, "ProcessWidget");
  assert.equal(hits[1].score, 0.42);

  const widget = hits[1];
  assert.equal(widget.path, "internal/services/widget_service.go", "\\\\?\\ prefix stripped and backslashes normalized, relative to cwd");
  assert.ok(widget.absPath.endsWith("internal/services/widget_service.go"));
  assert.equal(widget.absPath.includes("\\"), false, "absPath uses forward slashes");
  assert.equal(widget.line, 42);
  assert.equal(widget.endLine, 60);
  assert.equal(widget.unitType, "function");
  assert.equal(widget.language, "go");
  assert.equal(widget.signature, "func ProcessWidget(ctx context.Context) error");
  assert.equal(widget.qualifiedName, "services.ProcessWidget");

  const helper = hits[0];
  assert.equal(helper.path, "internal/util.go");
  assert.equal(helper.signature, null);
  assert.equal(helper.qualifiedName, null, "qualifiedName is null when ColGREP reports no qualified_name");
});

test("colgrep: detectColgrep reports ok+version when the binary responds", () => {
  const opts = fixtureOpts("hits");
  const detection = detectColgrep(opts);
  assert.equal(detection.ok, true);
  assert.equal(typeof detection.version, "string");
});

test("colgrep: missing binary -> detectColgrep false, runColgrep null", async () => {
  const detection = detectColgrep({ env: missingEnv });
  assert.equal(detection.ok, false);
  assert.ok(detection.reason, "a missing binary should explain why");

  const hits = await runColgrep("anything", { cwd: projectDir, env: missingEnv });
  assert.equal(hits, null);
});

test("colgrep: malformed JSON output -> null", async () => {
  const hits = await runColgrep("anything", { cwd: projectDir, ...fixtureOpts("malformed") });
  assert.equal(hits, null);
});

test("colgrep: non-zero exit -> null", async () => {
  const hits = await runColgrep("anything", { cwd: projectDir, ...fixtureOpts("fail") });
  assert.equal(hits, null);
});

test("colgrep: a hung process past timeoutMs -> null", async () => {
  const hits = await runColgrep("anything", { cwd: projectDir, timeoutMs: 300, ...fixtureOpts("sleep") });
  assert.equal(hits, null);
});

test("colgrep: hostile characters in the query are passed as a single verbatim argv element, never shell-interpreted", async () => {
  const dumpPath = join(tmpRoot, "argv-dump-hostile.json");
  const hostileQuery = `foo & whoami | echo % ^ < > ( ) "quoted" 'single'`;
  const opts = fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPath });

  const hits = await runColgrep(hostileQuery, { cwd: projectDir, ...opts });
  assert.ok(hits, "the fixture returns a valid (empty) hits array");
  assert.equal(hits.length, 0);

  const dumped = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.ok(
    dumped.includes(hostileQuery),
    `argv should contain the hostile query verbatim as a single element; got ${JSON.stringify(dumped)}`,
  );
});

test("colgrep: opts.targetPath is passed as the final positional argument verbatim", async () => {
  const dumpPath = join(tmpRoot, "argv-dump-target.json");
  const opts = fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPath });

  const hits = await runColgrep("process widget", { cwd: projectDir, targetPath: "internal/services", ...opts });
  assert.ok(hits, "the fixture returns a valid (empty) hits array");

  const dumped = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.equal(dumped[dumped.length - 1], "internal/services", "target path is the final positional argument");
});

test("colgrep: mode 'semantic' adds --semantic-only; mode 'hybrid' (or unset) omits it", async () => {
  const dumpPathSemantic = join(tmpRoot, "argv-dump-mode-semantic.json");
  await runColgrep("process widget", {
    cwd: projectDir,
    mode: "semantic",
    ...fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPathSemantic }),
  });
  const dumpedSemantic = JSON.parse(readFileSync(dumpPathSemantic, "utf8")) as string[];
  assert.ok(dumpedSemantic.includes("--semantic-only"));

  const dumpPathHybrid = join(tmpRoot, "argv-dump-mode-hybrid.json");
  await runColgrep("process widget", {
    cwd: projectDir,
    mode: "hybrid",
    ...fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPathHybrid }),
  });
  const dumpedHybrid = JSON.parse(readFileSync(dumpPathHybrid, "utf8")) as string[];
  assert.equal(dumpedHybrid.includes("--semantic-only"), false);

  const dumpPathUnset = join(tmpRoot, "argv-dump-mode-unset.json");
  await runColgrep("process widget", { cwd: projectDir, ...fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPathUnset }) });
  const dumpedUnset = JSON.parse(readFileSync(dumpPathUnset, "utf8")) as string[];
  assert.equal(dumpedUnset.includes("--semantic-only"), false);
});

test("colgrep: excludeDirs/excludeGlobs become one --exclude-dir=<d>/--exclude=<g> per entry", async () => {
  const dumpPath = join(tmpRoot, "argv-dump-excludes.json");
  await runColgrep("process widget", {
    cwd: projectDir,
    excludeDirs: ["test", "tests"],
    excludeGlobs: ["*.test.*", "*_test.go"],
    ...fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPath }),
  });
  const dumped = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.ok(dumped.includes("--exclude-dir=test"));
  assert.ok(dumped.includes("--exclude-dir=tests"));
  assert.ok(dumped.includes("--exclude=*.test.*"));
  assert.ok(dumped.includes("--exclude=*_test.go"));
});

test("colgrep: runColgrep defaults targetPath to \".\" when not given", async () => {
  const dumpPath = join(tmpRoot, "argv-dump-default-target.json");
  const opts = fixtureOpts("echo", { COLGREP_ARGV_DUMP: dumpPath });

  await runColgrep("process widget", { cwd: projectDir, ...opts });

  const dumped = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.equal(dumped[dumped.length - 1], ".");
});

if (isWin) {
  test("colgrep (Windows): a resolved .cmd/.bat is treated as not found, never executed", () => {
    const shellDir = join(tmpRoot, "shell-bin");
    mkdirSync(shellDir);
    writeFileSync(join(shellDir, "colgrep.cmd"), `@echo off\r\nnode "${fixturePath}" %*\r\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: shellDir, COLGREP_FIXTURE_MODE: "hits" };

    const detection = detectColgrep({ env });
    assert.equal(detection.ok, false);
    assert.match(detection.reason ?? "", /shell script/, "reason should explain the shell-script rejection");
  });

  test("colgrep (Windows): runColgrep's resolve-error path (a .cmd/.bat on PATH) resolves to null promptly, never hangs", async () => {
    // Regression for the TDZ bug: `finish(null)` used to be called from this
    // resolve-error branch — which runs before the (then-`const`) timer
    // declaration — throwing a ReferenceError that left `resolvePromise`
    // never invoked. Race this against a manual 2s timeout so a regression
    // fails the test instead of hanging the whole run.
    const shellDir = join(tmpRoot, "shell-bin-runcolgrep");
    mkdirSync(shellDir);
    writeFileSync(join(shellDir, "colgrep.cmd"), `@echo off\r\nnode "${fixturePath}" %*\r\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: shellDir, COLGREP_FIXTURE_MODE: "hits" };
    delete env.GRAFT_COLGREP_BIN;
    delete env.GRAFT_COLGREP_ARGS_PREFIX;

    const timeout = new Promise<"timed-out">((res) => setTimeout(() => res("timed-out"), 2000));
    const outcome = await Promise.race([runColgrep("anything", { cwd: projectDir, env }), timeout]);
    assert.notEqual(outcome, "timed-out", "runColgrep must settle promptly, not hang");
    assert.equal(outcome, null);
  });
}
