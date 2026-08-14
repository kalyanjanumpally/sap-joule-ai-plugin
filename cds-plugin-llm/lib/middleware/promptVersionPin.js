// Prompt version pinning. Lock prompt templates at a specific version
// per request — rollback-friendly for canary deployments where 5% of
// traffic runs v4 while 95% stays on v3, or per-session rollback for a
// user who reported a bad response on the new version.
//
// Complements:
//   * `PromptRegistry` (1.8)         — the base registry (unversioned)
//   * `gitPromptRegistry` (2.1)      — Git-backed prompt-as-code loader
//   * `promptExperiment` (2.20)      — live A/B testing across variants
//   * `promptVersionPin` (this)      — version selection for a chosen template
//
// The middleware model:
//   1. Caller sets `ctx.request.templateRef = { name, version? }` (or
//      uses `templateRefOf(ctx)` extractor)
//   2. Middleware looks up an optional per-request pin via `pinFor(ctx, name)`
//      — pin overrides templateRef.version
//   3. If no pin AND no explicit version → latest via `latestVersionOf(name)`
//   4. Middleware resolves the template + calls `applyTemplate(request, template, ctx)`
//   5. Records the resolved version in `ctx.meta.promptVersion` for audit
//
//   const { promptVersionPin, PromptVersionRegistry } = require('@saptarishi/cds-plugin-llm');
//
//   const registry = new PromptVersionRegistry();
//   registry.register('summarize', 1, ({ text }) => ({ messages: [
//     { role: 'user', content: `Summarize (v1): ${text}` }
//   ]}));
//   registry.register('summarize', 2, ({ text }) => ({ messages: [
//     { role: 'user', content: `Summarize concisely (v2): ${text}` }
//   ]}));
//
//   llm.use(promptVersionPin({
//     resolveTemplate:  (name, version) => registry.getVersion(name, version),
//     latestVersionOf:  (name) => registry.latestVersion(name),
//     templateRefOf:    (ctx) => ctx.request.templateRef,
//     pinFor:           (ctx, name) => sessionPins[ctx.request.sessionId]?.[name],
//     applyTemplate:    (req, tpl, ctx) => ({ ...req, ...tpl(req.vars ?? {}) }),
//     onPin: (i) => cds.log('llm:pin').info(i),
//   }));

// ---- Standalone versioned registry ---------------------------------

class PromptVersionRegistry {
  constructor() {
    // name → Map<version, template>
    this._versions = new Map();
    // name → version (highest registered — used as "latest")
    this._latest   = new Map();
  }

  register(name, version, template) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('PromptVersionRegistry.register: name must be a non-empty string.');
    }
    if (typeof version !== 'string' && typeof version !== 'number') {
      throw new Error('PromptVersionRegistry.register: version must be string or number.');
    }
    if (typeof template !== 'function' && (template == null || typeof template !== 'object')) {
      throw new Error('PromptVersionRegistry.register: template must be a function or object.');
    }
    let bucket = this._versions.get(name);
    if (!bucket) { bucket = new Map(); this._versions.set(name, bucket); }
    bucket.set(String(version), template);
    // Track "latest" as most-recently-registered — same as npm's semver ordering
    // is out of scope; users can be explicit via `.setLatest()` if they need it.
    this._latest.set(name, String(version));
    return this;
  }

  setLatest(name, version) {
    const bucket = this._versions.get(name);
    if (!bucket || !bucket.has(String(version))) {
      throw new Error(`PromptVersionRegistry.setLatest: unknown version "${version}" for template "${name}".`);
    }
    this._latest.set(name, String(version));
    return this;
  }

  getVersion(name, version) {
    const bucket = this._versions.get(name);
    if (!bucket) return null;
    return bucket.get(String(version)) ?? null;
  }

  latestVersion(name) {
    return this._latest.get(name) ?? null;
  }

  getLatest(name) {
    const v = this.latestVersion(name);
    return v == null ? null : this.getVersion(name, v);
  }

  listVersions(name) {
    const bucket = this._versions.get(name);
    return bucket ? Array.from(bucket.keys()) : [];
  }

  listTemplates() {
    return Array.from(this._versions.keys());
  }

  // Snapshot for observability + MCP.
  snapshot() {
    const out = {};
    for (const [name, bucket] of this._versions.entries()) {
      out[name] = {
        latest:   this._latest.get(name),
        versions: Array.from(bucket.keys()),
      };
    }
    return out;
  }
}

// ---- Middleware -----------------------------------------------------

