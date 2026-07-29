// Named prompt-template registry. Shared between CAP handlers and the MCP
// server so a prompt registered once is available everywhere.
//
//   const { PromptRegistry } = require('@saptarishi/cds-plugin-llm');
//   const registry = new PromptRegistry();
//
//   registry.register({
//     name: 'summarize',
//     description: 'Summarize text in N sentences',
//     arguments: [
//       { name: 'text',      description: 'Text to summarize', required: true },
//       { name: 'sentences', description: 'Target length',     required: false },
//     ],
//     render: ({ text, sentences = 3 }) => ({
//       system: `You are a concise summarizer. Reply in ${sentences} sentences.`,
//       messages: [{ role: 'user', content: text }],
//     }),
//   });
//
//   // Later, in a CAP handler:
//   const req = registry.render('summarize', { text: '...', sentences: 2 });
//   const res = await llm.chat(req);
//
// render() must return a partial ChatRequest — the caller merges in any
// per-call options (maxTokens, tools, format, etc.) before dispatching.

class PromptRegistry {
  constructor() {
    this._prompts = new Map();
  }

  register(prompt) {
    if (!prompt?.name) throw new Error('prompt.name is required');
    if (typeof prompt.render !== 'function') {
      throw new Error(`prompt ${prompt.name}: render must be a function`);
    }
    if (prompt.arguments && !Array.isArray(prompt.arguments)) {
      throw new Error(`prompt ${prompt.name}: arguments must be an array`);
    }
    if (this._prompts.has(prompt.name)) {
      throw new Error(`prompt ${prompt.name}: already registered`);
    }
    this._prompts.set(prompt.name, {
      name: prompt.name,
      description: prompt.description ?? '',
      arguments: prompt.arguments ?? [],
      render: prompt.render,
    });
    return this;
  }

  list() {
    return Array.from(this._prompts.values()).map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }

  has(name) {
    return this._prompts.has(name);
  }

  get(name) {
    return this._prompts.get(name) ?? null;
  }

  render(name, vars = {}) {
    const p = this._prompts.get(name);
    if (!p) throw new Error(`prompt not registered: ${name}`);
    for (const arg of p.arguments) {
      if (arg.required && !(arg.name in vars)) {
        throw new Error(`prompt ${name}: missing required argument '${arg.name}'`);
      }
    }
    const req = p.render(vars);
    if (!req?.messages || !Array.isArray(req.messages)) {
      throw new Error(`prompt ${name}: render() must return { messages: [...] }`);
    }
    return req;
  }
}

/**
 * Bundle of general-purpose prompt templates. Register into any PromptRegistry
 * with `registry.registerAll(builtInPrompts())`. Users can pick individual
 * ones with `registry.register(builtInPrompts().find(p => p.name === 'summarize'))`.
 */
function builtInPrompts() {
  return [
    {
      name: 'summarize',
      description: 'Summarize input text in a target number of sentences.',
      arguments: [
        { name: 'text',      description: 'Text to summarize',      required: true },
        { name: 'sentences', description: 'Target sentence count',  required: false },
      ],
      render: ({ text, sentences = 3 }) => ({
        system: `You are a concise summarizer. Reply in at most ${sentences} sentences.`,
        messages: [{ role: 'user', content: text }],
      }),
    },
    {
      name: 'extract_json',
      description: 'Extract structured JSON from unstructured text against a given JSON schema.',
      arguments: [
        { name: 'text',   description: 'Source text',                          required: true },
        { name: 'schema', description: 'JSON schema (object) for the output', required: true },
      ],
      render: ({ text, schema }) => ({
        system: 'Extract structured data. Reply ONLY with JSON conforming to the given schema.',
        messages: [{ role: 'user', content: `Text:\n${text}` }],
        format: typeof schema === 'string' ? JSON.parse(schema) : schema,
      }),
    },
    {
      name: 'classify',
      description: 'Classify input into one of a fixed set of labels.',
      arguments: [
        { name: 'text',   description: 'Text to classify',          required: true },
        { name: 'labels', description: 'Array of allowed labels',   required: true },
      ],
      render: ({ text, labels }) => {
        const arr = Array.isArray(labels) ? labels : String(labels).split(',').map(s => s.trim());
        return {
          system: `Classify the text into exactly ONE of: ${arr.join(', ')}. Reply with only the label.`,
          messages: [{ role: 'user', content: text }],
        };
      },
    },
    {
      name: 'translate',
      description: 'Translate text into a target language.',
      arguments: [
        { name: 'text',           description: 'Source text',                            required: true },
        { name: 'targetLanguage', description: 'Target language (e.g. "German", "de")', required: true },
      ],
      render: ({ text, targetLanguage }) => ({
        system: `Translate the user's text into ${targetLanguage}. Reply only with the translation — no commentary.`,
        messages: [{ role: 'user', content: text }],
      }),
    },
    {
      name: 'procurement_risk_scorer',
      description: 'Score procurement / contract text for risk (SAP-flavored built-in prompt for demos).',
      arguments: [
        { name: 'text', description: 'Contract or PO text', required: true },
      ],
      render: ({ text }) => ({
        system: 'You are an SAP procurement risk analyst. Rate the risk (low/medium/high) with a one-sentence rationale, then list 2-3 specific concerns tied to line items or clauses.',
        messages: [{ role: 'user', content: text }],
      }),
    },
  ];
}

PromptRegistry.prototype.registerAll = function (prompts) {
  for (const p of prompts) this.register(p);
  return this;
};

/**
 * Load every `*.mjs` and `*.js` file in a directory (non-recursive) and
 * register each exported template. Convention:
 *   - default export is a template               -> registered
 *   - default export is an array of templates    -> all registered
 *   - named exports that look like templates     -> registered
 * A "template" is any object with `name` and `render` fields.
 *
 * Returns a Promise resolving to { loaded, registered } counts. Rejects if
 * the directory doesn't exist (a common misconfiguration worth surfacing
 * loudly).
 */
PromptRegistry.prototype.loadFromDir = async function (dirPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const url = require('node:url');

  const abs = path.resolve(dirPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`prompts directory does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    throw new Error(`prompts path is not a directory: ${abs}`);
  }

  const files = fs.readdirSync(abs)
    .filter(f => f.endsWith('.mjs') || f.endsWith('.js'))
    .sort();

  let loaded = 0;
  let registered = 0;
  for (const file of files) {
    const filePath = path.join(abs, file);
    const mod = await import(url.pathToFileURL(filePath).href);
    loaded++;

    const candidates = [];
    if (mod.default) {
      if (Array.isArray(mod.default)) candidates.push(...mod.default);
      else candidates.push(mod.default);
    }
    for (const [key, value] of Object.entries(mod)) {
      if (key === 'default') continue;
      if (looksLikeTemplate(value)) candidates.push(value);
    }

    for (const c of candidates) {
      if (!looksLikeTemplate(c)) continue;
      this.register(c);
      registered++;
    }
  }

  return { loaded, registered };
};

function looksLikeTemplate(v) {
  return v && typeof v === 'object' && typeof v.name === 'string' && typeof v.render === 'function';
}

module.exports = { PromptRegistry, builtInPrompts };
