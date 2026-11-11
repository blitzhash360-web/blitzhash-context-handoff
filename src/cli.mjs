import { readFileSync, existsSync, writeFileSync, mkdtempSync, cpSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanProject } from './scan.mjs';
import { buildHandoff, renderAuto } from './handoff.mjs';
import { TARGETS, planExport, applyExport } from './export.mjs';
import { findSecrets } from './redact.mjs';

export const VERSION = '1.0.0';

const HELP = `context-handoff ${VERSION}: one portable HANDOFF.md for your project, converted to every AI tool's rules file.

Usage: context-handoff <command> [dir] [options]

Commands:
  demo                 Try it on a sample Lovable-style app (temp folder, nothing in yours changes)
  scan [dir]           Print the HANDOFF.md that init would write. Writes nothing.
  init [dir]           Create or refresh HANDOFF.md. Your Decisions, Conventions, Open tasks
                       and Gotchas sections are kept; only the generated block is replaced.
  export [dir]         Show which agent files would be written from HANDOFF.md (dry run).
      --to <list>      Targets: ${Object.keys(TARGETS).join(', ')}, all  (default: all)
      --write          Actually write them. Only the context-handoff block is replaced
                       in files that already exist.
      --force          Replace a .cursor/rules file that context-handoff did not create.
  check [dir]          CI gate: fails if HANDOFF.md is missing, or if it or any exported
                       file contains something that looks like a secret value.

Options: --no-git (skip commit history), --json (scan only), -h, --version

Safety: env files are read for variable NAMES only. Values are dropped on read, and
output is scanned for key patterns (JWTs, Stripe, AWS, GitHub, OpenAI keys) before writing.`;

function colors(stream) {
  const on = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !process.env.NO_COLOR && stream.isTTY;
  const w = (c) => (s) => (on ? `\x1b[${c}m${s}\x1b[0m` : String(s));
  return { b: w(1), d: w(2), r: w(31), g: w(32), y: w(33), c: w(36), m: w(35) };
}

export function parseArgs(argv) {
  const opts = { _: [], to: 'all', write: false, force: false, json: false, git: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') opts.to = argv[++i] || '';
    else if (a.startsWith('--to=')) opts.to = a.slice(5);
    else if (a === '--write') opts.write = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-git') opts.git = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Run context-handoff --help.`);
    else opts._.push(a);
  }
  return opts;
}

function targetKeys(to) {
  const keys = to === 'all' || !to ? Object.keys(TARGETS) : to.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = keys.filter((k) => !TARGETS[k]);
  if (bad.length) throw new Error(`Unknown target(s): ${bad.join(', ')}. Use: ${Object.keys(TARGETS).join(', ')}, all`);
  return keys;
}

function summary(scan, c, out) {
  const stack = scan.stack.filter((t) => !['Tooling', 'Language'].includes(t.category)).map((t) => t.label);
  out(`${c.b('Project')}   ${scan.name}${scan.builtWith.length ? c.d(`  (built with ${scan.builtWith[0].split(' (')[0]})`) : ''}`);
  out(`${c.b('Stack')}     ${stack.slice(0, 8).join(', ') || c.d('not detected')}`);
  out(`${c.b('Commands')}  ${scan.commands.map((x) => x.name).join(', ') || c.d('none')}`);
  out(`${c.b('Deploy')}    ${[...scan.deploy.map((d) => d.label), ...(scan.ci.length ? [`${scan.ci.length} CI workflow(s)`] : [])].join(', ') || c.d('none found')}`);
  out(`${c.b('Env vars')}  ${scan.envVars.length} names captured, ${c.g('0 values written')}`);
  if (!scan.hasEnvExample && scan.envVars.length) out(`  ${c.y('!')} no .env.example file: add one listing these names`);
  else for (const e of scan.envVars.filter((x) => !x.inExample)) out(`  ${c.y('!')} ${e.name} is used but missing from .env.example`);
  for (const e of scan.envVars.filter((x) => x.warning)) out(`  ${c.r('✗')} ${e.name}: public prefix on a secret-looking name (shipped to the browser)`);
  out(`${c.b('TODOs')}     ${scan.todos.length} found in code`);
}

function doInit(root, opts, c, out) {
  const scan = scanProject(root, { git: opts.git });
  const p = join(root, 'HANDOFF.md');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : null;
  const md = buildHandoff(scan, existing);
  const hits = findSecrets(md);
  if (hits.length) throw new Error(`Refusing to write HANDOFF.md: output matched secret patterns (${hits.join(', ')}). Please report this.`);
  summary(scan, c, out);
  if (existing === md) out(`\n${c.g('✓')} HANDOFF.md is already up to date`);
  else { writeFileSync(p, md); out(`\n${c.g('✓')} ${existing == null ? 'Wrote' : 'Refreshed'} HANDOFF.md${existing == null ? ' (fill in Decisions and Open tasks, they are kept on every refresh)' : ' (your own sections were kept)'}`); }
  return { scan, md };
}

