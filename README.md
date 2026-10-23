# pi-compactor

Pi extension that lets the LLM manage its own context compaction. The model decides when to compact based on task state, not fixed thresholds. Context hints keep it aware of usage without automatically triggering compaction; Pi's built-in threshold remains the final safety net.

## Installation

Requires Pi 1.2.0 or later. Development checks target Pi 1.4.0.

```bash
pi install npm:@nijaru/pi-compactor
```

## How it works

1. As context fills, pi-compactor injects a small usage hint such as `[ctx 128k/1m]`.
2. The model calls the `compact` tool at a verified task or phase boundary, with optional preservation instructions and an explicit `continueAfterCompaction` choice.
3. Pi reloads the session with the summary. With `continueAfterCompaction: true`, the extension asks the summarizer to preserve the active request and remaining work, then starts a hidden recovery turn directing the model to take the next unfinished step—not merely recap. Pending checks and already-authorized delivery still count as work. If the task is complete, it gives the final response; if blocked, it reports the blocker or asks the necessary question. With `false`, no recovery turn starts.

The first hint is at 50% for context windows up to 128k, or about 128k tokens for larger windows. Later hints are throttled by both percentage and token deltas. If the model declares tiered prices, a hint such as `[est. pricing tier >272k]` marks a crossed pricing threshold; large contexts alone do not imply higher rates or trigger compaction. Pi's own automatic threshold is controlled by `compaction.reserveTokens` in Pi's `settings.json`; this extension does not add another context-pressure trigger.

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

Configured models are retried only for transient failures. Empty summaries, permanent failures, invalid selectors, and missing authentication fall back to the next configured model and finally Pi's default. When the companion [`pi-provider-compaction`](https://github.com/nijaru/pi-provider-compaction) extension is installed, leave `compaction-model` unset so its provider-native adapter can own the saved compaction details. Without a provider-native adapter, Pi's default compaction path remains available.

### Cache-aware idle compaction

With a compatible `pi-provider-compaction` companion, pi-compactor can optionally compact shortly before estimated cache expiry. Configure the top-level `compactor` object in Pi's `settings.json`:

```json
{
  "compactor": {
    "compactBeforeExpiry": false,
    "leadTimeSeconds": 30,
    "minContextTokens": 50000
  }
}
```

These are the defaults. `leadTimeSeconds` is bounded to 1–300; `minContextTokens` is a non-negative integer. Settings are read from Pi's merged settings at idle boundaries and during idle refresh; the extension never writes them. Reload after editing settings files.

TTL is a **best-effort model estimate**, not a provider guarantee. Missing lifetime metadata stays unknown. Cache expiry adds no status-bar item, context-hint text, or slash command.

Pre-expiry compaction is off by default. When enabled, it runs only while idle, with no pending input or compaction/resume, and only if `compaction.enabled` is not false. It requires enough actual context tokens (or the companion's measured input usage), a prepared cached-summary path, observed cached usage, and a known, unexpired estimated TTL. Idle refresh tracks Pi's cache warmer; a newer warm cycle postpones the attempt. There is at most one attempt per cache cycle. Both extensions recheck shared transaction ownership and pending input before paid work, regardless of their load order. Abandoned or declined requests are not reported as completed. Missing companions, failures, and expired or unknown TTL never fall back to ordinary summarization.

Idle expiry never starts a continuation. Normal model-driven task-boundary timing and the tool's explicit `continueAfterCompaction` choice are unchanged. Leave `compaction-model` unset for companion-native compaction.

## Development

Run `bun install` and `bun run check` (tests and typecheck). Pi loads the TypeScript source directly; no build step is needed.

## License

MIT
