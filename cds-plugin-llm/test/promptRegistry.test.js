const { test } = require('node:test');
const assert = require('node:assert/strict');
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