function promptVersionPin(options = {}) {
  const {
    resolveTemplate,
    latestVersionOf,
    templateRefOf,
    pinFor          = null,
    applyTemplate,
    metaField       = 'promptVersion',
    onPin           = null,
    onUnpinned      = null,
    onMissing       = null,
    onError         = null,
  } = options;

  if (typeof resolveTemplate !== 'function') {
    throw new Error('promptVersionPin: resolveTemplate(name, version) is required.');
  }
  if (typeof latestVersionOf !== 'function') {
    throw new Error('promptVersionPin: latestVersionOf(name) is required.');
  }
  if (typeof templateRefOf !== 'function') {
    throw new Error('promptVersionPin: templateRefOf(ctx) is required.');
  }
  if (typeof applyTemplate !== 'function') {
    throw new Error('promptVersionPin: applyTemplate(request, template, ctx) is required.');
  }
  if (pinFor != null && typeof pinFor !== 'function') {
    throw new Error('promptVersionPin: pinFor must be a function or null.');
  }
  if (typeof metaField !== 'string' || metaField.length === 0) {
    throw new Error('promptVersionPin: metaField must be a non-empty string.');
  }
  for (const cb of [onPin, onUnpinned, onMissing, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('promptVersionPin: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:        0,
    passthroughs:      0,   // no templateRef
    pinned:            0,   // pinFor returned a version
    explicit:          0,   // templateRef.version provided (no pin)
    latestFallback:    0,   // neither pin nor explicit → used latest
    missing:           0,   // resolveTemplate returned null → passthrough
    errors:            0,
    byTemplate:        {},  // name → { version → count }
    lastResolved:      null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function recordUsage(name, version) {
    let bucket = stats.byTemplate[name];
    if (!bucket) { bucket = {}; stats.byTemplate[name] = bucket; }
    const key = String(version);
    bucket[key] = (bucket[key] ?? 0) + 1;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let ref;
    try { ref = templateRefOf(ctx); }
    catch (err) {
      stats.errors++;
      callHook(onError, { phase: 'templateRefOf', error: err });
      return next();
    }
    if (!ref || typeof ref !== 'object' || typeof ref.name !== 'string' || ref.name.length === 0) {
      stats.passthroughs++;
      return next();
    }

    const templateName = ref.name;

    // Pin resolution priority:
    //   1. pinFor(ctx, name) → wins if truthy
    //   2. templateRef.version → explicit
    //   3. latestVersionOf(name) → default
    let pinnedVersion = null;
    try {
      if (pinFor) pinnedVersion = pinFor(ctx, templateName);
    } catch (err) {
      stats.errors++;
      callHook(onError, { phase: 'pinFor', error: err });
    }

    let resolvedVersion;
    let source;   // 'pin' | 'explicit' | 'latest'
    if (pinnedVersion != null && pinnedVersion !== '') {
      resolvedVersion = String(pinnedVersion);
      source = 'pin';
      stats.pinned++;
    } else if (ref.version != null && ref.version !== '') {
      resolvedVersion = String(ref.version);
      source = 'explicit';
      stats.explicit++;
    } else {
      try { resolvedVersion = latestVersionOf(templateName); }
      catch (err) {
        stats.errors++;
        callHook(onError, { phase: 'latestVersionOf', error: err });
        return next();
      }
      if (resolvedVersion == null) {
        stats.missing++;
        callHook(onMissing, { name: templateName, reason: 'no-latest-version' });
        return next();
      }
      resolvedVersion = String(resolvedVersion);
      source = 'latest';
      stats.latestFallback++;
    }

    let template;
    try { template = resolveTemplate(templateName, resolvedVersion); }
    catch (err) {
      stats.errors++;
      callHook(onError, { phase: 'resolveTemplate', error: err });
      return next();
    }
    if (template == null) {
      stats.missing++;
      callHook(onMissing, { name: templateName, version: resolvedVersion, reason: 'template-not-found' });
      return next();
    }

    // Apply the template to the request.
    const originalRequest = ctx.request;
    let mutatedRequest;
    try { mutatedRequest = applyTemplate(originalRequest, template, ctx); }
    catch (err) {
      stats.errors++;
      callHook(onError, { phase: 'applyTemplate', error: err });
      return next();
    }
    if (mutatedRequest == null || typeof mutatedRequest !== 'object') {
      stats.errors++;
      callHook(onError, { phase: 'applyTemplate', error: new Error('applyTemplate must return an object') });
      return next();
    }

    ctx.request = mutatedRequest;
    // Attach audit metadata (do not stomp existing meta).
    if (!ctx.meta || typeof ctx.meta !== 'object') ctx.meta = {};
    ctx.meta[metaField] = { name: templateName, version: resolvedVersion, source };

    stats.lastResolved = { name: templateName, version: resolvedVersion, source };
    recordUsage(templateName, resolvedVersion);
    callHook(source === 'pin' ? onPin : onUnpinned, {
      name: templateName, version: resolvedVersion, source,
    });

    try {
      return await next();
    } finally {
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.passthroughs = 0;
    stats.pinned = stats.explicit = stats.latestFallback = 0;
    stats.missing = stats.errors = 0;
    stats.lastResolved = null;
    for (const k of Object.keys(stats.byTemplate)) delete stats.byTemplate[k];
  };
  mw.pinRate = () => {
    const resolved = stats.pinned + stats.explicit + stats.latestFallback;
    return resolved === 0 ? 0 : stats.pinned / resolved;
  };
  mw.asMcpResource = () => ({
    uri: 'config://prompt-version-pin',
    name: 'Prompt version pinning',
    description: 'Locks prompt templates at a specific version per request. Records resolved version in ctx.meta for audit.',
    mimeType: 'application/json',
    handler: () => ({
      metaField,
      pinRate: mw.pinRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  promptVersionPin,
  PromptVersionRegistry,
};
