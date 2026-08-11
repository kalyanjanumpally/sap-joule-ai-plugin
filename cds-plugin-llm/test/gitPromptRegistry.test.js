const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_gitprompt__';
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

const {
  gitPromptRegistry,
  defaultCacheDir,
  currentSha,
} = require('../lib/gitPromptRegistry');

// ---- Mock runner --------------------------------------------------------
//
// Instead of invoking real git, we simulate the operations by writing
// files into the cache directory and reporting a scripted "SHA" per pull.

function makeMockRunner({ shas, sourceFiles = {}, onArgs = null }) {
  let pullIdx = 0;
  return function runner(args, cwd) {
    if (onArgs) onArgs(args, cwd);
    if (args[0] === 'clone') {
      const dest = args[args.length - 1];
      fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      // Seed with the initial file set.
      for (const [rel, content] of Object.entries(sourceFiles)) {
        const full = path.join(dest, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      return '';
    }
    if (args[0] === 'fetch') {
      return '';
    }
    if (args[0] === 'checkout') {
      // For subsequent pulls, tests can rotate the file set via sourceFiles[__nextPull].
      return '';
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const sha = shas[Math.min(pullIdx, shas.length - 1)];
      pullIdx++;
      return sha + '\n';
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

function tmpDir(name) {
  const p = path.join(os.tmpdir(), `git-registry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// A single valid ESM prompt module, written to a file, imported at load.
function samplePromptFile(name = 'summarize') {
  return `
export default {
  name: '${name}',
  description: 'test template',
  arguments: [{ name: 'text', required: true }],
  render: ({ text }) => ({
    system: 'You are a summarizer.',
    messages: [{ role: 'user', content: text }],
  }),
};
`;
}

// ---- Input validation --------------------------------------------------

test('gitPromptRegistry: throws without url', async () => {
  await assert.rejects(gitPromptRegistry({}), /url is required/);
});
test('gitPromptRegistry: throws on empty branch', async () => {
  await assert.rejects(
    gitPromptRegistry({ url: 'https://x.git', branch: '' }),
    /branch must be a non-empty string/,
  );
});
test('gitPromptRegistry: throws on invalid pollMs', async () => {
  await assert.rejects(
    gitPromptRegistry({ url: 'https://x.git', pollMs: 500 }),
    /pollMs must be >= 1000/,
  );
});
test('gitPromptRegistry: throws on non-function runner', async () => {
  await assert.rejects(
    gitPromptRegistry({ url: 'https://x.git', runner: 'x' }),
    /runner must be a function/,
  );
});
test('gitPromptRegistry: throws on non-function onChange', async () => {
  await assert.rejects(
    gitPromptRegistry({ url: 'https://x.git', onChange: 'x' }),
    /callbacks must be functions/,
  );
});

// ---- defaultCacheDir --------------------------------------------------

test('defaultCacheDir: deterministic per URL', () => {
  const a = defaultCacheDir('https://github.com/x/y.git');
  const b = defaultCacheDir('https://github.com/x/y.git');
  assert.equal(a, b);
});
test('defaultCacheDir: different URLs → different dirs', () => {
  const a = defaultCacheDir('https://github.com/x/y.git');
  const b = defaultCacheDir('https://github.com/x/z.git');
  assert.notEqual(a, b);
});

// ---- Initial clone + load ---------------------------------------------

test('gitPromptRegistry: clones + loads prompts on init', async () => {
  const dir = tmpDir('init');
  const runner = makeMockRunner({
    shas: ['sha1'],
    sourceFiles: { 'summarize.mjs': samplePromptFile('summarize') },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
  });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].name, 'summarize');
  assert.equal(registry.sha, 'sha1');
  assert.equal(registry.stats.loads, 1);
  assert.equal(registry.stats.pullSuccesses, 1);
  assert.ok(registry.refreshedAt);
  registry.stop();
});

test('gitPromptRegistry: subdir loads only from that path', async () => {
  const dir = tmpDir('subdir');
  const runner = makeMockRunner({
    shas: ['sha1'],
    sourceFiles: {
      'ignored.mjs':          samplePromptFile('ignored'),
      'prompts/summarize.mjs': samplePromptFile('summarize'),
      'prompts/other.mjs':     samplePromptFile('other'),
    },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner, subdir: 'prompts',
  });
  const names = registry.list().map((p) => p.name).sort();
  assert.deepEqual(names, ['other', 'summarize']);
  registry.stop();
});

test('gitPromptRegistry: rendered template works end-to-end', async () => {
  const dir = tmpDir('render');
  const runner = makeMockRunner({
    shas: ['sha1'],
    sourceFiles: { 'summarize.mjs': samplePromptFile('summarize') },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
  });
  const req = registry.render('summarize', { text: 'hello world' });
  assert.equal(req.system, 'You are a summarizer.');
  assert.equal(req.messages[0].content, 'hello world');
  registry.stop();
});

// ---- Missing subdir ---------------------------------------------------

test('gitPromptRegistry: throws when subdir does not exist in repo', async () => {
  const dir = tmpDir('bad-subdir');
  const runner = makeMockRunner({
    shas: ['sha1'],
    sourceFiles: { 'other.mjs': samplePromptFile('other') },
  });
  await assert.rejects(
    gitPromptRegistry({
      url: 'https://mock.git', dir, runner, subdir: 'no-such-dir',
    }),
    /subdir 'no-such-dir' does not exist/,
  );
});

// ---- Pull on SHA change reloads ---------------------------------------

test('gitPromptRegistry: pull() detects SHA change + reloads', async () => {
  const dir = tmpDir('reload');
  const events = [];
  const runner = makeMockRunner({
    shas: ['sha1', 'sha2'],
    sourceFiles: { 'summarize.mjs': samplePromptFile('summarize') },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
    onChange: (info) => events.push(info),
  });
  assert.equal(registry.sha, 'sha1');
  // Simulate a git checkout swapping content in place — we rewrite the
  // template file before the next pull so the cache-busted import
  // returns the new module body.
  fs.writeFileSync(path.join(dir, 'summarize.mjs'), samplePromptFile('renamed'));
  await registry.pull();
  assert.equal(registry.sha, 'sha2');
  assert.equal(registry.stats.changesDetected, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].from, 'sha1');
  assert.equal(events[0].to, 'sha2');
  assert.equal(registry.list()[0].name, 'renamed');
  registry.stop();
});

test('gitPromptRegistry: pull() with same SHA is a no-op', async () => {
  const dir = tmpDir('nochange');
  const events = [];
  const runner = makeMockRunner({
    shas: ['sha1', 'sha1'],
    sourceFiles: { 'summarize.mjs': samplePromptFile('summarize') },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
    onChange: (info) => events.push(info),
  });
  await registry.pull();
  assert.equal(events.length, 0);
  assert.equal(registry.stats.changesDetected, 0);
  assert.equal(registry.stats.pullSuccesses, 2);
  registry.stop();
});

// ---- Pull failures ---------------------------------------------------

test('gitPromptRegistry: pull() failure → onError + stats.pullErrors++', async () => {
  const dir = tmpDir('failure');
  const shouldFail = { n: 0 };
  const errors = [];
  const runner = (args, cwd) => {
    // Succeed on init clone, then throw on subsequent fetch.
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1], 'summarize.mjs'), samplePromptFile('summarize'));
      return '';
    }
    if (args[0] === 'rev-parse') return 'sha-init\n';
    if (args[0] === 'checkout') return '';
    if (args[0] === 'fetch') {
      shouldFail.n++;
      if (shouldFail.n > 1) throw new Error('network partition');
      return '';
    }
    return '';
  };
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
    onError: (err) => errors.push(err),
  });
  await assert.rejects(registry.pull(), /network partition/);
  assert.equal(registry.stats.pullErrors, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /network partition/);
  registry.stop();
});

test('gitPromptRegistry: onError callback error swallowed', async () => {
  const dir = tmpDir('onerror-throws');
  let fetchN = 0;
  const runner = (args) => {
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1], 'p.mjs'), samplePromptFile('p'));
      return '';
    }
    if (args[0] === 'rev-parse') return 'sha\n';
    if (args[0] === 'checkout') return '';
    if (args[0] === 'fetch') {
      fetchN++;
      if (fetchN > 1) throw new Error('fetch failed');
      return '';
    }
    return '';
  };
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
    onError: () => { throw new Error('broken listener'); },
  });
  await assert.rejects(registry.pull(), /fetch failed/);
  registry.stop();
});

// ---- refresh() -------------------------------------------------------

test('gitPromptRegistry: refresh() reloads from disk without pulling', async () => {
  const dir = tmpDir('refresh');
  const events = [];
  let pulls = 0;
  const runner = (args) => {
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1], 'p.mjs'), samplePromptFile('p'));
      return '';
    }
    if (args[0] === 'rev-parse') return 'sha\n';
    if (args[0] === 'checkout') return '';
    if (args[0] === 'fetch') { pulls++; return ''; }
    return '';
  };
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner,
    onChange: (info) => events.push(info),
  });
  const pullsBefore = pulls;
  // Hand-edit the working tree.
  fs.writeFileSync(path.join(dir, 'p.mjs'), samplePromptFile('rewritten'));
  await registry.refresh();
  assert.equal(pulls, pullsBefore);   // no git operations
  assert.equal(registry.list()[0].name, 'rewritten');
  registry.stop();
});

// ---- Polling ---------------------------------------------------------

test('gitPromptRegistry: pollMs starts an interval timer', async () => {
  const dir = tmpDir('poll');
  const runner = (args) => {
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1], 'p.mjs'), samplePromptFile('p'));
      return '';
    }
    if (args[0] === 'rev-parse') return 'sha\n';
    if (args[0] === 'checkout') return '';
    if (args[0] === 'fetch') return '';
    return '';
  };
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner, pollMs: 1000,
  });
  // Ensure stop() clears the timer without hanging the process.
  registry.stop();
  // Second stop is a no-op.
  registry.stop();
});

// ---- MCP resource + stats -------------------------------------------

test('gitPromptRegistry: asMcpResource', async () => {
  const dir = tmpDir('mcp');
  const runner = makeMockRunner({
    shas: ['sha1'],
    sourceFiles: { 'p.mjs': samplePromptFile('p') },
  });
  const registry = await gitPromptRegistry({
    url: 'https://mock.git', dir, runner, branch: 'develop',
  });
  const r = registry.asMcpResource();
  assert.equal(r.uri, 'config://git-prompt-registry');
  const p = r.handler();
  assert.equal(p.url, 'https://mock.git');
  assert.equal(p.branch, 'develop');
  assert.equal(p.currentSha, 'sha1');
  assert.equal(p.loads, 1);
  registry.stop();
});

// ---- Uses ref when provided ----------------------------------------

test('gitPromptRegistry: ref overrides branch', async () => {
  const dir = tmpDir('ref');
  const seenArgs = [];
  const runner = (args) => {
    seenArgs.push(args);
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1], 'p.mjs'), samplePromptFile('p'));
      return '';
    }
    if (args[0] === 'rev-parse') return 'sha-tag\n';
    if (args[0] === 'checkout') return '';
    if (args[0] === 'fetch') return '';
    return '';
  };
  await gitPromptRegistry({
    url: 'https://mock.git', dir, runner, branch: 'main', ref: 'v1.2.3',
  });
  const fetchArgs = seenArgs.find((a) => a[0] === 'fetch');
  // fetch origin v1.2.3 --depth 1
  assert.equal(fetchArgs[2], 'v1.2.3');
});