function doExport(root, opts, c, out) {
  const p = join(root, 'HANDOFF.md');
  if (!existsSync(p)) throw new Error('No HANDOFF.md yet. Run `context-handoff init` first.');
  const md = readFileSync(p, 'utf8');
  const hits = findSecrets(md);
  if (hits.length) throw new Error(`HANDOFF.md contains something that looks like a secret (${hits.join(', ')}). Remove it before exporting.`);
  const plan = planExport(root, targetKeys(opts.to), md, { force: opts.force });
  const icon = { create: c.g('+'), update: c.c('~'), unchanged: c.d('='), skip: c.y('!') };
  for (const it of plan) out(`  ${icon[it.action]} ${it.file.padEnd(36)} ${c.d(it.tool)}${it.action === 'skip' ? `  ${c.y(it.reason)}` : it.action === 'unchanged' ? c.d('  up to date') : ''}`);
  if (opts.write) { applyExport(root, plan); out(`\n${c.g('✓')} Wrote ${plan.filter((x) => x.action === 'create' || x.action === 'update').length} file(s). Only the context-handoff block is managed; the rest of each file is yours.`); }
  else out(`\n${c.y('DRY RUN')}: nothing written. Add --write to create these files.`);
  return plan;
}

function doCheck(root, c, out) {
  const p = join(root, 'HANDOFF.md');
  if (!existsSync(p)) { out(`${c.r('✗')} HANDOFF.md is missing. Run: context-handoff init`); return 1; }
  let failed = false;
  const files = ['HANDOFF.md', ...Object.values(TARGETS).map((t) => t.file)].filter((f) => existsSync(join(root, f)));
  for (const f of files) {
    const hits = findSecrets(readFileSync(join(root, f), 'utf8'));
    if (hits.length) { failed = true; out(`${c.r('✗')} ${f}: looks like it contains a secret (${hits.join(', ')})`); }
  }
  const md = readFileSync(p, 'utf8');
  const fresh = renderAuto(scanProject(root, { git: false }));
  const strip = (s) => s.replace(/## Recent changes[\s\S]*?(?=<!-- context-handoff:auto:end)/, '').replace(/## Existing agent files[\s\S]*?(?=## TODOs)/, '');
  const current = md.match(/<!-- context-handoff:auto:start[\s\S]*?<!-- context-handoff:auto:end -->/)?.[0] || '';
  if (strip(current) !== strip(fresh)) out(`${c.y('!')} HANDOFF.md is out of date with the code. Run: context-handoff init`);
  if (!failed) out(`${c.g('✓')} No secret values in ${files.length} context file(s)`);
  return failed ? 1 : 0;
}

function doDemo(c, out) {
  const fixture = fileURLToPath(new URL('../examples/demo-app', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'context-handoff-demo-'));
  cpSync(fixture, dir, { recursive: true });
  if (existsSync(join(dir, 'env.demo'))) renameSync(join(dir, 'env.demo'), join(dir, '.env'));
  out(c.d(`Demo: a sample Lovable-style app (React + Supabase + Stripe), copied to ${dir}`));
  out(c.d('Its .env holds fake keys. Watch: names are captured, values never are.\n'));
  out(`${c.m('$')} context-handoff init`);
  doInit(dir, { git: false }, c, out);
  out(`\n${c.m('$')} context-handoff export --write`);
  doExport(dir, { to: 'all', write: true }, c, out);
  out(`\n${c.m('$')} context-handoff check`);
  doCheck(dir, c, out);
  out(`\nOpen ${c.c(join(dir, 'HANDOFF.md'))} to see the result.`);
  out(c.d('Run it on your project: npx -y github:blitzhash360-web/blitzhash-context-handoff init'));
  return 0;
}

export async function main(argv, { stdout = process.stdout } = {}) {
  const out = (s = '') => stdout.write(s + '\n');
  const c = colors(stdout);
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(c.r(e.message)); return 2; }
  if (opts.version) { out(VERSION); return 0; }
  const [cmd, dirArg] = opts._;
  if (opts.help || !cmd || cmd === 'help') { out(HELP); return cmd || opts.help ? 0 : 2; }
  const root = resolve(dirArg || '.');
  try {
    switch (cmd) {
      case 'demo': return doDemo(c, out);
      case 'scan': {
        const scan = scanProject(root, { git: opts.git });
        if (opts.json) out(JSON.stringify(scan, null, 2));
        else out(buildHandoff(scan, existsSync(join(root, 'HANDOFF.md')) ? readFileSync(join(root, 'HANDOFF.md'), 'utf8') : null));
        return 0;
      }
      case 'init': doInit(root, opts, c, out); return 0;
      case 'export': doExport(root, opts, c, out); return 0;
      case 'check': return doCheck(root, c, out);
      default: out(c.r(`Unknown command "${cmd}".`)); out(HELP); return 2;
    }
  } catch (e) { out(c.r(e.message)); return 1; }
}
