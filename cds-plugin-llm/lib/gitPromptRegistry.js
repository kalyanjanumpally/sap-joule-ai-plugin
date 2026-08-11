// Git-backed prompt registry. Extends the shipped 1.8 PromptRegistry
// with a loader that pulls templates from a Git repository, caches
// them locally, and (optionally) polls for updates. Enables prompt-
// as-code workflows where prompt changes go through PR review,
// separately from code deploys.
//
//   const { gitPromptRegistry } = require('@saptarishi/cds-plugin-llm');
//
//   const registry = await gitPromptRegistry({
//     url:      'https://github.com/my-org/prompts.git',
//     branch:   'main',
//     ref:      'v1.2.3',                    // optional pin
//     dir:      '/tmp/prompts-cache',        // local cache location
//     subdir:   'templates',                 // subdirectory within the repo
//     pollMs:   5 * 60_000,                  // 5 minutes; null to disable
//   });
//
//   const req = registry.render('summarize', { text: '...' });
//   const res = await llm.chat(req);
//
// Prompt format is the same as `loadPromptsFromDir` (1.9): every
// .json / .yaml / .md file describes one template. See
// promptRegistry.js loadPromptsFromDir for the exact shape.
//
// Uses `git` command line if available (no clone/pull without it).
// Users on machines without git can pass a custom `runner`.

const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');
const crypto    = require('node:crypto');
const child_process = require('node:child_process');
const { PromptRegistry } = require('./promptRegistry');

// ---- Helpers ----------------------------------------------------------

