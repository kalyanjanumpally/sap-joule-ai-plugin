async function chat(ctx) {
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

  const res = await provider.chat(req);

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify({
      text: res.text,
      model: res.model,
      usage: res.usage,
      stopReason: res.stopReason,
      cached: res.cached ?? false,
    }, null, 2) + '\n');
  } else {
    ctx.stdout.write(res.text + '\n');
  }
  return 0;
}

chat.help = `saptarishi-llm chat — send a prompt, print the response

usage:
  saptarishi-llm chat [--prompt <text> | --file <path> | -]

options:
  --provider, --model, --max-tokens, --system, --json  (see 'saptarishi-llm help')

examples:
  saptarishi-llm chat -p "hello"
  echo "summarize this" | saptarishi-llm chat -f report.txt
  saptarishi-llm chat --json -p "list 3 SAP procurement KPIs"`;

module.exports = chat;
