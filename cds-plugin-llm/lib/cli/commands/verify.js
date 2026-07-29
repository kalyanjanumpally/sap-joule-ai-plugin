async function verify(ctx) {
  const start = Date.now();
  const { provider, kind, model } = await ctx.buildProvider(ctx);
  await provider.init();

  ctx.stderr.write(`→ provider: ${kind}\n`);
  ctx.stderr.write(`→ model:    ${model}\n`);
  ctx.stderr.write(`→ sending tiny probe...\n`);

  const res = await provider.chat({
    messages: [{ role: 'user', content: 'reply with a single word: ok' }],
    maxTokens: 32,
  });

  const elapsedMs = Date.now() - start;
  const ok = /ok/i.test(res.text ?? '');

  const summary = {
    provider: kind,
    model: res.model ?? model,
    ok,
    latencyMs: elapsedMs,
    text: res.text?.trim().slice(0, 200) ?? '',
    usage: res.usage,
  };

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    ctx.stdout.write(`\n${ok ? '✓' : '✗'} ${kind} responded in ${elapsedMs}ms\n`);
    ctx.stdout.write(`  model:  ${summary.model}\n`);
    ctx.stdout.write(`  reply:  ${summary.text}\n`);
    if (res.usage?.input_tokens != null) {
      ctx.stdout.write(`  tokens: ${res.usage.input_tokens} in / ${res.usage.output_tokens ?? '?'} out\n`);
    }
  }
  return ok ? 0 : 1;
}

verify.help = `saptarishi-llm verify — sanity-check provider config

Connects, runs a tiny chat probe, reports latency + reply. Useful for
verifying credentials, network reachability, and endpoint configuration.

examples:
  saptarishi-llm verify --provider anthropic
  saptarishi-llm verify --provider ollama --base-url http://192.168.5.13:11434
  saptarishi-llm verify --provider groq --json`;

module.exports = verify;
