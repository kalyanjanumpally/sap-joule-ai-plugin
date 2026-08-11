# Migration guide

## From 1.x to 2.0.0

**Zero code changes required.** 2.0 is a stability declaration — every 1.x API is preserved with the same signatures and behavior.

```sh
npm install @saptarishi/cds-plugin-llm@2
```

No handler changes, no configuration changes, no rewrites. The 2.x line commits to the following stability contract for every export marked `@since 1.x` in `lib/index.d.ts`:

- Argument order and option shapes are frozen.
- Return shapes (including `stats`, `asMcpResource().handler()` payloads) are frozen.
- Error codes registered in `errorRegistry` will not be renamed or repurposed.
- HTTP status codes attached to `LLMError` subclasses will not change.
- MCP resource URIs (the 28 `config://*` in `chainSnapshot.URI_TO_KIND`) will not be renamed.
- Prometheus metric names (`llm_*` from `promMetrics`) will not be renamed — existing Grafana dashboards + Prometheus alert rules keep working.

### What might change in a future 2.x minor

Additive changes are always fair game in a minor release:

- New middleware primitives
- New optional fields on existing option/result shapes (never required, never breaking)
- New CLI commands + subcommands
- Additional error codes
- New provider kinds
- Additional `stats` fields (existing fields preserved)

If a change would break the contract above, it will require a **3.0**.

## From 0.x to 2.0.0

Two-hop upgrade recommended for safety:

1. First upgrade to the last 0.x release, then to 1.0.0 (see the 1.0.0 CHANGELOG entry for the 0.x → 1.0.0 details).
2. Then upgrade 1.x → 2.0.0 (which requires no changes per above).

## Verify before deploying

Run the shipped diagnostics against the target environment:

```sh
# Env probe (credentials + provider reachability):
npx saptarishi-llm doctor

# Config validation (chain ordering + env vars + budget limits):
npx saptarishi-llm preflight ./chain-config.json

# Snapshot the live middleware chain and diff against a committed baseline:
node -e "console.log(JSON.stringify(require('@saptarishi/cds-plugin-llm').chainSnapshot(llm), null, 2))" > live.json
npx saptarishi-llm chain-diff ./chain-baseline.json ./live.json
```

## Related resources

- [`CHANGELOG.md`](./CHANGELOG.md) — full release history, including the 2.0.0 milestone entry
- [`lib/index.d.ts`](./lib/index.d.ts) — every stable API is annotated with `@since <version>`
- [`README.md`](./README.md) — usage guide
