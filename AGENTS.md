# pi-compactor

Pi extension for model-driven context compaction. No auto-triggers — the LLM decides when to compact based on context hints.

## Design

- Context hints inject usage messages into the conversation so the model can make informed compaction decisions.
- The `compact` tool calls pi's built-in `ctx.compact()`. No custom summarization or cache-busting.
- Compaction model can be overridden via `--compaction-model` flag or `compaction-policy.json`.

## Hint thresholds

`hintPercent(window)` returns `min(50, round(128000 / window * 100))`.

- ≤256k window: first hint at 50%
- 512k: 25%
- 1m: 13%

The breakpoint is ~128k tokens. Smaller windows hit 50% first; larger windows hit the token threshold first.

### Escalation

- `< 80% && < 200k tokens`: `consider compact tool`
- `≥ 80% || ≥ 200k tokens`: `compact tool recommended`
- `≥ 200k tokens`: adds `[! >200k]` tag (price cliff for many providers)

### Throttle

Hints skip unless `percent - last.percent >= 5` OR `tokens - last.tokens >= max(10000, window * 0.025)`. Resets on `session_compact`, `session_start`, `session_tree`.

## Compaction model resolution

`--compaction-model` flag → `.pi/compaction-policy.json` (project) → `~/.pi/agent/compaction-policy.json` (global) → pi default.

Format: `provider/model-id` (e.g., `openrouter/deepseek/deepseek-v4-flash`). Resolved via `ctx.modelRegistry`.

## API notes

- `ctx.compact()` in tool execute is safe. It queues compaction after the current turn, doesn't abort mid-execution.
- `terminate: true` is not needed. Let the agent continue working after triggering compaction.
- Compaction fires after the turn completes, so the tool result is already committed to context.
- `session_before_compact` hook lets the extension provide a custom compaction model. Return `undefined` to fall back to pi default.
- Context hints use `pi.on("context")` to inject messages into `event.messages`.

## Files

```
index.ts      — Extension entry: hint injection, compact tool, compaction model hook
package.json  — npm metadata, pi extension config
README.md     — User-facing docs
AGENTS.md     — This file
```
