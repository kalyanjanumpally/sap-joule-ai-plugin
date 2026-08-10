// Prompt template linter. Catches common issues in system prompts
// and templates before they land in production: missing / stale
// variable substitutions, mixed indentation, injection patterns
// inside the system prompt itself, forbidden phrases from a
// checklist, overly long prompts.
//
// Companion to promptRegression (1.89) — the linter catches
// TEMPLATE issues (static analysis), the regression detector
// catches BEHAVIORAL drift (dynamic scoring).
//
//   const { lintPrompt } = require('@saptarishi/cds-plugin-llm');
//
//   const report = lintPrompt(text, {
//     variables: { poId: 'PO-42', supplier: 'Acme' },
//     maxTokens: 2000,
//     forbidden: ['ignore previous', 'act as'],
//   });
//   // {
//   //   ok: false,
//   //   errors:   [{ code, line, col, message, fixit }],
//   //   warnings: [{ code, line, col, message, fixit }],
//   //   info:     [...],
//   //   stats:    { chars, lines, tokens, variablesUsed, ... },
//   // }
//
// Rule codes are stable; each rule can be suppressed via
// `ignore: ['MISSING_VAR', 'MIXED_INDENT']`.

const KNOWN_RULES = new Set([
  'MISSING_VAR', 'UNUSED_VAR', 'MALFORMED_VAR',
  'MIXED_INDENT', 'TRAILING_WHITESPACE',
  'INJECTION_PATTERN', 'ROLE_MARKER',
  'FORBIDDEN_PHRASE',
  'TOO_LONG', 'EMPTY',
  'DUPLICATE_LINE',
]);

const DEFAULT_INJECTION_PATTERNS = [
  { re: /ignore\s+(all\s+)?previous\s+(instructions|prompts)/i, name: 'ignore-previous' },
  { re: /disregard\s+(all\s+)?(instructions|prompts)/i,         name: 'disregard-previous' },
  { re: /you\s+are\s+now\s+(a\s+)?(different|jailbroken)/i,     name: 'role-swap' },
  { re: /system\s*:\s*\S/i,                                     name: 'inline-system' },
  { re: /\<\|(im_start|im_end|start_header_id|end_header_id)\|\>/i, name: 'chat-template-token' },
];

const ROLE_MARKERS = ['assistant:', 'user:', 'human:', 'system:'];

/**
 * Lint a single prompt template string. Options:
 *   - variables:       { key: value } — reports MISSING_VAR / UNUSED_VAR
 *   - maxTokens:       int — reports TOO_LONG (approx chars/4)
 *   - forbidden:       string[] — reports FORBIDDEN_PHRASE (case-insensitive)
 *   - injectionPatterns: [{re, name}] — override default set
 *   - ignore:          rule-code[] — suppress those rules
 *   - noDuplicateLines: boolean — reports DUPLICATE_LINE
 */
