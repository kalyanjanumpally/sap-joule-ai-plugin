const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PromptRegistry, builtInPrompts } = require('../lib/promptRegistry');

test('PromptRegistry: rejects invalid registration', () => {
  const r = new PromptRegistry();
  assert.throws(() => r.register({}), /name is required/);
  assert.throws(() => r.register({ name: 'x' }), /render must be a function/);
  assert.throws(() => r.register({ name: 'x', render: 'not-a-fn' }), /render must be a function/);
  assert.throws(() => r.register({ name: 'x', render: () => ({}), arguments: 'nope' }), /arguments must be an array/);
});

test('PromptRegistry: rejects duplicate names', () => {
  const r = new PromptRegistry();
  r.register({ name: 'x', render: () => ({ messages: [] }) });
  assert.throws(() => r.register({ name: 'x', render: () => ({ messages: [] }) }), /already registered/);
});

test('PromptRegistry: register returns this for chaining', () => {
  const r = new PromptRegistry();
  const chained = r
    .register({ name: 'a', render: () => ({ messages: [] }) })
    .register({ name: 'b', render: () => ({ messages: [] }) });
  assert.equal(chained, r);
  assert.equal(r.list().length, 2);
});

test('PromptRegistry: list exposes name/description/arguments', () => {
  const r = new PromptRegistry();
  r.register({
    name: 'p1',
    description: 'demo prompt',
    arguments: [{ name: 'text', required: true }],
    render: () => ({ messages: [] }),
  });
  const l = r.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].name, 'p1');
  assert.equal(l[0].description, 'demo prompt');
  assert.equal(l[0].arguments[0].name, 'text');
});

test('PromptRegistry: has() reflects registration', () => {
  const r = new PromptRegistry();
  assert.equal(r.has('x'), false);
  r.register({ name: 'x', render: () => ({ messages: [] }) });
  assert.equal(r.has('x'), true);
});

test('PromptRegistry.render: dispatches to registered template', () => {
  const r = new PromptRegistry();
  r.register({
    name: 'echo',
    render: ({ text }) => ({
      system: 'echo',
      messages: [{ role: 'user', content: text }],
    }),
  });
  const req = r.render('echo', { text: 'hello' });
  assert.equal(req.system, 'echo');
  assert.equal(req.messages[0].content, 'hello');
});

test('PromptRegistry.render: throws for unregistered names', () => {
  const r = new PromptRegistry();
  assert.throws(() => r.render('nope', {}), /not registered/);
});

test('PromptRegistry.render: enforces required arguments', () => {
  const r = new PromptRegistry();
  r.register({
    name: 'need',
    arguments: [{ name: 'text', required: true }],
    render: ({ text }) => ({ messages: [{ role: 'user', content: text }] }),
  });
  assert.throws(() => r.render('need', {}), /missing required argument 'text'/);
  const ok = r.render('need', { text: 'hi' });
  assert.equal(ok.messages[0].content, 'hi');
});

test('PromptRegistry.render: rejects render() that returns non-array messages', () => {
  const r = new PromptRegistry();
  r.register({ name: 'bad', render: () => ({ system: 'x' }) });
  assert.throws(() => r.render('bad', {}), /must return \{ messages: \[\.\.\.\] \}/);
});

test('PromptRegistry.registerAll: bulk registers', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  assert.ok(r.list().length >= 4);
  assert.ok(r.has('summarize'));
  assert.ok(r.has('extract_json'));
  assert.ok(r.has('classify'));
  assert.ok(r.has('translate'));
});

test('builtInPrompts: summarize renders system + user messages', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const req = r.render('summarize', { text: 'long text here', sentences: 2 });
  assert.match(req.system, /at most 2 sentences/);
  assert.equal(req.messages[0].content, 'long text here');
});

test('builtInPrompts: extract_json passes format schema through', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  const req = r.render('extract_json', { text: 'John Doe', schema });
  assert.deepEqual(req.format, schema);
});

test('builtInPrompts: extract_json accepts schema as JSON string', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const req = r.render('extract_json', { text: 'x', schema: '{"type":"object"}' });
  assert.deepEqual(req.format, { type: 'object' });
});

