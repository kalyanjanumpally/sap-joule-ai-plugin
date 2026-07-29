// Type-check example. Not executed — just fed to `tsc --noEmit` in CI to
// verify the public API surface stays type-correct. Uses every exported symbol.

import {
  AnthropicLLMService,
  OllamaLLMService,
  GroqLLMService,
  OpenAICompatibleLLMService,
  GenAIHubLLMService,
  LLMService,
  imageFromFile,
  imageFromUrl,
  imageFromBase64,
  pdfFromFile,
  pdfFromUrl,
  pdfFromBase64,
  runTools,
  RunnableTool,
  RunToolsResult,
  Middleware,
  MiddlewareContext,
  rateLimit,
  RateLimitOptions,
  otel,
  OtelOptions,
  OtelTracerLike,
  redisRateLimit,
  RedisRateLimitOptions,
  RedisClientLike,
  PromptRegistry,
  PromptTemplate,
  PromptArgument,
  RenderedPrompt,
  builtInPrompts,
  // Types
  ChatRequest,
  ChatResponse,
  StreamChunk,
  TextDeltaChunk,
  DoneChunk,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentBlock,
  TextBlock,
  ImageBlock,
  DocumentBlock,
  Tool,
  ToolCall,
  Usage,
  EmbedRequest,
  EmbedResponse,
  JsonSchema,
  RetryOptions,
  ThinkingConfig,
  ProviderOptions,
} from '../lib';

