const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough, Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');

const initCmd = require('../lib/cli/commands/init');
const { _renderTemplate, _llmConfigFor } = initCmd;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saptarishi-init-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeCtx(overrides = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const oBuf = [];
  const eBuf = [];
  stdout.on('data', c => oBuf.push(c));
  stderr.on('data', c => eBuf.push(c));
  return {
    opts: {},
    positionals: [],
    env: {},
    stdin: Readable.from([]),
    stdout, stderr,
    ...overrides,
    _read: () => ({
      stdout: Buffer.concat(oBuf).toString('utf8'),
      stderr: Buffer.concat(eBuf).toString('utf8'),
    }),
  };
}

test('renderTemplate: substitutes {{KEY}} tokens', () => {
  assert.equal(_renderTemplate('hello {{NAME}}', { NAME: 'world' }), 'hello world');
  assert.equal(_renderTemplate('{{A}} + {{B}} = {{A}}{{B}}', { A: '1', B: '2' }), '1 + 2 = 12');
});

test('renderTemplate: throws on unknown placeholder', () => {
  assert.throws(() => _renderTemplate('{{MISSING}}', {}), /unknown placeholder 'MISSING'/);
});

test('llmConfigFor: anthropic uses env-var substitution for apiKey', () => {
  const cfg = _llmConfigFor('anthropic', 'claude-opus-4-7');
  assert.equal(cfg.kind, 'llm-anthropic');
  assert.equal(cfg.modelId, 'claude-opus-4-7');
  assert.equal(cfg.credentials.apiKey, '${ANTHROPIC_API_KEY}');
});

test('llmConfigFor: genai-hub sets full credential dict', () => {
  const cfg = _llmConfigFor('genai-hub', 'gpt-4o');
  assert.equal(cfg.kind, 'llm-genai-hub');
  assert.equal(cfg.credentials.aiCoreUrl, '${AICORE_URL}');
  assert.equal(cfg.credentials.resourceGroup, '${AICORE_RESOURCE_GROUP}');
});

test('init: refuses when directory positional missing', async () => {
  const ctx = makeCtx();
  const code = await initCmd(ctx);
  assert.equal(code, 2);
  assert.match(ctx._read().stderr, /usage: saptarishi-llm init/);
});

test('init: rejects unknown provider', async () => {
  const ctx = makeCtx({ positionals: ['some-dir'], opts: { provider: 'bogus' } });
  const code = await initCmd(ctx);
  assert.equal(code, 2);
  assert.match(ctx._read().stderr, /unknown provider/);
});

test('init: rejects non-empty target without --force', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
  try {
    const ctx = makeCtx({ positionals: [dir] });
    const code = await initCmd(ctx);
    assert.equal(code, 1);
    assert.match(ctx._read().stderr, /not empty/);
  } finally { cleanup(dir); }
});

test('init: --dry-run creates nothing but lists files', async () => {
  const dir = tmpDir();
  cleanup(dir);
  try {
    const ctx = makeCtx({ positionals: [dir], opts: { 'dry-run': true } });
    const code = await initCmd(ctx);
    assert.equal(code, 0);
    const out = ctx._read().stdout;
    assert.match(out, /Would scaffold/);
    assert.match(out, /package\.json/);
    assert.match(out, /srv\/ai-service\.cds/);
    assert.equal(fs.existsSync(dir), false, 'directory should not have been created');
  } finally { cleanup(dir); }
});

test('init: default anthropic scaffold creates all files with correct content', async () => {
  const dir = path.join(tmpDir(), 'my-app');
  try {
    const ctx = makeCtx({ positionals: [dir] });
    const code = await initCmd(ctx);
    assert.equal(code, 0);

    for (const rel of ['package.json', 'srv/ai-service.cds', 'srv/ai-service.js', '.env.example', '.gitignore', 'README.md']) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `expected ${rel} to exist`);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-app');
    assert.equal(pkg.cds.requires.llm.kind, 'llm-anthropic');
    assert.equal(pkg.cds.requires.llm.modelId, 'claude-opus-4-7');
    assert.equal(pkg.cds.requires.llm.credentials.apiKey, '${ANTHROPIC_API_KEY}');
    assert.match(pkg.dependencies['@saptarishi/cds-plugin-llm'], /^\^\d/);

    const svcJs = fs.readFileSync(path.join(dir, 'srv/ai-service.js'), 'utf8');
    assert.match(svcJs, /cds\.connect\.to\('llm'\)/);
    assert.match(svcJs, /this\.on\('chat'/);
    assert.match(svcJs, /this\.on\('summarize'/);

    const envEx = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(envEx, /ANTHROPIC_API_KEY=/);

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env$/m);
    assert.match(gitignore, /^node_modules\//m);
  } finally { cleanup(path.dirname(dir)); }
});

test('init: --provider groq --model overrides both', async () => {
  const dir = path.join(tmpDir(), 'groq-app');
  try {
    const ctx = makeCtx({
      positionals: [dir],
      opts: { provider: 'groq', model: 'llama-3.1-8b-instant' },
    });
    const code = await initCmd(ctx);
    assert.equal(code, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.cds.requires.llm.kind, 'llm-groq');
    assert.equal(pkg.cds.requires.llm.modelId, 'llama-3.1-8b-instant');
    assert.equal(pkg.cds.requires.llm.credentials.apiKey, '${GROQ_API_KEY}');
    const envEx = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(envEx, /GROQ_API_KEY=/);
  } finally { cleanup(path.dirname(dir)); }
});

test('init: --force overwrites non-empty dir', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
  try {
    const ctx = makeCtx({ positionals: [dir], opts: { force: true } });
    const code = await initCmd(ctx);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    assert.ok(fs.existsSync(path.join(dir, 'existing.txt'))); // pre-existing files stay
  } finally { cleanup(dir); }
});

test('init: app name is derived from directory basename, lowercased', async () => {
  const parent = tmpDir();
  const dir = path.join(parent, 'My CamelCase App!');
  try {
    const ctx = makeCtx({ positionals: [dir] });
    const code = await initCmd(ctx);
    assert.equal(code, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-camelcase-app-');
  } finally { cleanup(parent); }
});

test('init: generated package.json is valid JSON for every provider', async () => {
  const parent = tmpDir();
  try {
    for (const provider of ['anthropic', 'ollama', 'groq', 'openai-compatible', 'genai-hub']) {
      const dir = path.join(parent, `app-${provider}`);
      const ctx = makeCtx({ positionals: [dir], opts: { provider } });
      const code = await initCmd(ctx);
      assert.equal(code, 0, `init failed for ${provider}`);
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw);
      assert.equal(pkg.cds.requires.llm.kind, `llm-${provider}`);
    }
  } finally { cleanup(parent); }
});

test('CLI end-to-end: `saptarishi-llm init` via subprocess actually scaffolds', () => {
  const parent = tmpDir();
  const dir = path.join(parent, 'sub-app');
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  try {
    const out = execFileSync(process.execPath, [bin, 'init', dir, '--provider', 'ollama'], { encoding: 'utf8' });
    assert.match(out, /Scaffolded sub-app/);
    assert.ok(fs.existsSync(path.join(dir, 'srv/ai-service.js')));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.cds.requires.llm.kind, 'llm-ollama');
  } finally { cleanup(parent); }
});
