# pi-compactor

Pi extension for reliable context compaction and continuation. It gives the LLM a task-boundary `compact` tool and schedules a safety compaction at 70% of the active model's context window after the current agent run settles. Pi's own threshold and overflow paths remain the final safety net.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

## How it works

1. As context fills, pi-compactor injects a small usage hint such as `[ctx 128k/1m]`.
2. The model can call the `compact` tool at a genuine task boundary, with optional preservation instructions.
3. At 70% usage, the extension records a pending safety compaction and waits for `agent_settled`, so it never interrupts tools or races provider requests.
4. After compaction's completion callback, the extension sends `Continue.` as a new prompt. Pi-owned overflow retries do not receive a duplicate continuation.

The first hint is at 50% for context windows up to 128k, or about 128k tokens for larger windows. Later hints are throttled by both percentage and token deltas. A `[>200k]` marker indicates that the context has crossed the higher-cost range; it does not itself trigger compaction. The 70% safety threshold is source-level policy, not a config-file setting. Pi's threshold remains `contextWindow - compaction.reserveTokens` as a final safety net.

## Configuration

The automatic 70% safety threshold is deliberately not configurable. For Pi's final safety net, `compaction.reserveTokens` belongs in Pi's `settings.json`; for the active GPT-5.6 Codex model configured with a 272k window, a 72k reserve starts Pi compaction around 200k:

```json
{
  "compaction": { "reserveTokens": 72000 }
}
```

That setting does not belong in `compaction-policy.json`; this extension only uses that file for configured summary models.

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

Configured models are retried only for transient failures. Empty summaries, permanent failures, invalid selectors, and missing authentication fall back to the next configured model and finally Pi's default. When using a provider-native compaction extension such as OpenAI Responses compaction, leave `compaction-model` unset so that extension can own the saved compaction details.

## License

MIT
