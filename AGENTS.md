# pi-compactor

Pi extension for model-driven context compaction.

Run `bun run check` (tests and typecheck). Pi loads the TypeScript source; there is no build step.

## Design principles

- The prompt guidelines are the primary value, not the tool. The tool calls `ctx.compact()` — anyone can do that. The guidelines shape *when* and *how* the model compacts. Modifying them has outsized impact on quality.
- Research (Sculptor, 2025): unguided tool use is suboptimal. Prompt guidelines improve tool usage quality by 27+ points on benchmarks.

- The LLM decides task-boundary compaction timing. The only extension-owned automatic trigger is opt-in, idle pre-expiry compaction through the companion's cached-only authorization; never compact automatically with unknown/expired TTL or fall back to a normal summary.
- Context hints inform the model; they don't force action.
- Use pi's built-in compaction. No custom summarization, no cache-busting.
- Compaction model is configurable but optional — pi's default works fine.

## Conventions

- Compaction requests pass Pi's resolved `ProviderHeaders` through unchanged. `null` deletes a provider default header, so filtering it out would silently restore a header the auth config disabled.
- `index.ts` owns compaction and resume lifecycle; `policy.ts` owns pure task-boundary policy; `expiry.ts` owns idle cache observation and scheduling.
- Task-boundary hint thresholds and tuning constants live in source with comments. Do not expose those thresholds as configuration.
- Config covers the compaction model and the top-level `compactor` cache preferences (`compactBeforeExpiry`, `leadTimeSeconds`, `minContextTokens`). Read merged Pi settings; do not modify live settings.
- Test against real sessions. Threshold tuning requires observing actual context usage patterns.

## Don't

- Add automatic fallback compaction or continuation for idle expiry. Preserve the tool's model-driven timing and explicit resume choice.
- Add task-boundary hint threshold configuration.
- Add telemetry or logging beyond `console.error` for failed operations.
