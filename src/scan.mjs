// Scans a project folder and returns facts for HANDOFF.md.
// Secret safety: env files are parsed for variable NAMES only; values are dropped on read.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { redact } from './redact.mjs';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.vercel',
  '.turbo', '.cache', 'coverage', '.output', 'vendor', '__pycache__', '.venv', 'venv', '.wrangler', '.idea', '.vscode']);
const CODE_EXT = /\.(m?[jt]sx?|cjs|vue|svelte|astro|py|sql|rb|go|php)$/i;
const MAX_FILES = 4000;
const MAX_BYTES = 300_000;

// dependency name (or prefix ending in /) -> [category, label]
const STACK = [
  ['next', 'Framework', 'Next.js'], ['nuxt', 'Framework', 'Nuxt'], ['@sveltejs/kit', 'Framework', 'SvelteKit'],
  ['astro', 'Framework', 'Astro'], ['@remix-run/', 'Framework', 'Remix'], ['@react-router/', 'Framework', 'React Router'],
  ['react', 'UI', 'React'], ['vue', 'UI', 'Vue'], ['svelte', 'UI', 'Svelte'], ['vite', 'Build', 'Vite'],
  ['express', 'Server', 'Express'], ['fastify', 'Server', 'Fastify'], ['hono', 'Server', 'Hono'],
  ['@supabase/supabase-js', 'Backend', 'Supabase (supabase-js)'], ['@supabase/ssr', 'Backend', 'Supabase SSR auth'],
  ['firebase', 'Backend', 'Firebase'], ['firebase-admin', 'Backend', 'Firebase Admin'], ['convex', 'Backend', 'Convex'],
  ['@prisma/client', 'Database', 'Prisma'], ['drizzle-orm', 'Database', 'Drizzle ORM'], ['mongoose', 'Database', 'MongoDB (Mongoose)'],
  ['pg', 'Database', 'Postgres (pg)'], ['@neondatabase/serverless', 'Database', 'Neon'], ['@upstash/redis', 'Database', 'Upstash Redis'],
  ['stripe', 'Payments', 'Stripe'], ['@stripe/stripe-js', 'Payments', 'Stripe.js'], ['@lemonsqueezy/', 'Payments', 'Lemon Squeezy'],
  ['@clerk/', 'Auth', 'Clerk'], ['next-auth', 'Auth', 'Auth.js (NextAuth)'], ['@auth/', 'Auth', 'Auth.js'], ['better-auth', 'Auth', 'Better Auth'],
  ['tailwindcss', 'Styling', 'Tailwind CSS'], ['@radix-ui/', 'Styling', 'Radix UI'],
  ['openai', 'AI', 'OpenAI SDK'], ['@anthropic-ai/sdk', 'AI', 'Anthropic SDK'], ['ai', 'AI', 'Vercel AI SDK'], ['@google/genai', 'AI', 'Google Gen AI SDK'],
  ['zod', 'Validation', 'Zod'], ['@tanstack/react-query', 'Data fetching', 'TanStack Query'],
  ['resend', 'Email', 'Resend'], ['@sendgrid/mail', 'Email', 'SendGrid'],
  ['@sentry/', 'Monitoring', 'Sentry'], ['posthog-js', 'Analytics', 'PostHog'], ['@vercel/analytics', 'Analytics', 'Vercel Analytics'],
  ['typescript', 'Language', 'TypeScript'],
  ['vitest', 'Testing', 'Vitest'], ['jest', 'Testing', 'Jest'], ['@playwright/test', 'Testing', 'Playwright'], ['cypress', 'Testing', 'Cypress'],
  ['eslint', 'Tooling', 'ESLint'], ['prettier', 'Tooling', 'Prettier'], ['@biomejs/biome', 'Tooling', 'Biome'],
];
const PY_STACK = [['fastapi', 'Server', 'FastAPI'], ['django', 'Framework', 'Django'], ['flask', 'Server', 'Flask'],
  ['supabase', 'Backend', 'Supabase (Python)'], ['stripe', 'Payments', 'Stripe'], ['openai', 'AI', 'OpenAI SDK'], ['sqlalchemy', 'Database', 'SQLAlchemy']];

