// Prompt regression detector. Given a folder of fixture files
// (or an array of in-memory fixtures), runs each prompt through
// the LLM, uses llmJudge (1.84) to score against criteria, and
// aggregates a pass/fail report. Fails CI when a prompt tweak
// regresses N% of fixtures.
//
// Companion to llmJudge: llmJudge is the primitive; this is the
// batch harness that makes it a CI eval loop.
//
//   const { promptRegression, loadFixtures } = require('@saptarishi/cds-plugin-llm');
//
//   const report = await promptRegression({
//     llm,                             // service under test
//     fixtures: loadFixtures('./test/fixtures'),
//     judgeLlm:   strongLlm,           // often a more capable model
//     judgeModel: 'claude-opus-4-7',
//     concurrency: 5,
//     onProgress: (info) => console.log(info.name, info.verdict),
//   });
//
//   //  {
//   //    total, passed, failed, errors, passRate,
//   //    results: [{ name, verdict, score, criteriaResults, ... }],
//   //  }
//
//   if (report.passRate < 0.9) throw new Error(`regression: ${report.failed}/${report.total} failed`);
//
// Fixture shape (JSON files or in-memory objects):
//   {
//     "name":     "extract invoice line items",       // display name (default: file basename)
//     "request": {                                    // sent to llm.chat()
//       "system":   "...",
//       "messages": [...],
//       "maxTokens": 500,
//       "format":   { ... optional }
//     },
//     "criteria": "answer must cite an invoice number" | [{ name, description, weight? }],
//     "context":   "Optional ground truth for the judge to cross-check",
//     "threshold": 0.7                                 // default 0.7
//   }

const fs = require('node:fs');
const path = require('node:path');
const { llmJudge } = require('./llmJudge');

// ---- Fixture loader ---------------------------------------------------

/**
 * Read every .json file in `dir`, parse, tag each with .name (from filename
 * if not present) + .path. Non-JSON files are silently skipped.
 */
function loadFixtures(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('loadFixtures: dir must be a non-empty string.');
  }
  if (!fs.existsSync(dir)) {
    throw new Error(`loadFixtures: directory not found: ${dir}`);
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`loadFixtures: not a directory: ${dir}`);
  }
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const p = path.join(dir, entry);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`loadFixtures: ${p}: ${e.message}`);
    }
    if (!data || typeof data !== 'object') {
      throw new Error(`loadFixtures: ${p}: not an object`);
    }
    if (!data.name) data.name = path.basename(entry, '.json');
    data.path = p;
    out.push(data);
  }
  // Deterministic order regardless of filesystem enumeration.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- Fixture validation ----------------------------------------------

function validateFixture(fx, idx) {
  const where = `fixture[${idx}]${fx?.name ? ` (${fx.name})` : ''}`;
  if (!fx || typeof fx !== 'object') throw new Error(`${where}: not an object`);
  if (!fx.request || typeof fx.request !== 'object') {
    throw new Error(`${where}: missing request object`);
  }
  if (!Array.isArray(fx.request.messages) || fx.request.messages.length === 0) {
    throw new Error(`${where}: request.messages must be a non-empty array`);
  }
  if (fx.criteria == null) {
    throw new Error(`${where}: missing criteria`);
  }
  if (fx.threshold != null && (!Number.isFinite(fx.threshold) || fx.threshold < 0 || fx.threshold > 1)) {
    throw new Error(`${where}: threshold must be a number in [0, 1]`);
  }
}

// ---- Main runner -----------------------------------------------------