function lintPrompt(text, options = {}) {
  if (typeof text !== 'string') {
    throw new Error('lintPrompt: text must be a string.');
  }
  const {
    variables         = null,
    maxTokens         = null,
    forbidden         = [],
    injectionPatterns = DEFAULT_INJECTION_PATTERNS,
    ignore            = [],
    noDuplicateLines  = false,
  } = options;
  if (variables != null && (typeof variables !== 'object' || Array.isArray(variables))) {
    throw new Error('lintPrompt: variables must be an object.');
  }
  if (!Array.isArray(forbidden)) {
    throw new Error('lintPrompt: forbidden must be an array.');
  }
  if (!Array.isArray(ignore)) {
    throw new Error('lintPrompt: ignore must be an array.');
  }

  const suppressed = new Set(ignore);
  const errors   = [];
  const warnings = [];
  const info     = [];

  function emit(list, code, line, col, message, fixit) {
    if (suppressed.has(code)) return;
    list.push({ code, line, col, message, fixit });
  }
  const err  = (c, l, o, m, f) => emit(errors, c, l, o, m, f);
  const warn = (c, l, o, m, f) => emit(warnings, c, l, o, m, f);
  const inf  = (c, l, o, m, f) => emit(info, c, l, o, m, f);

  const lines = text.split('\n');
  const chars = text.length;
  const tokens = Math.ceil(chars / 4);

  // ---- Empty / minimum-length checks -----------------------------------
  if (text.trim().length === 0) {
    err('EMPTY', 1, 1, 'Prompt is empty.', 'Provide a non-empty template.');
  }

  // ---- Length ---------------------------------------------------------
  if (maxTokens != null && tokens > maxTokens) {
    warn('TOO_LONG', 1, 1,
      `Prompt is ~${tokens} tokens (limit ${maxTokens}).`,
      'Trim rules or move examples out of the system prompt.');
  }

  // ---- Variable substitution --------------------------------------------
  // Match {{name}} or {{ name }}; capture position for offset reporting.
  const varRefs = new Set();
  const varRefRegex = /\{\{\s*([\w.]+)\s*\}\}/g;
  const malformedRegex = /\{\{[^{}]*\}\}/g;

  lines.forEach((raw, li) => {
    let m;
    // Find well-formed refs.
    const wellFormed = [];
    varRefRegex.lastIndex = 0;
    while ((m = varRefRegex.exec(raw)) != null) {
      wellFormed.push({ name: m[1], start: m.index, end: m.index + m[0].length });
      varRefs.add(m[1]);
    }
    // Find any {{...}} — those NOT covered by wellFormed are malformed.
    malformedRegex.lastIndex = 0;
    while ((m = malformedRegex.exec(raw)) != null) {
      const covered = wellFormed.some((w) => w.start === m.index && w.end === m.index + m[0].length);
      if (!covered) {
        err('MALFORMED_VAR', li + 1, m.index + 1,
          `Malformed variable expression: ${m[0]}`,
          'Use {{name}} with alphanumeric/underscore/dot characters only.');
      }
    }
  });

  if (variables) {
    const declared = new Set(Object.keys(variables));
    for (const name of varRefs) {
      if (!declared.has(name)) {
        // Locate first occurrence for reporting.
        const idx = text.indexOf(`{{${name}`);
        const { line, col } = idx >= 0 ? posOf(text, idx) : { line: 1, col: 1 };
        err('MISSING_VAR', line, col,
          `Variable {{${name}}} is used but not provided.`,
          `Add '${name}' to variables or remove the reference.`);
      }
    }
    for (const name of declared) {
      if (!varRefs.has(name)) {
        inf('UNUSED_VAR', 1, 1,
          `Variable '${name}' is provided but not referenced by the template.`,
          `Reference {{${name}}} or drop it from variables.`);
      }
    }
  }

  // ---- Injection patterns in the system prompt ------------------------
  lines.forEach((raw, li) => {
    for (const p of injectionPatterns) {
      const m = raw.match(p.re);
      if (m) {
        err('INJECTION_PATTERN', li + 1, (m.index ?? 0) + 1,
          `Prompt contains an injection-like pattern (${p.name}): '${m[0]}'.`,
          'Reformulate the instruction so it doesn\'t look like a jailbreak.');
      }
    }
    // Role markers embedded in prose (e.g., "as an assistant: ..." leaks a role frame).
    const lower = raw.toLowerCase();
    for (const marker of ROLE_MARKERS) {
      const idx = lower.indexOf(marker);
      if (idx !== -1 && (idx === 0 || !isAlpha(lower[idx - 1]))) {
        warn('ROLE_MARKER', li + 1, idx + 1,
          `Line contains a role marker '${marker}' — may confuse the LLM's turn boundaries.`,
          'Rephrase without a role prefix.');
        break;
      }
    }
  });

  // ---- Forbidden phrase list ------------------------------------------
  for (const phrase of forbidden) {
    if (typeof phrase !== 'string' || phrase.length === 0) continue;
    const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (idx !== -1) {
      const { line, col } = posOf(text, idx);
      warn('FORBIDDEN_PHRASE', line, col,
        `Forbidden phrase detected: '${phrase}'.`,
        'Remove the phrase or add to `ignore`.');
    }
  }

  // ---- Indentation + trailing whitespace ------------------------------
  let seenTabIndent = false;
  let seenSpaceIndent = false;
  lines.forEach((raw, li) => {
    if (/^\t/.test(raw)) seenTabIndent = true;
    if (/^ {2,}/.test(raw)) seenSpaceIndent = true;
    if (/[ \t]+$/.test(raw)) {
      warn('TRAILING_WHITESPACE', li + 1, raw.length,
        'Line ends with trailing whitespace.',
        'Remove trailing spaces/tabs.');
    }
  });
  if (seenTabIndent && seenSpaceIndent) {
    warn('MIXED_INDENT', 1, 1,
      'Both tab-indented and space-indented lines are present.',
      'Pick one style (spaces recommended).');
  }

  // ---- Duplicate lines ------------------------------------------------
  if (noDuplicateLines) {
    const seen = new Map();
    lines.forEach((raw, li) => {
      const t = raw.trim();
      if (t.length === 0) return;
      const prev = seen.get(t);
      if (prev !== undefined) {
        warn('DUPLICATE_LINE', li + 1, 1,
          `Line is a duplicate of line ${prev + 1}.`,
          'Remove one of the duplicates.');
      } else {
        seen.set(t, li);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info,
    stats: {
      chars,
      lines: lines.length,
      tokens,
      variablesUsed: [...varRefs],
      variablesDeclared: variables ? Object.keys(variables) : [],
    },
  };
}

// ---- Helpers ---------------------------------------------------------

function isAlpha(c) {
  if (!c) return false;
  return /[a-zA-Z]/.test(c);
}

function posOf(text, idx) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '\n') { line++; col = 1; }
    else col++;
  }
  return { line, col };
}

