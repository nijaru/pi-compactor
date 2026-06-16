# pi-compactor

Pi extension that lets the LLM manage its own context compaction. The model decides when to compact based on task state, not fixed thresholds. Context hints keep it aware of usage.

The model sees usage hints like `[ctx 128k/1m 13%] consider compact tool` and decides when to compact after finishing a feature, not mid-edit.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

Or copy to `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local):

```bash
cp -r . ~/.pi/agent/extensions/pi-compactor
```

## How it works

1. As context fills, pi-compactor injects hint messages: `[ctx 128k/1m 13%] consider compact tool`
2. The model calls `compact` with optional preservation instructions
3. pi reloads the session with the summary and sends "Continue."

First hint at 128k tokens or 50% of window, then every 5%. Escalates at 80% or 200k tokens:

```
[ctx 64k/128k 50%] consider compact tool
[ctx 100k/128k 78%] consider compact tool
[ctx 200k/1m 20%] [! >200k] compact tool recommended
```

## Usage

Registers a `compact` tool the model calls when it decides to compact:

```
compact(instructions="preserve API design decisions, current task: auth refactor")
```

The `instructions` parameter tells the compaction model what to prioritize in the summary.

Errors (session too small, already compacted this turn) are logged, not surfaced to the model.

## Compaction model

Use a cheaper/faster model for compaction summaries via `--compaction-model`:

```bash
pi --compaction-model openrouter/deepseek/deepseek-v4-flash
```

Or configure in `compaction-policy.json` (project-local `.pi/` or global `~/.pi/agent/`):

```json
{
  "models": ["openrouter/deepseek/deepseek-v4-flash"]
}
```

Resolution order: `--compaction-model` flag → project config → global config → pi default.

## License

MIT
