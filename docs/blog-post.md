# An LLM-agnostic CAP plugin: develop your Joule integrations locally, deploy to Generative AI Hub

> **Draft for community.sap.com.** Suggested tags: `CAP`, `SAP Business Technology Platform`, `Joule`, `Generative AI Hub`, `Generative AI`, `Open Source`.
> Suggested category: `SAP Developer News`.

---

## The paid-tier problem

If you have tried to prototype a Joule skill or a CAP action that calls a large language model, you have probably run into the same wall I did: **SAP Generative AI Hub requires the paid `extended` plan of SAP AI Core**. The BTP trial does not include it. Free-tier developer accounts do not include it. The moment you want to iterate on a prompt or test an idea, you are looking at a per-token bill on top of a fixed infrastructure charge.

For teams already committed to BTP that is fine — production runs on Generative AI Hub anyway, and you want that same runtime for governance, cost attribution, and model catalog reasons. But for the *prototype* phase, and for anyone learning the CAP + Joule stack for the first time, the friction is real. You end up either burning credits on throwaway experiments, or writing your CAP handlers against a local mock that behaves nothing like the eventual GenAI Hub call.

I hit this while building a Joule Procurement Copilot as sales collateral for an S/4HANA Cloud engagement. The copilot needed a small CAP-hosted action to produce approver-ready purchase-order summaries — a task well within any modern LLM's abilities, but iterating on the prompt against GenAI Hub was slow and expensive. I wanted a way to develop locally against `ollama serve` on my Mac Studio, or use free cloud inference from Groq for a fast iteration loop, and only pay for GenAI Hub tokens once the flow was actually ready to demo.

That is what `cds-plugin-llm` does.

## What it is

`@saptarishi/cds-plugin-llm` is a small (~16KB) CAP plugin that registers five service kinds under `cds.requires`:

| Kind | Backend | Cost to iterate |
| --- | --- | --- |
| `llm-anthropic` | Claude via the official Anthropic SDK | Pennies per call, your own API key |
| `llm-ollama` | Local Ollama daemon (qwen2.5, llama3, mistral, etc.) | Free |
| `llm-groq` | Groq's hosted Llama / Mixtral / Qwen — sub-second inference | Generous free tier |
| `llm-openai-compatible` | Any endpoint speaking OpenAI's `/chat/completions` shape (OpenAI, Together AI, Fireworks, DeepSeek, LM Studio, LocalAI) | Varies |
| `llm-genai-hub` | SAP Generative AI Hub (stub — wiring notes in `lib/providers/genai-hub.js`) | Paid, once you flip the switch |

All five expose the same interface:

```js
const llm = await connectLLM();  // returns the configured provider
const { text, usage, model } = await llm.chat({
  system: 'You summarize purchase orders in 2 sentences.',
  messages: [{ role: 'user', content: JSON.stringify(po) }],
  maxTokens: 300,
});
```

Your CAP handler code does not know or care which backend is answering. Swapping between them is a **config-file change**, not a code change. Concretely, in your CAP app's `package.json`:

```jsonc
{
  "cds": {
    "requires": {
      "llm": {
        "[development]": { "kind": "llm-groq",       "modelId": "llama-3.3-70b-versatile" },
        "[ollama]":      { "kind": "llm-ollama",     "modelId": "qwen2.5:14b"             },
        "[production]":  { "kind": "llm-genai-hub", "credentials": { "deploymentId": "..." } }
      }
    }
  }
}
```

## A concrete example

The demo application that shipped alongside the plugin is a CAP backend for a Joule Procurement Copilot. Two OData actions:

```
POST /ai/summarizePurchaseOrder
POST /ai/explainInvoiceRisk
```

The handler for the first one — the entire thing:

```js
this.on('summarizePurchaseOrder', async (req) => {
  const { purchaseOrderId, poJson } = req.data;
  const { text, usage, model } = await llm.chat({
    system: PO_SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: poJson }],
    cache: true,
    maxTokens: 300,
  });
  return {
    purchaseOrderId,
    summary: text,
    tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    model,
  };
});
```

On my machine, in the `[development]` profile, this call hits Groq's hosted `llama-3.3-70b-versatile` in **~500ms** — free tier, no billing anxiety. Flipping the profile to `[ollama]` runs the exact same handler against a local model on my Mac Studio (about 2 seconds, but the tokens never leave my LAN). When we ship to BTP, the `[production]` profile points at GenAI Hub. **The handler is not touched across any of them.**

The Joule side is wired up as an ordinary skill:

- An OpenAPI action spec pointing at the CAP endpoint
- A destination for the CAP app in the customer's BTP subaccount
- A skill definition that calls `PurchaseOrder.get` first (using the existing S/4HANA action), then hands the JSON to `AIAssist.summarizePO` (using this plugin's endpoint)

From a Joule user's perspective it is one utterance: *"Summarize PO 4500000123 before I approve it."* Under the hood: two API calls, one to S/4HANA, one to a CAP service that in turn calls whichever LLM is configured for that environment.

## What it does not do (yet)

Being direct about scope so nobody is surprised:

- **The GenAI Hub provider is a stub.** The `lib/providers/genai-hub.js` file contains the wiring instructions but not the implementation, because completing it responsibly needs an actual AI Core `extended` deployment to test against. This is the highest-value next contribution the plugin needs.
- **No embeddings on the Anthropic path.** Anthropic does not ship first-party embeddings; use Ollama for that today (`mxbai-embed-large` works well).
- **No streaming responses to the caller.** The plugin uses streaming internally to avoid SDK timeouts on long completions, but the CAP handler returns a synchronous response. Server-sent events to the CAP client are a natural v0.2 addition.
- **CAP v9 integration required a couple of workarounds** — the plugin instantiates the provider class directly in the handler instead of using `cds.connect.to('llm')`, and consumers need `NODE_PRESERVE_SYMLINKS=1` when using `file:` deps during development. Both are documented in the README, both are open issues.

## Try it

```bash
# In your CAP project
npm install @saptarishi/cds-plugin-llm

# Point cds.requires.llm at a kind (see the README)
# Then in a handler:
const {
  AnthropicLLMService,
  OllamaLLMService,
  GroqLLMService,
  OpenAICompatibleLLMService,
  GenAIHubLLMService,
} = require('@saptarishi/cds-plugin-llm');
```

- **Repo:** https://github.com/kalyanjanumpally/sap-joule-ai-plugin
- **npm:** https://www.npmjs.com/package/@saptarishi/cds-plugin-llm
- **License:** Apache-2.0

Feedback, PRs, and — especially — a real implementation of the GenAI Hub provider from someone with AI Core extended access are all very welcome.

---

## About me

I work on SAP Joule and S/4HANA Cloud engagements, focused on procurement, finance, and supply-chain copilot design. If you are exploring Joule adoption or looking at how to package CAP-based AI microservices for a customer pitch, get in touch:

- LinkedIn: [linkedin.com/in/kalyanjanumpally](https://linkedin.com/in/kalyanjanumpally)
- Email: KALYAN.JANUMPALLY@Saptarishi.tech
