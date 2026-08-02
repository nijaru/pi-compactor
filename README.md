# pi-compactor

Pi extension that lets the LLM manage its own context compaction. The model decides when to compact based on task state, not fixed thresholds. Context hints keep it aware of usage without automatically triggering compaction.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

## How it works

1. As context fills, pi-compactor injects a small usage hint such as `[ctx 128k/1m]`.
2. The model calls the `compact` tool at a genuine task boundary, with optional preservation instructions.
3. Pi reloads the session with the summary; after the active run settles, the extension sends `Continue.` as a new prompt so the recovery message cannot be stranded in an aborted follow-up queue.

The first hint is at 50% for context windows up to 128k, or about 128k tokens for larger windows. Later hints are throttled by both percentage and token deltas. A `[>200k]` marker indicates that the context has crossed the higher-cost range; it does not trigger compaction.

## Configuration

Use a cheaper/faster model for compaction summaries via `--compaction-model`:

```bash
pi --compaction-model openrouter/deepseek/deepseek-v4-flash
```

Or configure an ordered fallback chain in `compaction-policy.json`:

```json
{
  "models": [
    "openrouter/deepseek/deepseek-v4-flash",
    "anthropic/claude-haiku-4-5"
  ]
}
```

The project file is `<pi-config-dir>/compaction-policy.json` (normally `.pi/compaction-policy.json`); the global file is Pi's agent directory (normally `~/.pi/agent/compaction-policy.json`). Project policy is read only when Pi reports the project as trusted or has an explicit saved trust decision. A policy file alone does not opt an untrusted repository into sending summaries to a remote model. SDK users with a custom agent directory can set `PI_COMPACTOR_AGENT_DIR` explicitly; normal Pi sessions derive the active directory from the session manager. Resolution order is:

1. `--compaction-model`
2. the trusted project file
3. the global file
4. Pi's default compaction model

Configured models are retried only for transient failures. Empty summaries, permanent failures, invalid selectors, and missing authentication fall back to the next configured model and finally Pi's default.

## License

MIT
