// Pre-flight cost estimator — token-counts a request and applies pricing
// to give a max-cost estimate WITHOUT hitting the provider. Zero network
// round-trip. Backs a "this call will cost $0.032 before you make it"
// pitch UX, and composes cleanly with `costBudget` for pre-flight budget
// checks:
//
//   const est = estimateCost({ model, messages, maxTokens: 500 });
//   if (est.estimatedUsd > perTenantRemaining) refuse(); else proceed();
//
// Uses the same tokenizer resolver as cost-predict (real tiktoken /
// js-tiktoken / @anthropic-ai/tokenizer when installed; heuristic
// fallback otherwise) and the same DEFAULT_PRICING table as
// usageMetering. Same model-family assumptions everywhere means the
// estimate matches the actual meter to within tokenizer variance.
//
// Signature:
//
//   const est = estimateCost({
//     model:      'gpt-4o-mini',
//     messages:   [{ role: 'user', content: 'Hello world' }],
//     system:     'You are helpful',   // optional; counted as input
//     maxTokens:  200,                  // upper bound on OUTPUT tokens
//     pricing:    DEFAULT_PRICING,     // optional override
//     currency:   'USD',                // display only
//     tokenizer:  null,                 // optional pre-loaded { countTokens }
//   });
//   // → {
//   //   model:           'gpt-4o-mini',
//   //   tokensIn:        14,
//   //   estMaxTokensOut: 200,
//   //   inputUsd:        0.0000021,
//   //   outputUsd:       0.00012,
//   //   estimatedUsd:    0.000122,
//   //   currency:        'USD',
//   //   priced:          true,
//   //   tokenizerUsed:   'tiktoken',
//   //   notes:           ['skipped 1 non-text content block(s)'],
//   // }

const { getTokenizer } = require('./tokenizer');
const { DEFAULT_PRICING } = require('./pricing');

// Rough per-role token overheads observed across providers — these are
// the frame tokens ("<|im_start|>", "<|user|>", etc.) that wrap each
// message in the chat-completion format. Not exact per-provider but
// close enough for a pre-flight estimate.
const PER_MESSAGE_FRAME_TOKENS = 4;
const PER_REPLY_FRAME_TOKENS   = 3;

function estimateCost(options = {}) {
  const {
    model,
    messages   = [],
    system     = null,
    maxTokens  = 512,
    pricing    = DEFAULT_PRICING,
    currency   = 'USD',
    tokenizer  = null,
  } = options;

  if (!model) throw new Error('estimateCost: model is required.');
  if (!Array.isArray(messages)) throw new Error('estimateCost: messages must be an array.');
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new Error(`estimateCost: maxTokens must be a non-negative number (got ${maxTokens}).`);
  }

  const tok = tokenizer ?? getTokenizer(model);
  const notes = [];

  let tokensIn = 0;
  let skippedBlocks = 0;

  if (system) {
    tokensIn += tok.countTokens(String(system));
    tokensIn += PER_MESSAGE_FRAME_TOKENS;
  }

  for (const m of messages) {
    if (!m) continue;
    tokensIn += PER_MESSAGE_FRAME_TOKENS;
    if (typeof m.content === 'string') {
      tokensIn += tok.countTokens(m.content);
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          tokensIn += tok.countTokens(block.text);
        } else {
          // image / document / audio / tool_result etc. — we don't try to
          // count these at the token level. Callers relying on accurate
          // vision / PDF cost estimates should refine per-provider.
          skippedBlocks++;
        }
      }
    }
  }
  tokensIn += PER_REPLY_FRAME_TOKENS;

  if (skippedBlocks > 0) {
    notes.push(`skipped ${skippedBlocks} non-text content block(s) — vision / PDF / audio tokens not counted`);
  }

  const priceEntry = pricing?.[model];
  const priced = !!priceEntry;
  let inputUsd = 0;
  let outputUsd = 0;
  if (priced) {
    // Pricing is USD per 1M tokens
    inputUsd  = (tokensIn  / 1_000_000) * (priceEntry.input  ?? 0);
    outputUsd = (maxTokens / 1_000_000) * (priceEntry.output ?? 0);
  } else {
    notes.push(`model '${model}' not in pricing table — estimatedUsd reported as 0`);
  }

  return {
    model,
    tokensIn,
    estMaxTokensOut: maxTokens,
    inputUsd,
    outputUsd,
    estimatedUsd: inputUsd + outputUsd,
    currency,
    priced,
    tokenizerUsed: tok.name ?? 'unknown',
    notes,
  };
}

module.exports = { estimateCost };
