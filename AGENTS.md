# pi-compactor

Pi extension for model-driven context compaction.

## Design principles

- The prompt guidelines are the primary value, not the tool. The tool calls `ctx.compact()` — anyone can do that. The guidelines shape *when* and *how* the model compacts. Modifying them has outsized impact on quality.
- Research (Sculptor, 2025): unguided tool use is suboptimal. Prompt guidelines improve tool usage quality by 27+ points on benchmarks.

- The LLM decides when to compact. No auto-triggers, no threshold-based firing.
- Context hints inform the model; they don't force action.
- Use pi's built-in compaction. No custom summarization, no cache-busting.
- Compaction model is configurable but optional — pi's default works fine.

## Conventions

- Single file (`index.ts`). No splitting unless it grows past ~300 lines.
- All thresholds and tuning constants live in source with comments, not in config files.
- Config is for the compaction model only. Don't add threshold config — those are design decisions, not user preferences.
- Test against real sessions. Threshold tuning requires observing actual context usage patterns.

## Don't

- Add auto-trigger fallbacks. The model-driven approach is the point of this extension.
- Add threshold configuration. The values are carefully chosen; user tuning would degrade behavior.
- Add telemetry or logging beyond `console.error` for failed operations.
