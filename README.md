# pi-compactor

A pi extension that gives the LLM a `compact` tool for self-managed context compaction. The model decides when to compact based on task boundaries, accumulated tool results, and session length. No auto-triggers or heuristic thresholds — just the LLM's judgment.

## Installation

```bash
pi install git:github.com/nijaru/pi-compactor
```

Or copy to `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local):

```bash
cp -r . ~/.pi/agent/extensions/pi-compactor
```

## Usage

The extension registers a `compact` tool with prompt guidelines that tell the LLM when and how to use it. It queues pi's built-in compaction to run after the current turn. Errors (session too small, already compacted) are logged, not surfaced to the LLM.

Provide optional instructions to focus the summary:

```
compact(instructions="preserve API design decisions")
```

## License

MIT