test('builtInPrompts: classify accepts array or comma-separated labels', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const arr = r.render('classify', { text: 'x', labels: ['a', 'b', 'c'] });
  assert.match(arr.system, /a, b, c/);
  const csv = r.render('classify', { text: 'x', labels: 'a, b, c' });
  assert.match(csv.system, /a, b, c/);
});

test('builtInPrompts: translate builds target-language system prompt', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const req = r.render('translate', { text: 'hello', targetLanguage: 'German' });
  assert.match(req.system, /Translate .* into German/);
});

test('builtInPrompts: procurement_risk_scorer is SAP-flavored', () => {
  const r = new PromptRegistry().registerAll(builtInPrompts());
  const req = r.render('procurement_risk_scorer', { text: 'PO 4500000123' });
  assert.match(req.system, /SAP procurement risk analyst/);
});

// ---- loadFromDir (1.9.0) --------------------------------------------------

function tmpPromptsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sllm-prompts-'));
}

test('loadFromDir: rejects missing directory', async () => {
  const r = new PromptRegistry();
  await assert.rejects(() => r.loadFromDir('/nonexistent/path/xyz-42'), /does not exist/);
});

test('loadFromDir: rejects when path is a file, not a directory', async () => {
  const dir = tmpPromptsDir();
  const f = path.join(dir, 'not-a-dir.mjs');
  fs.writeFileSync(f, 'export default {}');
  try {
    const r = new PromptRegistry();
    await assert.rejects(() => r.loadFromDir(f), /not a directory/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadFromDir: default export template gets registered', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'greet.mjs'), `
    export default {
      name: 'greet_from_file',
      description: 'file-based prompt',
      arguments: [{ name: 'who', required: true }],
      render: ({ who }) => ({ messages: [{ role: 'user', content: 'hello ' + who }] }),
    };
  `);
  try {
    const r = new PromptRegistry();
    const stats = await r.loadFromDir(dir);
    assert.equal(stats.loaded, 1);
    assert.equal(stats.registered, 1);
    assert.ok(r.has('greet_from_file'));
    const rendered = r.render('greet_from_file', { who: 'world' });
    assert.equal(rendered.messages[0].content, 'hello world');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadFromDir: default export array registers each element', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'bundle.mjs'), `
    export default [
      { name: 'a1', render: () => ({ messages: [{ role: 'user', content: 'a' }] }) },
      { name: 'a2', render: () => ({ messages: [{ role: 'user', content: 'b' }] }) },
    ];
  `);
  try {
    const r = new PromptRegistry();
    const stats = await r.loadFromDir(dir);
    assert.equal(stats.registered, 2);
    assert.ok(r.has('a1'));
    assert.ok(r.has('a2'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadFromDir: named exports that look like templates get registered', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'named.mjs'), `
    export const foo = { name: 'named_foo', render: () => ({ messages: [] }) };
    export const bar = { name: 'named_bar', render: () => ({ messages: [] }) };
    export const notTemplate = 42;                // ignored: not a template
    export const alsoNot = { name: 'x' };         // ignored: no render()
  `);
  try {
    const r = new PromptRegistry();
    const stats = await r.loadFromDir(dir);
    assert.equal(stats.registered, 2);
    assert.ok(r.has('named_foo'));
    assert.ok(r.has('named_bar'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadFromDir: ignores non-.mjs/.js files', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not code');
  fs.writeFileSync(path.join(dir, 'README.md'), '# nope');
  try {
    const r = new PromptRegistry();
    const stats = await r.loadFromDir(dir);
    assert.equal(stats.loaded, 0);
    assert.equal(stats.registered, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadFromDir: sorted file order is stable', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'b.mjs'), `export default { name: 'from_b', render: () => ({ messages: [] }) };`);
  fs.writeFileSync(path.join(dir, 'a.mjs'), `export default { name: 'from_a', render: () => ({ messages: [] }) };`);
  try {
    const r = new PromptRegistry();
    await r.loadFromDir(dir);
    const names = r.list().map(p => p.name);
    // a.mjs sorts first, so from_a registers first, then from_b
    assert.deepEqual(names, ['from_a', 'from_b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- unregister / clear / watchDir (1.10.0) ------------------------------

test('unregister: removes template and returns true/false', () => {
  const r = new PromptRegistry();
  r.register({ name: 'a', render: () => ({ messages: [] }) });
  assert.equal(r.unregister('a'), true);
  assert.equal(r.has('a'), false);
  assert.equal(r.unregister('nope'), false);
});

test('clear: removes every template', () => {
  const r = new PromptRegistry();
  r.registerAll(builtInPrompts());
  assert.ok(r.list().length >= 4);
  const chained = r.clear();
  assert.equal(chained, r);
  assert.equal(r.list().length, 0);
});

test('watchDir: throws if loadFromDir was not called first', () => {
  const dir = tmpPromptsDir();
  try {
    const r = new PromptRegistry();
    assert.throws(() => r.watchDir(dir), /no prior loadFromDir/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watchDir: reloads when a file changes; new template appears', async () => {
  const dir = tmpPromptsDir();
  const tplPath = path.join(dir, 'live.mjs');
  fs.writeFileSync(tplPath, `export default { name: 'live_v1', render: () => ({ messages: [] }) };`);
  const r = new PromptRegistry();
  await r.loadFromDir(dir);
  assert.ok(r.has('live_v1'));

  // Only the LAST onReload wins — macOS FSEvents can fire multiple times
  // for one save; wait for the reload that actually contains live_v2.
  let latest = null;
  let resolveLatest;
  const gotV2 = new Promise((res) => { resolveLatest = res; });
  const w = r.watchDir(dir, { debounceMs: 100, onReload: (info) => {
    latest = info;
    if (r.has('live_v2')) resolveLatest(info);
  } });

  await new Promise(res => setTimeout(res, 100));
  fs.writeFileSync(tplPath, `export default { name: 'live_v2', render: () => ({ messages: [] }) };`);

  const info = await Promise.race([
    gotV2,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`reload timeout — latest: ${JSON.stringify(latest)}`)), 5000)),
  ]);
  w.close();
  assert.ok(!info.error, `reload error: ${info.error?.message}`);
  assert.equal(info.registered, 1);
  assert.equal(r.has('live_v1'), false, 'old template should be unregistered');
  assert.ok(r.has('live_v2'), 'new template should be registered');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchDir: onReload surfaces registration errors', async () => {
  const dir = tmpPromptsDir();
  const tplPath = path.join(dir, 'ok.mjs');
  fs.writeFileSync(tplPath, `export default { name: 'ok_prompt', render: () => ({ messages: [] }) };`);
  const r = new PromptRegistry();
  await r.loadFromDir(dir);

  const errPromise = new Promise((resolve) => {
    const w = r.watchDir(dir, { debounceMs: 20, onReload: (info) => {
      if (info.error) { w.close(); resolve(info.error); }
    } });
  });

  await new Promise(res => setTimeout(res, 50));
  // Broken syntax — import() will throw
  fs.writeFileSync(tplPath, `this is not valid javascript !!!`);

  const err = await Promise.race([
    errPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no error surfaced')), 3000)),
  ]);
  assert.ok(err instanceof Error);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadFromDir + watchDir: hot reload picks up new files added later', async () => {
  const dir = tmpPromptsDir();
  fs.writeFileSync(path.join(dir, 'first.mjs'), `export default { name: 'first', render: () => ({ messages: [] }) };`);
  const r = new PromptRegistry();
  await r.loadFromDir(dir);

  let latest = null;
  let resolveGot;
  const gotBoth = new Promise((res) => { resolveGot = res; });
  const w = r.watchDir(dir, { debounceMs: 100, onReload: (info) => {
    latest = info;
    if (r.has('first') && r.has('second')) resolveGot(info);
  } });

  await new Promise(res => setTimeout(res, 100));
  fs.writeFileSync(path.join(dir, 'second.mjs'), `export default { name: 'second', render: () => ({ messages: [] }) };`);

  const info = await Promise.race([
    gotBoth,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout — latest: ${JSON.stringify(latest)}`)), 5000)),
  ]);
  w.close();
  assert.equal(info.loaded, 2);
  assert.ok(r.has('first'));
  assert.ok(r.has('second'));
  fs.rmSync(dir, { recursive: true, force: true });
});