const DEPLOY_FILES = [['vercel.json', 'Vercel'], ['netlify.toml', 'Netlify'], ['wrangler.toml', 'Cloudflare Workers'],
  ['wrangler.jsonc', 'Cloudflare Workers'], ['wrangler.json', 'Cloudflare Workers'], ['Dockerfile', 'Docker'],
  ['docker-compose.yml', 'Docker Compose'], ['compose.yaml', 'Docker Compose'], ['railway.json', 'Railway'],
  ['render.yaml', 'Render'], ['fly.toml', 'Fly.io'], ['firebase.json', 'Firebase Hosting'], ['supabase/config.toml', 'Supabase CLI project']];
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.cursor/rules', '.windsurfrules', '.windsurf/rules',
  '.github/copilot-instructions.md', '.clinerules', 'HANDOFF.md'];
const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env', '.env.local',
  '.env.development', '.env.production', '.dev.vars', '.dev.vars.example'];
const SECRETISH = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|_TOKEN|API_KEY$|WEBHOOK)/;
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)/;

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const posix = (p) => p.split(sep).join('/');

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile()) files.push(posix(relative(root, full)));
    }
  }
  return files.sort();
}

/** Parse KEY=value lines and return KEY names only. Values are never kept. */
export function envNamesFromText(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

const ENV_REF = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g, /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g, /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g,
  /os\.environ(?:\.get)?[\[(]\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];
const BUILTIN_ENV = new Set(['NO_COLOR', 'FORCE_COLOR', 'HOST', 'HOSTNAME', 'HOME', 'PATH', 'TERM', 'TZ', 'DEBUG', 'PWD', 'USER', 'SHELL', 'NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'PORT', 'CI', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL']);

function detectPackageManager(has) {
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('package-lock.json')) return 'npm';
  return has('package.json') ? 'npm' : null;
}

export function scanProject(root, { git = true } = {}) {
  const files = walk(root);
  const fileSet = new Set(files);
  const has = (p) => fileSet.has(p) || existsSync(join(root, p));
  const pkg = readJson(join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depNames = Object.keys(deps);

  // Stack
  const stack = [];
  const seen = new Set();
  for (const [name, cat, label] of STACK) {
    const hit = name.endsWith('/') ? depNames.find((d) => d.startsWith(name)) : depNames.includes(name) ? name : null;
    if (hit && !seen.has(label)) { seen.add(label); stack.push({ category: cat, label, version: deps[hit] || '' }); }
  }
  const pyReq = (readText(join(root, 'requirements.txt')) || '') + '\n' + (readText(join(root, 'pyproject.toml')) || '');
  for (const [name, cat, label] of PY_STACK) {
    if (new RegExp(`^\\s*["']?${name}\\b`, 'im').test(pyReq) && !seen.has(label)) { seen.add(label); stack.push({ category: cat, label, version: '' }); }
  }
  if (has('components.json') && !seen.has('shadcn/ui')) stack.push({ category: 'Styling', label: 'shadcn/ui', version: '' });

  // Where it was built
  const builtWith = [];
  if (deps['lovable-tagger']) builtWith.push('Lovable (lovable-tagger in devDependencies)');
  if (has('.bolt/config.json') || files.some((f) => f.startsWith('.bolt/'))) builtWith.push('Bolt (.bolt/ folder)');
  if (has('.replit') || has('replit.nix')) builtWith.push('Replit (.replit file)');
  if (files.some((f) => f.startsWith('.cursor/') && f !== '.cursor/rules/project-context.mdc')) builtWith.push('Cursor (.cursor/ folder)');

  // Commands
  const pm = detectPackageManager(has);
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg.scripts || {};
  const commands = [];
  if (pm) commands.push({ name: 'install', cmd: pm === 'npm' ? 'npm install' : `${pm} install` });
  for (const s of ['dev', 'build', 'start', 'test', 'lint', 'typecheck', 'format', 'db:migrate', 'db:push']) {
    if (scripts[s]) commands.push({ name: s, cmd: s === 'test' && pm === 'npm' ? 'npm test' : run(s), runs: redact(String(scripts[s])) });
  }

  // Layout
  const top = new Map();
  for (const f of files) {
    const [head, ...rest] = f.split('/');
    if (rest.length === 0) continue;
    top.set(head, (top.get(head) || 0) + 1);
  }
  const layout = [...top.entries()].filter(([d]) => !d.startsWith('.') || d === '.github').map(([dir, count]) => ({ dir, count }));
  const keyPaths = [];
  const KEY = [['src/app', 'App Router pages'], ['app', 'App Router pages'], ['src/pages', 'Pages / routes'], ['pages', 'Pages / routes'],
    ['src/components', 'UI components'], ['components', 'UI components'], ['src/lib', 'Shared helpers and clients'], ['lib', 'Shared helpers and clients'],
    ['src/hooks', 'React hooks'], ['api', 'API routes / serverless functions'], ['functions', 'Serverless functions'], ['public', 'Static files'],
    ['supabase/functions', 'Supabase Edge Functions'], ['supabase/migrations', 'Database migrations (SQL)'], ['prisma', 'Prisma schema'], ['drizzle', 'Drizzle schema / migrations']];
  for (const [p, what] of KEY) {
    const n = files.filter((f) => f.startsWith(p + '/')).length;
    if (n) keyPaths.push({ path: p + '/', what, count: n });
  }
  const migrations = files.filter((f) => /(^|\/)(supabase\/migrations|migrations|drizzle|prisma\/migrations)\/.*\.sql$/.test(f));
  const edgeFunctions = [...new Set(files.filter((f) => f.startsWith('supabase/functions/')).map((f) => f.split('/')[2]).filter((n) => n && !n.startsWith('_') && !n.includes('.')))];

  // Env var names (never values)
  const env = new Map(); // name -> {sources:Set}
  const addEnv = (name, source) => {
    if (BUILTIN_ENV.has(name)) return;
    if (!env.has(name)) env.set(name, new Set());
    env.get(name).add(source);
  };
  for (const ef of ENV_FILES) {
    const t = readText(join(root, ef));
    if (t != null) for (const n of envNamesFromText(t)) addEnv(n, ef);
  }
  const codeFiles = files.filter((f) => CODE_EXT.test(f));
  const todos = [];
  for (const f of codeFiles) {
    let st; try { st = statSync(join(root, f)); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    const t = readText(join(root, f));
    if (t == null) continue;
    for (const re of ENV_REF) for (const m of t.matchAll(re)) addEnv(m[1], 'code');
    if (todos.length < 25) {
      t.split(/\r?\n/).forEach((line, i) => {
        const m = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/.exec(line);
        if (m && todos.length < 25) {
          const text = redact(m[2].replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').trim()).slice(0, 110);
          todos.push({ file: f, line: i + 1, tag: m[1], text: text || '(no text)' });
        }
      });
    }
  }
  const envVars = [...env.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, src]) => {
    const sources = [...src];
    const inExample = sources.some((s) => /example|sample|template/.test(s));
    const warning = PUBLIC_PREFIX.test(name) && SECRETISH.test(name.replace(PUBLIC_PREFIX, ''))
      ? 'Public prefix on a secret-looking name: this value is bundled into the browser.' : null;
    return { name, sources, inExample, warning };
  });
  const hasEnvExample = ENV_FILES.some((f) => /example|sample|template/.test(f) && has(f));

  // Deploy, CI, agent files
  const deploy = DEPLOY_FILES.filter(([f]) => has(f)).map(([file, label]) => ({ file, label }));
  const ci = files.filter((f) => /^\.github\/workflows\/.*\.ya?ml$/.test(f));
  const agentFiles = AGENT_FILES.filter((f) => has(f) || files.some((x) => x.startsWith(f + '/')));

  // Recent changes (commit subjects only, redacted)
  let recent = [];
  if (git) {
    try {
      const out = execFileSync('git', ['-C', root, 'log', '-n', '8', '--pretty=%ad %s', '--date=short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      recent = out.split('\n').filter(Boolean).map((l) => redact(l).slice(0, 120));
    } catch { /* not a git repo */ }
  }

  return {
    name: pkg.name || root.split(sep).filter(Boolean).pop() || 'project',
    description: pkg.description ? redact(pkg.description) : '',
    nodeEngine: pkg.engines?.node || '',
    packageManager: pm,
    builtWith, stack, commands, layout, keyPaths,
    migrations: migrations.length, edgeFunctions, envVars, hasEnvExample, deploy, ci, agentFiles, todos, recent,
    fileCount: files.length,
  };
}