// ---- Batch API + report formatter -----------------------------------

/**
 * Lint an object of { name: text } prompts (e.g., from a prompt registry).
 * Returns { ok, byName, summary }.
 */
function lintPrompts(prompts, options = {}) {
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new Error('lintPrompts: prompts must be a { name: text } object.');
  }
  const byName = {};
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const [name, text] of Object.entries(prompts)) {
    const r = lintPrompt(text, options);
    byName[name] = r;
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;
  }
  return {
    ok: totalErrors === 0,
    byName,
    summary: {
      promptCount: Object.keys(prompts).length,
      totalErrors,
      totalWarnings,
    },
  };
}

function formatLintReport(report, { colors = false } = {}) {
  const c = colors
    ? { red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', reset: '\x1b[0m', dim: '\x1b[2m' }
    : { red: '', yellow: '', blue: '', reset: '', dim: '' };
  const lines = [];
  const isBatch = 'byName' in report;
  const iter = isBatch ? Object.entries(report.byName) : [['(inline)', report]];
  for (const [name, r] of iter) {
    if (r.errors.length === 0 && r.warnings.length === 0 && r.info.length === 0) continue;
    lines.push(`${c.blue}${name}${c.reset}  ${c.dim}(${r.stats.lines} lines, ~${r.stats.tokens} tokens)${c.reset}`);
    for (const e of r.errors) {
      lines.push(`  ${c.red}error${c.reset} ${e.line}:${e.col} [${e.code}] ${e.message}`);
      if (e.fixit) lines.push(`    ${c.dim}fix:${c.reset} ${e.fixit}`);
    }
    for (const w of r.warnings) {
      lines.push(`  ${c.yellow}warn${c.reset}  ${w.line}:${w.col} [${w.code}] ${w.message}`);
    }
    for (const i of r.info) {
      lines.push(`  ${c.dim}info${c.reset}  [${i.code}] ${i.message}`);
    }
    lines.push('');
  }
  if (isBatch) {
    lines.push(`summary: ${report.summary.promptCount} prompts, ${report.summary.totalErrors} errors, ${report.summary.totalWarnings} warnings`);
  }
  return lines.join('\n');
}

module.exports = {
  lintPrompt,
  lintPrompts,
  formatLintReport,
  KNOWN_RULES,
  DEFAULT_INJECTION_PATTERNS,
};
