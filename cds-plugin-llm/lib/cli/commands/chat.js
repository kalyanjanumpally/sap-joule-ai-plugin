const readline = require('node:readline');
const fs = require('node:fs');

// ---- One-shot chat (unchanged from 0.1) --------------------------------

async function chat(ctx) {
  if (ctx.opts.interactive || ctx.opts.i) {
    return chatRepl(ctx);
  }

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

// ---- Interactive REPL (new in 1.86.0) ----------------------------------

const REPL_HELP = `commands:
  .system [<text>]   show or set the system prompt
  .model <id>        switch model for the next turn onward
  .clear             clear the conversation history (keeps system prompt)
  .save <file>       save conversation to JSON file
  .load <file>       load conversation from JSON file (replaces current)
  .history           print message count + last user turn
  .help, .?          show this help
  .exit, .quit       exit the REPL (Ctrl+D also works)

any line NOT starting with '.' is sent as a user message to the LLM.`;

/** Parse a slash command line into { command, args } — null if not a slash command. */
function parseSlashCommand(line) {
  if (typeof line !== 'string' || !line.startsWith('.')) return null;
  const body = line.slice(1).trim();
  if (!body) return { command: '', args: '' };
  const spaceIdx = body.indexOf(' ');
  if (spaceIdx === -1) return { command: body.toLowerCase(), args: '' };
  return { command: body.slice(0, spaceIdx).toLowerCase(), args: body.slice(spaceIdx + 1).trim() };
}

/**
 * Apply a slash command to a mutable state object.
 * Returns 'exit' | 'ok' | 'unknown' | 'error' with an optional message
 * written to stdout/stderr via the ctx-like `io` param ({stdout,stderr}).
 * Factored out so the REPL loop stays thin and this piece is unit-testable.
 */
function handleSlashCommand({ command, args }, state, io) {
  switch (command) {
    case 'exit':
    case 'quit':
    case 'q':
      io.stdout.write('bye.\n');
      return 'exit';
    case 'help':
    case '?':
      io.stdout.write(REPL_HELP + '\n');
      return 'ok';
    case 'system':
      if (!args) {
        io.stdout.write(state.system ? `system: ${state.system}\n` : '(no system prompt set)\n');
      } else {
        state.system = args;
        io.stdout.write(`system prompt updated (${args.length} chars).\n`);
      }
      return 'ok';
    case 'model':
      if (!args) {
        io.stdout.write(`model: ${state.model ?? '(provider default)'}\n`);
      } else {
        state.model = args;
        io.stdout.write(`model → ${args}\n`);
      }
      return 'ok';
    case 'clear':
      state.messages.length = 0;
      io.stdout.write('history cleared.\n');
      return 'ok';
    case 'history':
      if (state.messages.length === 0) {
        io.stdout.write('(empty)\n');
      } else {
        const last = state.messages[state.messages.length - 1];
        io.stdout.write(`${state.messages.length} message(s). last (${last.role}): ${String(last.content).slice(0, 80)}\n`);
      }
      return 'ok';
    case 'save': {
      if (!args) { io.stderr.write('usage: .save <file>\n'); return 'error'; }
      try {
        fs.writeFileSync(args, JSON.stringify({
          model: state.model,
          system: state.system,
          messages: state.messages,
        }, null, 2), 'utf8');
        io.stdout.write(`saved ${state.messages.length} message(s) to ${args}\n`);
        return 'ok';
      } catch (e) {
        io.stderr.write(`save failed: ${e.message}\n`);
        return 'error';
      }
    }
    case 'load': {
      if (!args) { io.stderr.write('usage: .load <file>\n'); return 'error'; }
      try {
        const data = JSON.parse(fs.readFileSync(args, 'utf8'));
        if (!Array.isArray(data.messages)) throw new Error('file missing "messages" array');
        state.messages.length = 0;
        state.messages.push(...data.messages);
        if (data.system) state.system = data.system;
        if (data.model)  state.model  = data.model;
        io.stdout.write(`loaded ${state.messages.length} message(s) from ${args}\n`);
        return 'ok';
      } catch (e) {
        io.stderr.write(`load failed: ${e.message}\n`);
        return 'error';
      }
    }
    default:
      io.stderr.write(`unknown command '.${command}'. type .help for the list.\n`);
      return 'unknown';
  }
}

async function chatRepl(ctx) {
  const { provider, kind, model } = await ctx.buildProvider(ctx);
  await provider.init();

  const state = {
    system: ctx.opts.system ?? null,
    model: ctx.opts.model ?? null,
    messages: [],
  };
  const maxTokens = ctx.opts['max-tokens'] ? parseInt(ctx.opts['max-tokens'], 10) : 1024;

  ctx.stdout.write(`saptarishi-llm chat REPL — provider: ${kind}, model: ${state.model ?? model}\n`);
  ctx.stdout.write(`type .help for commands, .exit to quit (Ctrl+D also works).\n\n`);

  const rl = readline.createInterface({
    input: ctx.stdin ?? process.stdin,
    output: ctx.stdout ?? process.stdout,
    prompt: '> ',
    terminal: false,
  });

  return await new Promise((resolve) => {
    rl.prompt();

    rl.on('line', async (line) => {
      // Pause input so back-to-back lines don't race our async handler.
      // (readline doesn't await 'line' listeners — without this, two lines
      // arriving before provider.chat resolves would run concurrent handlers
      // and corrupt state.messages.)
      rl.pause();
      try {
        const trimmed = line.trim();
        if (!trimmed) { return; }

        const slash = parseSlashCommand(trimmed);
        if (slash) {
          const outcome = handleSlashCommand(slash, state, ctx);
          if (outcome === 'exit') { rl.close(); return; }
          return;
        }

        // Regular chat turn.
        state.messages.push({ role: 'user', content: trimmed });
        const req = {
          messages: [...state.messages],
          maxTokens,
        };
        if (state.system) req.system = state.system;
        if (state.model)  req.model  = state.model;

        try {
          const res = await provider.chat(req);
          const reply = res.text ?? '';
          state.messages.push({ role: 'assistant', content: reply });
          ctx.stdout.write('\n' + reply + '\n\n');
          if (ctx.opts.json && res.usage) {
            ctx.stdout.write(`[${res.model ?? state.model ?? model}] tokens: ${res.usage.input_tokens ?? '?'} in / ${res.usage.output_tokens ?? '?'} out\n\n`);
          }
        } catch (e) {
          ctx.stderr.write(`error: ${e.message}\n`);
        }
      } finally {
        rl.resume();
        rl.prompt();
      }
    });

    rl.on('close', () => {
      ctx.stdout.write('\n');
      resolve(0);
    });
  });
}

chat.help = `saptarishi-llm chat — send a prompt, print the response

usage:
  saptarishi-llm chat [--prompt <text> | --file <path> | -]  one-shot mode
  saptarishi-llm chat -i | --interactive                     REPL mode

one-shot options:
  --provider, --model, --max-tokens, --system, --json  (see 'saptarishi-llm help')

REPL slash commands:
  .system [<text>]   show or set the system prompt
  .model <id>        switch model for the next turn onward
  .clear             clear the conversation history
  .save <file>       save conversation to JSON file
  .load <file>       load conversation from JSON file
  .history           print message count + last turn
  .help, .?          show help
  .exit, .quit       exit (Ctrl+D also works)

examples:
  saptarishi-llm chat -p "hello"
  saptarishi-llm chat -i                       # interactive REPL
  saptarishi-llm chat -i --system "be terse"   # REPL with system prompt
  echo "summarize this" | saptarishi-llm chat -f report.txt
  saptarishi-llm chat --json -p "list 3 SAP procurement KPIs"`;

module.exports = chat;
module.exports.parseSlashCommand = parseSlashCommand;
module.exports.handleSlashCommand = handleSlashCommand;
module.exports.chatRepl = chatRepl;
