/**
 * Progressive-disclosure skills for hosts whose legacy instruction/rule surface
 * is now only a tiny compatibility pointer.
 *
 * The shared .agents skill is reused by Codex/OpenCode, Cursor, Gemini, and
 * Copilot. Kiro/Windsurf use native project paths; Hermes' documented primary
 * skill store is user-global. Claude, Grok, AdaL, and Antigravity already have
 * native skill writers elsewhere in Graft.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { skillTemplate } from '../claude/skill-template.js';
import { writeOwned, type ConfigWrite } from './config-write.js';
import type { PlannedWrite } from './plan.js';

interface SkillSpec {
  hosts: string[];
  id: string;
  path(repo: string, home: string): string;
  scope: PlannedWrite['scope'];
}

const SPECS: SkillSpec[] = [
  { hosts: ['agents','cursor','gemini','copilot'], id: 'agents-skill',
    path: (repo) => join(repo,'.agents','skills','graft','SKILL.md'), scope: 'repo' },
  { hosts: ['kiro'], id: 'kiro-skill',
    path: (repo) => join(repo,'.kiro','skills','graft','SKILL.md'), scope: 'repo' },
  { hosts: ['windsurf'], id: 'windsurf-skill',
    path: (repo) => join(repo,'.windsurf','skills','graft','SKILL.md'), scope: 'repo' },
  { hosts: ['hermes'], id: 'hermes-skill',
    path: (_repo,home) => join(home,'.hermes','skills','graft','SKILL.md'), scope: 'global' },
];

export function hostSkillTargets(repo:string, ids:string[], opts:{home?:string}={}): PlannedWrite[] {
  const home=opts.home ?? homedir();
  const selected=new Set(ids), seen=new Set<string>(), out:PlannedWrite[]=[];
  for(const spec of SPECS){
    const owner=spec.hosts.find((id)=>selected.has(id)); if(!owner) continue;
    const path=spec.path(repo,home); if(seen.has(path)) continue; seen.add(path);
    out.push({hostId:owner,id:spec.id,path,scope:spec.scope,kind:'skill',what:'on-demand Graft skill'});
  }
  return out;
}

export function installHostSkills(repo:string, ids:string[], opts:{home?:string;global?:boolean}={}): ConfigWrite[] {
  return hostSkillTargets(repo,ids,opts)
    .filter((t)=>opts.global!==false || t.scope!=='global')
    .map((t)=>writeOwned(t.id,t.path,skillTemplate()));
}