async function promptRegression(options = {}) {
  const {
    llm,
    chat: chatFn,
    fixtures,
    judgeLlm,
    judgeChat,
    judgeModel,
    judgeSystem,
    judgeTemperature,
    concurrency  = 5,
    onProgress   = null,
    defaultThreshold = 0.7,
  } = options;

  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('promptRegression: fixtures must be a non-empty array.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('promptRegression: concurrency must be a positive integer.');
  }
  if (onProgress != null && typeof onProgress !== 'function') {
    throw new Error('promptRegression: onProgress must be a function.');
  }

  const chat = chatFn ?? (llm && typeof llm.chat === 'function' ? llm.chat.bind(llm) : null);
  if (typeof chat !== 'function') {
    throw new Error('promptRegression: pass either { llm } (LLMService) or { chat } (function).');
  }
  // Judge can reuse the same llm/chat if not provided separately.
  const judgeArg = judgeChat ? { chat: judgeChat } : judgeLlm ? { llm: judgeLlm } : { chat };

  // Validate upfront so a fixture file typo fails fast, not halfway through.
  fixtures.forEach(validateFixture);

  const results = new Array(fixtures.length);
  let cursor = 0;

  async function runOne(i) {
    const fx = fixtures[i];
    const started = Date.now();
    try {
      const response = await chat(fx.request);
      const responseText = response?.text ?? '';
      if (!responseText) {
        results[i] = {
          name:     fx.name,
          verdict:  'error',
          score:    0,
          error:    'llm response had no text field',
          durationMs: Date.now() - started,
        };
        return;
      }
      const judgeResult = await llmJudge({
        ...judgeArg,
        criteria: fx.criteria,
        response: responseText,
        context:  fx.context,
        threshold: fx.threshold ?? defaultThreshold,
        judgeModel,
        judgeSystem,
        judgeTemperature,
      });
      results[i] = {
        name:             fx.name,
        verdict:          judgeResult.verdict,
        score:            judgeResult.score,
        criteriaResults:  judgeResult.criteriaResults,
        overallRationale: judgeResult.overallRationale,
        response:         responseText,
        durationMs:       Date.now() - started,
      };
    } catch (err) {
      results[i] = {
        name:       fx.name,
        verdict:    'error',
        score:      0,
        error:      err.message,
        durationMs: Date.now() - started,
      };
    } finally {
      if (onProgress) {
        try { await onProgress({ ...results[i], index: i, total: fixtures.length }); }
        catch { /* swallow */ }
      }
    }
  }

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= fixtures.length) return;
      await runOne(i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, fixtures.length) }, worker);
  await Promise.all(workers);

  const passed = results.filter((r) => r.verdict === 'pass').length;
  const failed = results.filter((r) => r.verdict === 'fail').length;
  const errors = results.filter((r) => r.verdict === 'error').length;

  return {
    total:    results.length,
    passed,
    failed,
    errors,
    passRate: results.length > 0 ? passed / results.length : 0,
    results,
  };
}

// ---- Report formatter (human-readable) -------------------------------

function formatReport(report, { colors = false } = {}) {
  const c = colors
    ? { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m', dim: '\x1b[2m' }
    : { green: '', red: '', yellow: '', reset: '', dim: '' };
  const marker = (verdict) => {
    if (verdict === 'pass')  return `${c.green}✓${c.reset}`;
    if (verdict === 'fail')  return `${c.red}✗${c.reset}`;
    return `${c.yellow}!${c.reset}`;
  };

  const lines = [];
  for (const r of report.results) {
    lines.push(`  ${marker(r.verdict)} ${r.name}  ${c.dim}(score=${r.score.toFixed(2)}, ${r.durationMs}ms)${c.reset}`);
    if (r.verdict === 'error') lines.push(`     ${c.red}error:${c.reset} ${r.error}`);
    if (r.verdict === 'fail' && Array.isArray(r.criteriaResults)) {
      for (const cr of r.criteriaResults) {
        if (!cr.passed) {
          lines.push(`     ${c.red}✗${c.reset} ${cr.name}: ${cr.rationale}`);
        }
      }
    }
  }

  const passStr = report.passed > 0 ? `${c.green}${report.passed} passed${c.reset}` : `${report.passed} passed`;
  const failStr = report.failed > 0 ? `${c.red}${report.failed} failed${c.reset}` : `${report.failed} failed`;
  const errStr  = report.errors > 0 ? `${c.yellow}${report.errors} errors${c.reset}` : `${report.errors} errors`;
  lines.push('');
  lines.push(`summary: ${passStr}, ${failStr}, ${errStr}  (pass rate: ${(report.passRate * 100).toFixed(1)}%)`);
  return lines.join('\n');
}

module.exports = {
  promptRegression,
  loadFixtures,
  formatReport,
  // Exposed for tests + composition.
  validateFixture,
};
