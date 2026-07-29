# {{APP_NAME}}

SAP CAP app pre-wired to [`@saptarishi/cds-plugin-llm`](https://www.npmjs.com/package/@saptarishi/cds-plugin-llm) using the **{{PROVIDER_KIND}}** provider (default model: `{{MODEL}}`).

## Run

```bash
npm install
cp .env.example .env
# fill in real credentials in .env
cds watch
```

CAP loads `.env` automatically. Once `cds watch` is up on `http://localhost:4004`, exercise the service:

```bash
curl 'http://localhost:4004/ai/chat(prompt='"'"'hello'"'"')'
curl 'http://localhost:4004/ai/summarize(text='"'"'Long text here...'"'"')'
```

## Structure

```
srv/
  ai-service.cds   — service definition (chat + summarize)
  ai-service.js    — handlers that call cds.connect.to('llm')
package.json       — cds.requires.llm = { kind: 'llm-{{PROVIDER_KIND}}', ... }
.env.example       — env vars the plugin reads for credentials
```

## Swap the provider

Edit `package.json` → `cds.requires.llm.kind`. Supported: `llm-anthropic`, `llm-ollama`, `llm-groq`, `llm-openai-compatible`, `llm-genai-hub`. Update `.env` for the new provider's credentials.

## Add features

The plugin exposes `chat`, `stream`, `embed`, plus built-in middleware (`rateLimit`, `otel`, `redisRateLimit`) and helpers (`runTools`, image / PDF blocks). Full docs at [github.com/kalyanjanumpally/sap-joule-ai-plugin](https://github.com/kalyanjanumpally/sap-joule-ai-plugin).