function slug(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function defaultCacheDir(url) {
  return path.join(os.tmpdir(), `saptarishi-git-prompts-${slug(url)}`);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Default git runner: shells out to `git`. Returns stdout on success,
 * throws on non-zero exit. Timeout in ms.
 */
function defaultRunner(args, cwd, timeoutMs) {
  const result = child_process.spawnSync('git', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const err = new Error(
      `git ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr ?? '').trim() || result.error?.message || 'no output'}`,
    );
    err.stderr = result.stderr;
    err.stdout = result.stdout;
    err.code   = 'GIT_COMMAND_FAILED';
    throw err;
  }
  return result.stdout ?? '';
}

// ---- Core operations --------------------------------------------------

async function ensureCloned(url, dir, ref, runner, timeoutMs) {
  const gitDir = path.join(dir, '.git');
  if (!isDir(gitDir)) {
    // Fresh clone into `dir`.
    fs.mkdirSync(dir, { recursive: true });
    runner(['clone', '--depth', '1', url, dir], undefined, timeoutMs);
  }
  // Fetch + checkout ref (branch or tag).
  runner(['fetch', 'origin', ref, '--depth', '1'], dir, timeoutMs);
  runner(['checkout', 'FETCH_HEAD'], dir, timeoutMs);
  // Return current commit SHA for observability.
  return runner(['rev-parse', 'HEAD'], dir, timeoutMs).trim();
}

function currentSha(dir, runner, timeoutMs) {
  try { return runner(['rev-parse', 'HEAD'], dir, timeoutMs).trim(); }
  catch { return null; }
}

// ---- Public API -------------------------------------------------------

/**
 * Build a PromptRegistry backed by a Git repository. Clones (if needed),
 * checks out the requested ref, loads every prompt file in `subdir`
 * (default: root), and optionally polls the remote for updates.
 *
 * Returns the registry synchronously augmented with:
 *   - registry.sha         current HEAD SHA
 *   - registry.refreshedAt ISO timestamp of last successful load
 *   - registry.refresh()   force reload from disk (public — great for tests)
 *   - registry.pull()      re-fetch + reload (throws if git fails)
 *   - registry.stop()      stop the polling timer
 *   - registry.stats       { loads, pullSuccesses, pullErrors, changesDetected }
 *
 * onChange(info) fires when a pull surfaces a new SHA.
 * onError(err)   fires on pull failures.
 */
async function gitPromptRegistry(options = {}) {
  const {
    url,
    branch    = 'main',
    ref       = null,          // if null, uses `branch`
    dir       = null,          // default: tmp/saptarishi-git-prompts-<hash>
    subdir    = '.',
    pollMs    = null,
    timeoutMs = 30_000,
    runner    = defaultRunner,
    onChange  = null,
    onError   = null,
  } = options;

  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('gitPromptRegistry: url is required.');
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error('gitPromptRegistry: branch must be a non-empty string.');
  }
  if (ref != null && (typeof ref !== 'string' || ref.length === 0)) {
    throw new Error('gitPromptRegistry: ref must be a non-empty string or null.');
  }
  if (typeof subdir !== 'string' || subdir.length === 0) {
    throw new Error('gitPromptRegistry: subdir must be a non-empty string.');
  }
  if (pollMs != null && (!Number.isFinite(pollMs) || pollMs < 1000)) {
    throw new Error('gitPromptRegistry: pollMs must be >= 1000 (or null to disable).');
  }
  if (typeof runner !== 'function') {
    throw new Error('gitPromptRegistry: runner must be a function.');
  }
  for (const cb of [onChange, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('gitPromptRegistry: callbacks must be functions or null.');
    }
  }

  const cacheDir = dir ?? defaultCacheDir(url);
  const gitRef   = ref ?? branch;

  const stats = {
    loads:            0,
    pullSuccesses:    0,
    pullErrors:       0,
    changesDetected:  0,
    lastError:        null,
    lastSha:          null,
    lastPullAt:       null,
  };

  const registry = new PromptRegistry();
  let currentPromptSha = null;
  let currentPromptDir = null;
  let refreshedAt = null;
  let pollTimer = null;

  async function loadIntoRegistry(rootDir, cacheBust = '') {
    // Rebuild the registry from scratch — cheapest way to handle prompt
    // renames/deletes without leaking stale ones.
    registry.clear();
    const templateDir = path.resolve(rootDir, subdir);
    if (!isDir(templateDir)) {
      throw new Error(`gitPromptRegistry: subdir '${subdir}' does not exist in the repo.`);
    }
    // Cache-bust suffix per pull so ESM import cache doesn't return stale
    // module bodies after a git checkout swaps the file content.
    await registry.loadFromDir(templateDir, { _cacheBust: cacheBust });
    stats.loads++;
    refreshedAt = new Date().toISOString();
    currentPromptDir = templateDir;
  }

  async function refresh() {
    await loadIntoRegistry(cacheDir, `?t=${Date.now()}`);
  }

  async function pull() {
    let newSha;
    try {
      newSha = await ensureCloned(url, cacheDir, gitRef, runner, timeoutMs);
    } catch (err) {
      stats.pullErrors++;
      stats.lastError = err.message;
      if (onError) { try { onError(err); } catch { /* swallow */ } }
      throw err;
    }
    stats.pullSuccesses++;
    stats.lastSha = newSha;
    stats.lastPullAt = new Date().toISOString();

    if (newSha !== currentPromptSha) {
      const previousSha = currentPromptSha;
      await loadIntoRegistry(cacheDir, `?sha=${newSha}`);
      currentPromptSha = newSha;
      // Only count as a "change" when there was a previous SHA — the
      // initial load isn't a change, it's the baseline.
      if (previousSha != null) {
        stats.changesDetected++;
        if (onChange) {
          try { onChange({ from: previousSha, to: newSha, refreshedAt }); }
          catch { /* swallow */ }
        }
      }
    }
    return newSha;
  }

  // Initial clone + load.
  await pull();

  function startPolling() {
    if (pollMs == null || pollTimer != null) return;
    pollTimer = setInterval(() => {
      pull().catch(() => { /* onError already handled */ });
    }, pollMs);
    if (pollTimer.unref) pollTimer.unref();
  }
  function stop() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  if (pollMs != null) startPolling();

  // Augment the registry with git-specific bits.
  Object.defineProperties(registry, {
    sha:            { get: () => currentPromptSha },
    refreshedAt:    { get: () => refreshedAt },
    cacheDir:       { get: () => cacheDir },
    templateDir:    { get: () => currentPromptDir },
    stats:          { get: () => ({ ...stats }) },
  });
  registry.refresh = refresh;
  registry.pull    = pull;
  registry.stop    = stop;
  registry.asMcpResource = () => ({
    uri: 'config://git-prompt-registry',
    name: 'Git-backed prompt registry',
    description: 'Prompts loaded from a Git repository. Counters + current SHA.',
    mimeType: 'application/json',
    handler: () => ({
      url,
      branch,
      ref: gitRef,
      subdir,
      pollMs,
      cacheDir,
      currentSha: currentPromptSha,
      refreshedAt,
      ...stats,
    }),
  });

  return registry;
}

module.exports = {
  gitPromptRegistry,
  // Exposed for tests + composition.
  defaultRunner,
  defaultCacheDir,
  currentSha,
};
