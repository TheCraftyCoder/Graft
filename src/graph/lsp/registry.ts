/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LspServer {
  /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
  languages: string[];
  command: string;
  args: string[];
  /** the LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** First installed match per language wins; ordering is priority. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

const resolved = new Map<string, string | null>();
/** Resolve a command to its ABSOLUTE path via the login shell's PATH. `spawn`
 * resolves against `process.env.PATH`, which often omits `~/.cargo/bin`,
 * `~/go/bin`, etc. where these servers live — so `command -v` can find a server
 * that `spawn(cmd)` then can't. Spawning the absolute path avoids that mismatch. */
function resolveCommand(cmd: string): string | null {
  if (resolved.has(cmd)) return resolved.get(cmd)!;
  let abs: string | null = null;
  try {
    const out = process.platform === "win32"
      ? execFileSync("where.exe", [cmd], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        })
      : execSync(`command -v ${cmd}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });

    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    abs = process.platform === "win32"
      ? (hits.find((p) => /\.(exe|cmd|bat)$/i.test(p)) ?? hits[0] ?? null)
      : (hits[0] ?? null);
  } catch {
    abs = null;
  }
  resolved.set(cmd, abs);
  return abs;
}

export function parseTypeScriptMajor(versionOutput: string): number | null {
  const match = versionOutput.match(/(?:Version\s+)?(\d+)\./i);
  return match ? Number(match[1]) : null;
}

function nativeTypeScriptServer(languagesPresent: Set<string>): LspServer | null {
  const languages = ["typescript", "javascript", "tsx"].filter((l) => languagesPresent.has(l));
  if (!languages.length) return null;

  const tsc = resolveCommand("tsc");
  if (!tsc) return null;

  let command = tsc;
  let args = ["--lsp", "--stdio"];
  let versionArgs = ["--version"];

  // npm's Windows tsc entrypoint is a .cmd shim. Bypass cmd.exe entirely so
  // stdio remains a direct LSP transport: node <typescript>/bin/tsc --lsp --stdio.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(tsc)) {
    const script = join(dirname(tsc), "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(script)) return null;
    command = process.execPath;
    args = [script, "--lsp", "--stdio"];
    versionArgs = [script, "--version"];
  }

  try {
    const version = execFileSync(command, versionArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if ((parseTypeScriptMajor(version) ?? 0) < 7) return null;
  } catch {
    return null;
  }

  return { languages, command, args, languageId: "typescript" };
}

/** Pick servers for all covered languages, with absolute commands. Each language
 * is assigned once, and a server shared by several languages is started once. */
export function pickServers(languagesPresent: Set<string>): LspServer[] {
  const remaining = new Set(languagesPresent);
  const servers: LspServer[] = [];

  // TypeScript 7+ ships its own native LSP. Prefer it when available; older
  // TypeScript versions fall through to typescript-language-server below.
  const nativeTs = nativeTypeScriptServer(remaining);
  if (nativeTs) {
    servers.push(nativeTs);
    for (const language of nativeTs.languages) remaining.delete(language);
  }

  for (const s of LSP_SERVERS) {
    const languages = s.languages.filter((l) => remaining.has(l));
    if (!languages.length) continue;
    const abs = resolveCommand(s.command);
    if (!abs) continue;
    servers.push({ ...s, languages, command: abs });
    for (const language of languages) remaining.delete(language);
  }
  return servers;
}
