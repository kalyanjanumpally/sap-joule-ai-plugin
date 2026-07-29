async function stream(ctx) {
  const prompt = await ctx.readInput(ctx);
  if (!prompt) {
    ctx.stderr.write("no prompt supplied (use --prompt, --file, stdin, or a positional arg)\n");
    return 2;
  }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();

  const req = {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: ctx.opts['max-tokens'] ? parseInt(ctx.opts['max-tokens'], 10) : 1024,
  };
  if (ctx.opts.system) req.system = ctx.opts.system;

  let final;
  for await (const chunk of provider.stream(req)) {
    if (chunk.type === 'text_delta') {
      if (!ctx.opts.json) ctx.stdout.write(chunk.text);
    } else if (chunk.type === 'done') {
      final = chunk;
    }
  }

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify({
      text: final?.text,
      model: final?.model,
      usage: final?.usage,
      stopReason: final?.stopReason,
    }, null, 2) + '\n');
  } else {
    ctx.stdout.write('\n');
  }
  return 0;
}

stream.help = `saptarishi-llm stream — stream tokens to stdout as they arrive

usage: saptarishi-llm stream [--prompt <text> | --file <path> | -]

examples:
  saptarishi-llm stream -p "write a haiku about SAP CAP"
  saptarishi-llm stream --provider groq -p "analyze this contract" -f contract.txt`;

module.exports = stream;
