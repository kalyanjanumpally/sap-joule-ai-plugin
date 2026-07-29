async function embed(ctx) {
  const prompt = await ctx.readInput(ctx);
  if (!prompt) {
    ctx.stderr.write("no input supplied (use --prompt, --file, stdin, or a positional arg)\n");
    return 2;
  }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();

  if (typeof provider.embed !== 'function' || provider.constructor.name === 'AnthropicLLMService') {
    ctx.stderr.write(`error: ${provider.constructor.name} does not support embed()\n`);
    return 1;
  }

  const inputs = prompt.split('\n---\n').map(s => s.trim()).filter(Boolean);
  const res = await provider.embed({ input: inputs.length === 1 ? inputs[0] : inputs });

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify({
      model: res.model,
      count: res.embeddings.length,
      dimension: res.embeddings[0]?.length,
      embeddings: res.embeddings,
    }, null, 2) + '\n');
  } else {
    ctx.stdout.write(`model: ${res.model ?? '(unknown)'}\n`);
    ctx.stdout.write(`count: ${res.embeddings.length}\n`);
    ctx.stdout.write(`dimension: ${res.embeddings[0]?.length ?? 0}\n`);
    for (const [i, vec] of res.embeddings.entries()) {
      const preview = vec.slice(0, 6).map(v => v.toFixed(4)).join(', ');
      ctx.stdout.write(`  [${i}] ${preview}${vec.length > 6 ? ', …' : ''}\n`);
    }
  }
  return 0;
}

embed.help = `saptarishi-llm embed — embed input text(s) into vectors

Split multiple inputs with a line containing '---'.

examples:
  saptarishi-llm embed -p "purchase order for steel coils"
  printf "one\\n---\\ntwo\\n---\\nthree" | saptarishi-llm embed --provider ollama
  saptarishi-llm embed --json -p "sample" > embeddings.json`;

module.exports = embed;
