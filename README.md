# pi-compactor

Pi extension that lets the LLM manage its own context compaction. The model decides when to compact based on task state — no auto-triggers. Context hints keep it aware of usage.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

Or copy to `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local):

```bash
cp -r . ~/.pi/agent/extensions/pi-compactor
```

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

Registers a `compact` tool. After compaction, sends a continuation message so the model keeps working. Errors (session too small, already compacted) are logged, not surfaced to the LLM.

Provide optional instructions to focus the summary:

```
compact(instructions="preserve API design decisions")
```

## License

MIT
