const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_repl__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const chat = require('../lib/cli/commands/chat');
const { parseSlashCommand, handleSlashCommand } = chat;

// ---- I/O helpers -------------------------------------------------------

class BufferStream {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(''); }
}

// Streaming stdin: pushes lines async so readline reads them.
const { Readable } = require('node:stream');

function scriptedStdin(lines) {
  // Emit each line + newline as separate chunks so readline reads them
  // sequentially. Close after final line.
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const l of lines) s.push(l + '\n');
    s.push(null);
  });
  return s;
}

function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), `chatrepl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  if (content !== undefined) fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---- parseSlashCommand -------------------------------------------------

test('parseSlashCommand: returns null for non-slash', () => {
  assert.equal(parseSlashCommand('hello'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand(null), null);
});
test('parseSlashCommand: bare dot returns empty command', () => {
  assert.deepEqual(parseSlashCommand('.'), { command: '', args: '' });
});
test('parseSlashCommand: single word', () => {
  assert.deepEqual(parseSlashCommand('.help'), { command: 'help', args: '' });
});
test('parseSlashCommand: command + args', () => {
  assert.deepEqual(parseSlashCommand('.system be terse and formal'), {
    command: 'system', args: 'be terse and formal',
  });
});
test('parseSlashCommand: command is lowercased', () => {
  assert.deepEqual(parseSlashCommand('.SYSTEM foo'), { command: 'system', args: 'foo' });
});
test('parseSlashCommand: strips leading/trailing whitespace on args', () => {
  assert.deepEqual(parseSlashCommand('.model  gpt-4o   '), { command: 'model', args: 'gpt-4o' });
});

// ---- handleSlashCommand ------------------------------------------------

function makeIo() {
  return { stdout: new BufferStream(), stderr: new BufferStream() };
}

test('handle .exit: returns exit', () => {
  const io = makeIo();
  const state = { messages: [], system: null, model: null };
  const r = handleSlashCommand({ command: 'exit', args: '' }, state, io);
  assert.equal(r, 'exit');
  assert.match(io.stdout.toString(), /bye/);
});
test('handle .quit alias', () => {
  const r = handleSlashCommand({ command: 'quit', args: '' },
    { messages: [], system: null, model: null }, makeIo());
  assert.equal(r, 'exit');
});
test('handle .q alias', () => {
  const r = handleSlashCommand({ command: 'q', args: '' },
    { messages: [], system: null, model: null }, makeIo());
  assert.equal(r, 'exit');
});
test('handle .help lists commands', () => {
  const io = makeIo();
  handleSlashCommand({ command: 'help', args: '' },
    { messages: [], system: null, model: null }, io);
  const out = io.stdout.toString();
  assert.match(out, /\.system/);
  assert.match(out, /\.model/);
  assert.match(out, /\.exit/);
});
test('handle .? alias for help', () => {
  const io = makeIo();
  handleSlashCommand({ command: '?', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.match(io.stdout.toString(), /\.system/);
});
test('handle .system without args prints current or empty', () => {
  const io = makeIo();
  handleSlashCommand({ command: 'system', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.match(io.stdout.toString(), /no system prompt/);
  const io2 = makeIo();
  handleSlashCommand({ command: 'system', args: '' },
    { messages: [], system: 'be terse', model: null }, io2);
  assert.match(io2.stdout.toString(), /system:.*be terse/);
});
test('handle .system <text> updates state', () => {
  const io = makeIo();
  const state = { messages: [], system: null, model: null };
  handleSlashCommand({ command: 'system', args: 'be terse' }, state, io);
  assert.equal(state.system, 'be terse');
  assert.match(io.stdout.toString(), /system prompt updated/);
});
test('handle .model without args shows current', () => {
  const io = makeIo();
  handleSlashCommand({ command: 'model', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.match(io.stdout.toString(), /provider default/);
});
test('handle .model <id> updates state', () => {
  const io = makeIo();
  const state = { messages: [], system: null, model: null };
  handleSlashCommand({ command: 'model', args: 'gpt-4o-mini' }, state, io);
  assert.equal(state.model, 'gpt-4o-mini');
  assert.match(io.stdout.toString(), /model → gpt-4o-mini/);
});
test('handle .clear empties messages', () => {
  const io = makeIo();
  const state = { messages: [{ role: 'user', content: 'hi' }], system: null, model: null };
  handleSlashCommand({ command: 'clear', args: '' }, state, io);
  assert.equal(state.messages.length, 0);
  assert.match(io.stdout.toString(), /cleared/);
});
test('handle .history shows message count + last', () => {
  const io = makeIo();
  handleSlashCommand({ command: 'history', args: '' },
    { messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second turn' },
    ], system: null, model: null }, io);
  const out = io.stdout.toString();
  assert.match(out, /3 message/);
  assert.match(out, /second turn/);
});
test('handle .history empty case', () => {
  const io = makeIo();
  handleSlashCommand({ command: 'history', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.match(io.stdout.toString(), /\(empty\)/);
});
test('handle .save writes JSON file', () => {
  const io = makeIo();
  const p = tmpFile('save.json');
  const state = {
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    system: 'test system',
    model: 'test-model',
  };
  handleSlashCommand({ command: 'save', args: p }, state, io);
  const loaded = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.unlinkSync(p);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.system, 'test system');
  assert.equal(loaded.model, 'test-model');
  assert.match(io.stdout.toString(), /saved 2 message/);
});
test('handle .save without args errors', () => {
  const io = makeIo();
  const r = handleSlashCommand({ command: 'save', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.equal(r, 'error');
  assert.match(io.stderr.toString(), /usage: .save <file>/);
});
test('handle .save to bad path errors', () => {
  const io = makeIo();
  const r = handleSlashCommand({ command: 'save', args: '/nonexistent-dir-xyz/file.json' },
    { messages: [], system: null, model: null }, io);
  assert.equal(r, 'error');
  assert.match(io.stderr.toString(), /save failed/);
});
test('handle .load replaces state', () => {
  const p = tmpFile('load.json', JSON.stringify({
    messages: [{ role: 'user', content: 'loaded' }],
    system: 'loaded-sys',
    model: 'loaded-model',
  }));
  const io = makeIo();
  const state = { messages: [{ role: 'user', content: 'original' }], system: null, model: null };
  handleSlashCommand({ command: 'load', args: p }, state, io);
  fs.unlinkSync(p);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, 'loaded');
  assert.equal(state.system, 'loaded-sys');
  assert.equal(state.model, 'loaded-model');
});
test('handle .load without args errors', () => {
  const io = makeIo();
  const r = handleSlashCommand({ command: 'load', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.equal(r, 'error');
});
test('handle .load malformed file errors', () => {
  const p = tmpFile('bad.json', '{ not json');
  const io = makeIo();
  const r = handleSlashCommand({ command: 'load', args: p },
    { messages: [], system: null, model: null }, io);
  fs.unlinkSync(p);
  assert.equal(r, 'error');
  assert.match(io.stderr.toString(), /load failed/);
});
test('handle .load file missing messages array errors', () => {
  const p = tmpFile('badshape.json', JSON.stringify({ notMessages: [] }));
  const io = makeIo();
  const r = handleSlashCommand({ command: 'load', args: p },
    { messages: [], system: null, model: null }, io);
  fs.unlinkSync(p);
  assert.equal(r, 'error');
  assert.match(io.stderr.toString(), /messages.*array/);
});
test('handle unknown command reports error', () => {
  const io = makeIo();
  const r = handleSlashCommand({ command: 'bogus', args: '' },
    { messages: [], system: null, model: null }, io);
  assert.equal(r, 'unknown');
  assert.match(io.stderr.toString(), /unknown command '.bogus'/);
});

// ---- Full REPL end-to-end (via scripted stdin) --------------------------

function makeCtx({ opts = {}, stdin, provider } = {}) {
  return {
    opts: { interactive: true, ...opts },
    positionals: [],
    env: {},
    stdin: stdin ?? scriptedStdin([]),
    stdout: new BufferStream(),
    stderr: new BufferStream(),
    buildProvider: async () => ({
      provider: provider ?? {
        async init() {},
        async chat(req) {
          return {
            text: `echo: ${req.messages[req.messages.length - 1].content}`,
            model: 'test-model',
            usage: { input_tokens: 5, output_tokens: 10 },
          };
        },
      },
      kind: 'test-provider',
      model: 'test-model',
    }),
    readInput: async () => '',
  };
}

test('REPL: single turn + exit', async () => {
  const ctx = makeCtx({ stdin: scriptedStdin(['hello world', '.exit']) });
  const code = await chat(ctx);
  assert.equal(code, 0);
  const out = ctx.stdout.toString();
  assert.match(out, /REPL/);
  assert.match(out, /echo: hello world/);
  assert.match(out, /bye/);
});

test('REPL: multi-turn preserves history', async () => {
  let seenMessages;
  const provider = {
    async init() {},
    async chat(req) {
      seenMessages = req.messages;
      return { text: `reply-${req.messages.length}`, model: 'test-model', usage: {} };
    },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['first', 'second', 'third', '.exit']),
    provider,
  });
  await chat(ctx);
  // 3 user turns + 3 assistant replies = 6 messages on the last call, but the
  // request for the 3rd turn saw messages BEFORE the assistant reply was
  // appended → 5 messages (first, reply-1, second, reply-3, third).
  assert.equal(seenMessages.length, 5);
  assert.equal(seenMessages[0].content, 'first');
  assert.equal(seenMessages[4].content, 'third');
});

test('REPL: .clear resets between turns', async () => {
  const seen = [];
  const provider = {
    async init() {},
    async chat(req) {
      seen.push(req.messages.length);
      return { text: 'r', model: 'test-model', usage: {} };
    },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['first', '.clear', 'second', '.exit']),
    provider,
  });
  await chat(ctx);
  // First call: 1 message ('first')
  // After .clear
  // Second call: 1 message ('second') — history was cleared
  assert.deepEqual(seen, [1, 1]);
});

test('REPL: .system updates future turns', async () => {
  let seenSystem;
  const provider = {
    async init() {},
    async chat(req) {
      seenSystem = req.system;
      return { text: 'r', model: 'test-model', usage: {} };
    },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['.system be terse', 'hi', '.exit']),
    provider,
  });
  await chat(ctx);
  assert.equal(seenSystem, 'be terse');
});

test('REPL: .model updates future turns', async () => {
  let seenModel;
  const provider = {
    async init() {},
    async chat(req) {
      seenModel = req.model;
      return { text: 'r', model: seenModel, usage: {} };
    },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['.model gpt-4o', 'hi', '.exit']),
    provider,
  });
  await chat(ctx);
  assert.equal(seenModel, 'gpt-4o');
});

test('REPL: empty lines skipped', async () => {
  let calls = 0;
  const provider = {
    async init() {},
    async chat() { calls++; return { text: 'r', model: 'x', usage: {} }; },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['', '   ', 'hello', '', '.exit']),
    provider,
  });
  await chat(ctx);
  assert.equal(calls, 1);   // only 'hello' triggered a call
});

test('REPL: provider error printed to stderr but REPL continues', async () => {
  let calls = 0;
  const provider = {
    async init() {},
    async chat(req) {
      calls++;
      if (calls === 1) throw new Error('provider down');
      return { text: 'recovered', model: 'x', usage: {} };
    },
  };
  const ctx = makeCtx({
    stdin: scriptedStdin(['first', 'second', '.exit']),
    provider,
  });
  await chat(ctx);
  assert.equal(calls, 2);
  assert.match(ctx.stderr.toString(), /provider down/);
  assert.match(ctx.stdout.toString(), /recovered/);
});

// ---- One-shot mode still works (regression) ----------------------------

test('one-shot mode unchanged when not interactive', async () => {
  const ctx = {
    opts: { prompt: 'hello' },
    positionals: [],
    env: {},
    stdin: null,
    stdout: new BufferStream(),
    stderr: new BufferStream(),
    buildProvider: async () => ({
      provider: {
        async init() {},
        async chat() { return { text: 'ok', model: 'test', usage: {} }; },
      },
      kind: 'test',
      model: 'test',
    }),
    readInput: async () => 'hello',
  };
  const code = await chat(ctx);
  assert.equal(code, 0);
  assert.match(ctx.stdout.toString(), /^ok/);
});

// ---- Help text --------------------------------------------------------

test('help mentions REPL mode', () => {
  assert.match(chat.help, /interactive|REPL/i);
  assert.match(chat.help, /\.system/);
  assert.match(chat.help, /\.exit/);
});
