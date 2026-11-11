// Converts HANDOFF.md into each AI tool's rules file. Only a marked block is ever replaced.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stripMarkers } from './handoff.mjs';

export const START = '<!-- context-handoff:start -->';
export const END = '<!-- context-handoff:end -->';

export const TARGETS = {
  cursor: { file: '.cursor/rules/project-context.mdc', tool: 'Cursor', whole: true },
  claude: { file: 'CLAUDE.md', tool: 'Claude Code' },
  agents: { file: 'AGENTS.md', tool: 'Codex, Jules, Amp and any AGENTS.md tool' },
  windsurf: { file: '.windsurf/rules/project-context.md', tool: 'Windsurf' },
  copilot: { file: '.github/copilot-instructions.md', tool: 'GitHub Copilot' },
  gemini: { file: 'GEMINI.md', tool: 'Gemini CLI' },
};

const AGENT_RULES = [
  '## How to work in this project',
  '',
  '- Read this context before changing code. If it is out of date, say so and suggest running `npx -y github:blitzhash360-web/blitzhash-context-handoff init`.',
  '- Environment variables are listed by name only. Never ask for, print, log or commit a secret value. Never move a secret to a public/browser variable.',
  '- Make the smallest change that solves the task. Follow the Conventions section.',
  '- When you finish a task, update the "Open tasks" list in HANDOFF.md and add any new decision to "Decisions".',
].join('\n');

export function block(handoffMd) {
  return `${START}\n<!-- Generated from HANDOFF.md by context-handoff. Edit HANDOFF.md, then run \`context-handoff export\` again. -->\n\n${stripMarkers(handoffMd)}\n\n${AGENT_RULES}\n${END}`;
}

export function renderTarget(key, handoffMd, existing) {
  const t = TARGETS[key];
  const b = block(handoffMd);
  if (t.whole) {
    const content = `---\ndescription: Project context and handoff notes (from HANDOFF.md)\nalwaysApply: true\n---\n\n${b}\n`;
    if (existing != null && !existing.includes(START)) return { action: 'skip', reason: 'exists and was not created by context-handoff (use --force to replace)' };
    if (existing === content) return { action: 'unchanged', content };
    return { action: existing == null ? 'create' : 'update', content };
  }
  if (existing == null) return { action: 'create', content: `${b}\n` };
  let content;
  if (existing.includes(START) && existing.includes(END)) {
    content = existing.slice(0, existing.indexOf(START)) + b + existing.slice(existing.indexOf(END) + END.length);
  } else {
    content = `${existing.trimEnd()}\n\n${b}\n`;
  }
  return { action: content === existing ? 'unchanged' : 'update', content };
}

export function planExport(root, keys, handoffMd, { force = false } = {}) {
  return keys.map((key) => {
    const file = TARGETS[key].file;
    const p = join(root, file);
    const existing = existsSync(p) ? readFileSync(p, 'utf8') : null;
    let r = renderTarget(key, handoffMd, existing);
    if (r.action === 'skip' && force) r = { ...renderTarget(key, handoffMd, null), action: 'update' };
    return { key, file, tool: TARGETS[key].tool, ...r };
  });
}

export function applyExport(root, plan) {
  for (const item of plan) {
    if (item.action !== 'create' && item.action !== 'update') continue;
    const p = join(root, item.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, item.content);
  }
}
