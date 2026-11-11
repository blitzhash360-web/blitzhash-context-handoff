import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, renameSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanProject, envNamesFromText } from '../src/scan.mjs';
import { main } from '../src/cli.mjs';
import { redact, findSecrets } from '../src/redact.mjs';

const FIXTURE = fileURLToPath(new URL('../examples/demo-app', import.meta.url));
const FAKE_VALUES = ['demo-anon-key-not-real-0001', 'demo-service-role-not-real-0002', 'demo-stripe-secret-not-real-0003', 'demo-webhook-secret-not-real-0004'];

function copyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ch-test-'));
  cpSync(FIXTURE, dir, { recursive: true });
  renameSync(join(dir, 'env.demo'), join(dir, '.env'));
  return dir;
}
async function run(args) {
  let text = '';
  const code = await main(args, { stdout: { write: (s) => { text += s; }, isTTY: false } });
  return { code, text };
}
function allText(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(md|mdc)$/.test(e.name)) out.push(readFileSync(p, 'utf8')); } };
  walk(dir);
  return out.join('\n');
}

test('envNamesFromText keeps names and drops values', () => {
  assert.deepEqual(envNamesFromText('A=1\nexport B_KEY="x y"\n# C=3\n  D =\nnot a line'), ['A', 'B_KEY', 'D']);
});

test('scan detects stack, builder, env names, warnings and TODOs on the demo app', () => {
  const s = scanProject(copyFixture(), { git: false });
  const labels = s.stack.map((t) => t.label);
  for (const l of ['React', 'Vite', 'Supabase (supabase-js)', 'Stripe.js', 'Tailwind CSS', 'Zod', 'TypeScript', 'Vitest']) assert.ok(labels.includes(l), l);
  assert.match(s.builtWith[0], /^Lovable/);
  assert.equal(s.packageManager, 'npm');
  assert.deepEqual(s.envVars.map((e) => e.name), ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_URL']);
  assert.deepEqual(s.envVars.filter((e) => e.warning).map((e) => e.name), ['VITE_SUPABASE_SERVICE_ROLE_KEY']);
  assert.deepEqual(s.envVars.filter((e) => !e.inExample).map((e) => e.name), ['STRIPE_WEBHOOK_SECRET', 'VITE_SUPABASE_SERVICE_ROLE_KEY']);
  assert.equal(s.todos.length, 4);
  assert.equal(s.migrations, 2);
  assert.deepEqual(s.edgeFunctions, ['stripe-webhook']);
  assert.ok(s.deploy.some((d) => d.label === 'Vercel'));
  assert.ok(!JSON.stringify(s).includes('not-real'), 'scan result must not contain env values');
});

test('init + export --write never write an env value, and check passes', async () => {
  const dir = copyFixture();
  assert.equal((await run(['init', dir, '--no-git'])).code, 0);
  assert.equal((await run(['export', dir, '--write'])).code, 0);
  for (const f of ['HANDOFF.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursor/rules/project-context.mdc', '.windsurf/rules/project-context.md', '.github/copilot-instructions.md']) assert.ok(existsSync(join(dir, f)), f);
  const text = allText(dir);
  for (const v of FAKE_VALUES) assert.ok(!text.includes(v), `leaked ${v}`);
  assert.match(text, /VITE_SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(readFileSync(join(dir, '.cursor/rules/project-context.mdc'), 'utf8'), /^---\ndescription: .+\nalwaysApply: true\n---/);
  const check = await run(['check', dir]);
  assert.equal(check.code, 0);
  assert.doesNotMatch(check.text, /out of date/);
});

test('refresh keeps your own sections', async () => {
  const dir = copyFixture();
  await run(['init', dir, '--no-git']);
  const p = join(dir, 'HANDOFF.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('## Open tasks\n', '## Open tasks\n\n- [ ] Ship the waitlist page\n'));
  writeFileSync(join(dir, 'src/pages/New.tsx'), '// TODO: brand new todo\nexport default () => null;\n');
  await run(['init', dir, '--no-git']);
  const md = readFileSync(p, 'utf8');
  assert.match(md, /Ship the waitlist page/);
  assert.match(md, /brand new todo/);
  assert.equal(md.match(/context-handoff:auto:start/g).length, 1);
});

test('export is a dry run by default and only manages its own block', async () => {
  const dir = copyFixture();
  await run(['init', dir, '--no-git']);
  writeFileSync(join(dir, 'CLAUDE.md'), '# My rules\n\nAlways use pnpm.\n');
  mkdirSync(join(dir, '.cursor/rules'), { recursive: true });
  writeFileSync(join(dir, '.cursor/rules/project-context.mdc'), 'hand written');
  const dry = await run(['export', dir]);
  assert.match(dry.text, /DRY RUN/);
  assert.ok(!existsSync(join(dir, 'AGENTS.md')));
  await run(['export', dir, '--write']);
  await run(['export', dir, '--write']);
  const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# My rules\n\nAlways use pnpm\./);
  assert.equal(claude.match(/context-handoff:start/g).length, 1);
  assert.equal(readFileSync(join(dir, '.cursor/rules/project-context.mdc'), 'utf8'), 'hand written');
  await run(['export', dir, '--write', '--force', '--to', 'cursor']);
  assert.match(readFileSync(join(dir, '.cursor/rules/project-context.mdc'), 'utf8'), /context-handoff:start/);
  assert.equal((await run(['export', dir, '--to', 'nope'])).code, 1);
});

test('redaction and check catch real-looking secrets', async () => {
  // Built at runtime so this file holds no key-shaped strings.
  const stripe = ['sk', 'live', 'A'.repeat(24)].join('_');
  const jwt = ['eyJ' + 'h'.repeat(20), 'p'.repeat(20), 's'.repeat(10)].join('.');
  const aws = 'AKIA' + 'Q'.repeat(16);
  assert.equal(redact(`key ${stripe} and ${jwt} and ${aws}`), 'key [REDACTED] and [REDACTED] and [REDACTED]');
  assert.deepEqual(findSecrets('postgres://user:hunter2@db.example.com/app'), ['URL with password']);
  const dir = copyFixture();
  await run(['init', dir, '--no-git']);
  const p = join(dir, 'HANDOFF.md');
  writeFileSync(p, readFileSync(p, 'utf8') + `\n- the key is ${stripe}\n`);
  const check = await run(['check', dir]);
  assert.equal(check.code, 1);
  assert.match(check.text, /Stripe key/);
  assert.equal((await run(['export', dir, '--write'])).code, 1);
});

test('TODO text with a key in it is redacted in HANDOFF.md', async () => {
  const dir = copyFixture();
  const gh = 'ghp_' + 'z'.repeat(30);
  writeFileSync(join(dir, 'src/lib/leak.ts'), `// TODO: rotate ${gh}\nexport {};\n`);
  await run(['init', dir, '--no-git']);
  const md = readFileSync(join(dir, 'HANDOFF.md'), 'utf8');
  assert.ok(!md.includes(gh));
  assert.match(md, /rotate \[REDACTED\]/);
});

test('demo runs and help works', async () => {
  const d = await run(['demo']);
  assert.equal(d.code, 0);
  assert.match(d.text, /0 values written/);
  assert.match((await run(['--help'])).text, /Usage: context-handoff/);
  assert.equal((await run(['bogus'])).code, 2);
});
