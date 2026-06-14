# pi-compactor

A pi extension that gives the LLM a `compact` tool and context usage awareness for self-managed compaction. The model decides when to compact based on task boundaries, accumulated tool results, and session length. No auto-triggers — just the LLM's judgment informed by context usage hints.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

Or copy to `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local):

```bash
cp -r . ~/.pi/agent/extensions/pi-compactor
```

## Context awareness

The extension injects context usage hints into the LLM's view when thresholds are crossed:

- **50% of context window** — catches small-medium windows (128k–200k)
- **25% of window, floor 100k, cap 200k** — catches large windows (1m) early

Hints are throttled to avoid nagging — scaled to 5 percentage points / 2.5% of window between injections. An urgency note is added at 80%+.

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

The flag overrides the config file. If neither is set, pi uses its default compaction model.

## Usage

The extension registers a `compact` tool with prompt guidelines that tell the LLM when and how to use it. It queues pi's built-in compaction to run after the current turn. Errors (session too small, already compacted) are logged, not surfaced to the LLM.

Provide optional instructions to focus the summary:

```
compact(instructions="preserve API design decisions")
```

## License

MIT
