// Compact-history middleware. When a request's messages[] exceeds
// N turns, summarizes the OLDEST portion via an LLM call and
// replaces those messages with a compact synthetic exchange —
// keeping the most recent K messages verbatim.
//
// Purpose: bounded context spend on long-running agent
// conversations without losing key facts from the early turns.
//
//   const { compactHistory } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(compactHistory({
//     maxMessages: 20,
//     keepRecent:  6,
//     llm,                          // used by the default summarizer
//     summaryModel: 'claude-haiku-4-5',   // cheap+fast; overrides ctx.request.model
//     summaryMaxTokens: 500,
//   }));
//
//   // A 40-turn conversation → the oldest 34 messages get summarized
//   // into 1 pair (user "please summarize what came before" +
//   // assistant "[EARLIER CONVERSATION SUMMARY] ..."), then the
//   // recent 6 messages appended verbatim → 8 total turns sent to provider.
//
// Non-destructive: mutates ctx.request.messages for the inner
// next() call only, restores original in a finally block.

const DEFAULT_SUMMARY_SYSTEM = `You compress a conversation history for a downstream agent.
Rules:
- Preserve every concrete fact, decision, name, ID, number, date, and outcome.
- Preserve the current task the assistant was working on.
- Drop conversational filler, apologies, small-talk.
- Format: bullet points, ≤ 300 words. No preamble.`;

const DEFAULT_SUMMARY_PROMPT = 'Summarize the following conversation history so a fresh assistant can continue seamlessly:\n\n';
const DEFAULT_SUMMARY_PREFIX = '[EARLIER CONVERSATION SUMMARY]';

function compactHistory(options = {}) {
  const {
    maxMessages     = 20,
    keepRecent      = 6,
    summarizer      = null,
    llm             = null,
    chat: chatFn    = null,
    summaryModel    = null,
    summarySystem   = DEFAULT_SUMMARY_SYSTEM,
    summaryPrompt   = DEFAULT_SUMMARY_PROMPT,
    summaryPrefix   = DEFAULT_SUMMARY_PREFIX,
    summaryMaxTokens = 500,
    skipMethods     = ['embed', 'stream'],
    onCompact       = null,
    onError         = null,
  } = options;

  if (!Number.isInteger(maxMessages) || maxMessages < 2) {
    throw new Error(`compactHistory: maxMessages must be an integer >= 2 (got ${maxMessages}).`);
  }
  if (!Number.isInteger(keepRecent) || keepRecent < 1) {
    throw new Error(`compactHistory: keepRecent must be a positive integer (got ${keepRecent}).`);
  }
  if (keepRecent >= maxMessages) {
    throw new Error(`compactHistory: keepRecent (${keepRecent}) must be < maxMessages (${maxMessages}).`);
  }
  if (summarizer != null && typeof summarizer !== 'function') {
    throw new Error('compactHistory: summarizer must be a function or null.');
  }
  if (onCompact != null && typeof onCompact !== 'function') {
    throw new Error('compactHistory: onCompact must be a function.');
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('compactHistory: skipMethods must be an array.');
  }

  const skipSet = new Set(skipMethods);
  const summaryChat = chatFn ?? (llm && typeof llm.chat === 'function' ? llm.chat.bind(llm) : null);

  const stats = {
    totalRequests:      0,
    compacted:          0,
    skipped:            0,
    summarizerErrors:   0,
    totalMessagesRemoved: 0,
    totalMessagesReplacedWith: 0,   // always 2 per compaction (synthetic pair)
  };

  async function defaultSummarize(oldMessages, ctx) {
    if (!summaryChat) {
      throw new Error('compactHistory: no summarizer provided and no llm/chat handle for the default summarizer.');
    }
    const dumped = oldMessages.map((m) => {
      const role = m?.role ?? '?';
      const content = typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
          : JSON.stringify(m?.content ?? '');
      return `[${role}] ${content}`;
    }).join('\n\n');

    const res = await summaryChat({
      system: summarySystem,
      messages: [{ role: 'user', content: `${summaryPrompt}${dumped}` }],
      maxTokens: summaryMaxTokens,
      ...(summaryModel ? { model: summaryModel } : {}),
    });
    return res?.text ?? '';
  }

  function buildCompacted(summary, keptMessages) {
    // Two synthetic turns preserve provider role-alternation invariants
    // regardless of what role the first kept message has.
    return [
      { role: 'user',      content: 'Please summarize what has been discussed so far.' },
      { role: 'assistant', content: `${summaryPrefix}\n${summary}` },
      ...keptMessages,
    ];
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (skipSet.has(ctx?.method)) { stats.skipped++; return next(); }
    const messages = ctx?.request?.messages;
    if (!Array.isArray(messages) || messages.length <= maxMessages) {
      stats.skipped++;
      return next();
    }

    const cutoff = messages.length - keepRecent;
    const oldMessages = messages.slice(0, cutoff);
    const keptMessages = messages.slice(cutoff);

    let summary;
    try {
      summary = summarizer
        ? await summarizer(oldMessages, ctx)
        : await defaultSummarize(oldMessages, ctx);
    } catch (err) {
      stats.summarizerErrors++;
      if (onError) {
        try { onError({ err, method: ctx.method, oldMessagesCount: oldMessages.length }); }
        catch { /* swallow */ }
      }
      // Soft-fail: pass the full request through untouched rather than
      // dropping the call entirely.
      return next();
    }
    if (typeof summary !== 'string' || summary.length === 0) {
      stats.summarizerErrors++;
      return next();
    }

    const compacted = buildCompacted(summary, keptMessages);
    stats.compacted++;
    stats.totalMessagesRemoved += oldMessages.length;
    stats.totalMessagesReplacedWith += 2;

    if (onCompact) {
      try {
        onCompact({
          method:            ctx.method,
          originalCount:     messages.length,
          removedCount:      oldMessages.length,
          keptCount:         keptMessages.length,
          summaryChars:      summary.length,
          finalCount:        compacted.length,
        });
      } catch { /* swallow */ }
    }

    const original = ctx.request;
    ctx.request = { ...original, messages: compacted };
    try {
      return await next();
    } finally {
      ctx.request = original;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.compacted = stats.skipped = 0;
    stats.summarizerErrors = stats.totalMessagesRemoved = stats.totalMessagesReplacedWith = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://compact-history',
    name: 'Compact-history middleware',
    description: 'Summarizes old messages when conversation history exceeds maxMessages. Counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      maxMessages,
      keepRecent,
      summaryModel,
      summaryMaxTokens,
      hasCustomSummarizer: typeof summarizer === 'function',
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  compactHistory,
  DEFAULT_SUMMARY_SYSTEM,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_PREFIX,
};
