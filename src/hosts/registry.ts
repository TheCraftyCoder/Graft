/**
 * Registry of AI coding hosts Graft can write instructions for.
 * Adding a host = adding one entry here (plus a renderer if it needs
 * a new file format).
 *
 * kind: 'section' → upsert the fenced block into a shared file the user owns.
 * kind: 'owned'   → graft owns the whole file; overwrite it each run.
 */
import { join } from 'node:path';
import { instructionBody, instructionHint, cursorRule, kiroSteering, windsurfRule } from './instructions.js';
import { skillTemplate } from '../claude/skill-template.js';

export interface DetectProbe {
  home: string;
  repo: string;
  dirExists(path: string): boolean;
}

export interface HostTarget {
  id: string;
  name: string;
  kind: 'section' | 'owned';
  /** Target file, relative to the repo root. */
  relPath: string;
  content(): string;
  detect(probe: DetectProbe): boolean;
}

export const HOSTS: HostTarget[] = [
  {
    id: 'agents',
    name: 'AGENTS.md hosts (Codex-style CLIs, editors that read AGENTS.md)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionHint,
    detect: (p) =>
      p.dirExists(join(p.home, '.codex')) ||
      p.dirExists(join(p.home, '.config', 'opencode')) ||
      p.dirExists(join(p.home, '.config', 'agents')),
  },
  {
    // Instruction-only: the fenced AGENTS.md section and nothing else. Unlike
    // `agents` it has no MCP target, no Codex hooks, and no OpenCode/global write
    // (those key on the id 'agents'), so it is safe for a targeted, no-side-effect
    // init. Never auto-detected or pre-checked; select it explicitly.
    id: 'agents-md',
    name: 'AGENTS.md instruction section only',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    detect: () => false,
  },
  {
    id: 'adal',
    name: 'AdaL',
    kind: 'owned',
    relPath: join('.adal', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.adal')) || p.dirExists(join(p.repo, '.adal')),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'owned',
    relPath: join('.cursor', 'rules', 'graft.mdc'),
    content: cursorRule,
    detect: (p) => p.dirExists(join(p.home, '.cursor')) || p.dirExists(join(p.repo, '.cursor')),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    kind: 'section',
    relPath: 'GEMINI.md',
    content: instructionHint,
    detect: (p) => p.dirExists(join(p.home, '.gemini')),
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'owned',
    relPath: join('.grok', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.grok')) || p.dirExists(join(p.repo, '.grok')),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent (Nous Research)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionHint,
    // Hermes is repo-aware: it reads AGENTS.md at the repo root (and the
    // Graft-for-Hermes plugin keeps the graph fresh on every session start).
    detect: (p) =>
      p.dirExists(join(p.home, '.hermes')) ||
      p.dirExists(join(p.home, 'AppData', 'Local', 'hermes')) ||
      p.dirExists(join(p.repo, '.hermes')),
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionHint,
    // Antigravity-specific markers, NOT the bare `~/.gemini` (which is also Gemini CLI's):
    // its global config dir (`~/.gemini/config/`, where mcp_config.json + hooks.json live)
    // or its dedicated CLI dir. `.agents/` is a cross-agent skill standard and
    // must not auto-select Antigravity.
    detect: (p) =>
      p.dirExists(join(p.home, '.gemini', 'config')) ||
      p.dirExists(join(p.home, '.gemini', 'antigravity-cli')),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    kind: 'section',
    relPath: join('.github', 'copilot-instructions.md'),
    content: instructionHint,
    detect: (p) => p.dirExists(join(p.repo, '.github')),
  },
  {
    id: 'kiro',
    name: 'Kiro',
    kind: 'owned',
    relPath: join('.kiro', 'steering', 'graft.md'),
    content: kiroSteering,
    detect: (p) => p.dirExists(join(p.home, '.kiro')) || p.dirExists(join(p.repo, '.kiro')),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'owned',
    relPath: join('.windsurf', 'rules', 'graft.md'),
    content: windsurfRule,
    detect: (p) => p.dirExists(join(p.home, '.codeium', 'windsurf')) || p.dirExists(join(p.repo, '.windsurf')),
  },
];

export function hostIds(): string[] {
  return HOSTS.map((h) => h.id);
}

export function detectHosts(probe: DetectProbe): HostTarget[] {
  return HOSTS.filter((h) => h.detect(probe));
}