async function example() {
  // ---- construct providers -----------------------------------------------
  const anthropic = new AnthropicLLMService('llm', null, {
    modelId: 'claude-opus-4-7',
    credentials: { apiKey: 'sk-ant-...' },
  });

  const ollama = new OllamaLLMService('llm', null, {
    modelId: 'qwen2.5:14b',
    credentials: { baseUrl: 'http://192.168.5.13:11434' },
  });

  const groq: GroqLLMService = new GroqLLMService('llm', null, {
    modelId: 'llama-3.3-70b-versatile',
  });

  const openai = new OpenAICompatibleLLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...' },
  });

  const genai: GenAIHubLLMService = new GenAIHubLLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: {
      aiCoreUrl: 'https://...',
      tokenUrl: 'https://...',
      clientId: 'sb-...',
      clientSecret: '...',
      deploymentId: 'depABC',
    },
  });

  await anthropic.init();
  await ollama.init();

  // All providers assignable to the base type
  const providers: LLMService[] = [anthropic, ollama, groq, openai, genai];
  providers.forEach(p => void p);

  // ---- chat() — simple text ------------------------------------------------
  const req: ChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
  };
  const res: ChatResponse = await groq.chat(req);
  const t: string = res.text;
  const u: Usage = res.usage;
  void t; void u;

  // ---- chat() — with structured output, typed data ------------------------
  interface Extract { risk: 'low' | 'medium' | 'high'; rationale: string }
  const risk: ChatResponse<Extract> = await groq.chat<Extract>({
    messages: [{ role: 'user', content: 'analyze' }],
    format: {
      type: 'object',
      properties: {
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        rationale: { type: 'string' },
      },
      required: ['risk', 'rationale'],
    },
  });
  const level: 'low' | 'medium' | 'high' | undefined = risk.data?.risk;
  void level;

  // ---- chat() — tool use round trip --------------------------------------
  const tool: Tool = {
    name: 'get_weather',
    description: 'Fetch weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  };
  const turn1 = await groq.chat({
    messages: [{ role: 'user', content: 'weather in paris?' } as UserMessage],
    tools: [tool],
  });
  if (turn1.toolCalls?.length) {
    const call: ToolCall = turn1.toolCalls[0];
    const assistant: AssistantMessage = { role: 'assistant', toolCalls: turn1.toolCalls };
    const toolResult: ToolResultMessage = {
      role: 'tool', tool_call_id: call.id, content: 'sunny 72F',
    };
    await groq.chat({
      messages: [
        { role: 'user', content: 'weather in paris?' },
        assistant,
        toolResult,
      ],
      tools: [tool],
    });
  }

  // ---- chat() — vision -----------------------------------------------------
  const img1: ImageBlock = imageFromUrl('https://x/y.png');
  const img2: ImageBlock = imageFromBase64('AAAA', 'image/png');
  const img3: ImageBlock = await imageFromFile('/tmp/x.png');
  const textBlock: TextBlock = { type: 'text', text: 'describe' };
  const blocks: ContentBlock[] = [img1, img2, img3, textBlock];
  await groq.chat({
    model: 'llama-vision',
    messages: [{ role: 'user', content: blocks }],
  });

  // ---- chat() — PDF (Anthropic-only) --------------------------------------
  const pdf1: DocumentBlock = pdfFromUrl('https://x/y.pdf');
  const pdf2: DocumentBlock = pdfFromBase64('JVBERi0xLjQ=');
  const pdf3: DocumentBlock = await pdfFromFile('/tmp/x.pdf');
  const pdfContent: ContentBlock[] = [pdf1, pdf2, pdf3, { type: 'text', text: 'summarize' }];
  await anthropic.chat({
    messages: [{ role: 'user', content: pdfContent }],
  });

  // ---- stream() ------------------------------------------------------------
  for await (const chunk of groq.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    const c: StreamChunk = chunk;
    if (c.type === 'text_delta') {
      const d: TextDeltaChunk = c;
      const t: string = d.text;
      void t;
    } else {
      const done: DoneChunk = c;
      const totalText: string = done.text;
      void totalText;
    }
  }

  // ---- embed() ------------------------------------------------------------
  const emb: EmbedResponse = await ollama.embed({ input: ['hello', 'world'] } as EmbedRequest);
  const vectors: number[][] = emb.embeddings;
  void vectors;

  // ---- middleware (new in 1.2.0) -----------------------------------------
  const logger: Middleware = async (ctx: MiddlewareContext, next) => {
    ctx.meta.start = Date.now();
    const res = await next();
    ctx.meta.durationMs = Date.now() - (ctx.meta.start as number);
    return res;
  };
  groq.use(logger).use(async (ctx, next) => next());

  // ---- built-in middleware (1.3.0) ---------------------------------------
  const rlOpts: RateLimitOptions = {
    capacity: 30,
    refillPerSecond: 0.5,
    keyFn: (ctx) => (ctx.meta.user as string) ?? 'anon',
    mode: 'wait',
  };
  const rl: Middleware = rateLimit(rlOpts);
  groq.use(rl);

  const fakeTracer: OtelTracerLike = {
    startSpan: (_name: string) => ({
      setAttribute: () => {}, end: () => {},
      recordException: () => {}, setStatus: () => {},
    }),
  };
  const otelOpts: OtelOptions = { tracer: fakeTracer, spanNamePrefix: 'ai.', systemAttribute: 'groq' };
  groq.use(otel(otelOpts));

  const fakeRedis: RedisClientLike = { async eval() { return [1, 0]; } };
  const rrlOpts: RedisRateLimitOptions = {
    redis: fakeRedis,
    capacity: 30,
    refillPerSecond: 0.5,
    keyFn: (ctx) => (ctx.meta.user as string) ?? 'anon',
    keyPrefix: 'app:',
    mode: 'throw',
  };
  groq.use(redisRateLimit(rrlOpts));

  // ---- prompt registry (1.8.0) -------------------------------------------
  const registry = new PromptRegistry();
  const promptArg: PromptArgument = { name: 'x', description: 'x', required: true };
  const tpl: PromptTemplate = {
    name: 'my_prompt',
    description: 'a demo',
    arguments: [promptArg],
    render: (vars: Record<string, any>): RenderedPrompt => ({
      system: 'be terse',
      messages: [{ role: 'user', content: String(vars.x) }],
    }),
  };
  registry.register(tpl).registerAll(builtInPrompts());
  const listed = registry.list();
  const has: boolean = registry.has('my_prompt');
  const rendered: RenderedPrompt = registry.render('my_prompt', { x: 'hi' });
  void listed; void has; void rendered;

  // ---- runTools (new in 1.1.0) -------------------------------------------
  const tools: RunnableTool[] = [{
    name: 'add',
    description: 'add two numbers',
    input_schema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    run: async ({ a, b }: { a: number; b: number }) => a + b,
  }];
  const runRes: RunToolsResult = await runTools({
    llm: groq,
    messages: [{ role: 'user', content: 'add 2 and 3' }],
    tools,
    maxSteps: 5,
  });
  const finalText: string = runRes.text;
  const stepCount: number = runRes.steps;
  const executed = runRes.toolCalls;   // ExecutedToolCall[]
  void finalText; void stepCount; void executed;

  // ---- misc types --------------------------------------------------------
  const retries: RetryOptions = { max: 5, baseMs: 500, maxMs: 30000 };
  const thinking: ThinkingConfig = { type: 'adaptive' };
  const opts: ProviderOptions = { modelId: 'x', retries };
  const schema: JsonSchema = { type: 'object' };
  const msg: Message = { role: 'user', content: 'x' };
  void retries; void thinking; void opts; void schema; void msg;
}

// suppress unused-fn warning
void example;
