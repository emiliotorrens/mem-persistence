# mem-persistence

> 🧠 Persistent memory MCP server for AI agents — one memory, every agent, your files.

mem-persistence lets Claude Code, OpenClaw, Cursor, Zed, and any MCP-compatible client share the same persistent memory, backed by plain Markdown files you own and can edit by hand.

## Why?

AI agents have amnesia. Each tool keeps its own silo — Claude Code forgets what OpenClaw knows, Cursor can't recall what you told Claude yesterday. Your context is scattered across sessions that evaporate.

mem-persistence fixes this:

- **Markdown is the source of truth** — not a database, not a binary blob. Files you can read, edit, and version with git.
- **Hybrid search** — token matching + semantic embeddings for accurate recall.
- **Embedding providers** — Gemini (free), OpenAI, or none (token-only). Cached to disk.
- **Deduplication** — token-based + entity overlap detection prevents writing the same fact twice.
- **Temporal decay** — recent notes rank higher, old notes fade (configurable half-life).
- **MMR diversity** — no redundant results cluttering your context window.
- **Works offline** — no cloud dependency. Embeddings are optional.

## Architecture

```
Claude Code ──── MCP (stdio) ────┐
Cursor/Zed ──── MCP (stdio) ────┤──→ mem-persistence ──→ Markdown files
OpenClaw ────── MCP (stdio) ────┘     (local process)    (your workspace)
Any MCP client ─────────────────┘
```

The server reads and writes to a workspace directory containing Markdown files. It doesn't care how those files are organized — but it works best with a layered structure (see [layered-memstack](https://github.com/emiliotorrens/layered-memstack) for an opinionated OpenClaw skill that sets this up).

## MCP Tools

| Tool | Description |
|---|---|
| `memory_search(query, maxResults?)` | Hybrid search across all indexed .md files |
| `memory_write(content, file?, section?)` | Write with automatic deduplication |
| `memory_read(path, from?, lines?)` | Read specific file or section |
| `memory_checkpoint(summary)` | Save a session checkpoint to a daily note |
| `memory_entities(query?)` | Query the knowledge graph (if `entities.md` exists) |
| `memory_status()` | Index stats: files, chunks, last sync |

## Installation

```bash
# From source (until npm publish)
git clone https://github.com/emiliotorrens/mem-persistence.git
cd mem-persistence
npm install
npm run build
```

### Claude Desktop

Add to your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/path/to/mem-persistence/dist/index.js",
        "--workspace",
        "/path/to/your/workspace"
      ]
    }
  }
}
```

> **WSL users:** Use `"command": "wsl"` and prepend `"node"` to args.

### Claude Code

Add to `~/.claude.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mem-persistence/dist/index.js", "--workspace", "/path/to/workspace"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mem-persistence/dist/index.js", "--workspace", "/path/to/workspace"]
    }
  }
}
```

### After npm publish (coming soon)

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mem-persistence@latest", "--workspace", "/path/to/workspace"]
    }
  }
}
```

### Agent Instructions

MCP tools are available but agents won't use them proactively without instructions. Copy the contents of [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) into the right place for your editor:

- **Claude Desktop** → Settings (⚙️) → "Personal Preferences" → paste in the text box → Save
- **Claude Code** → `CLAUDE.md` in your project root
- **Cursor** → `.cursorrules` in your project root
- **Windsurf** → `.windsurfrules` in your project root

This tells the agent to search memory before answering, write important facts, and checkpoint at end of sessions.

### OpenClaw

Add to `openclaw.json`:

```json5
mcp: {
  servers: {
    memory: {
      command: "mem-persistence",
      args: ["--workspace", "/path/to/workspace"]
    }
  }
}
```

## Configuration

### Embeddings (optional)

Enable semantic search with embedding providers via environment variables:

```bash
# Gemini (free, recommended)
MEM_PERSISTENCE_EMBEDDINGS=gemini
GOOGLE_API_KEY=your-google-api-key

# OpenAI (paid, $0.02/M tokens)
MEM_PERSISTENCE_EMBEDDINGS=openai
OPENAI_API_KEY=your-openai-api-key
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mem-persistence/dist/index.js", "--workspace", "/path/to/workspace"],
      "env": {
        "MEM_PERSISTENCE_EMBEDDINGS": "gemini",
        "GOOGLE_API_KEY": "your-key"
      }
    }
  }
}
```

Without `MEM_PERSISTENCE_EMBEDDINGS`, search uses token matching only (no API calls, works offline).

With embeddings enabled:
- **Hybrid scoring**: 0.4 × token score + 0.6 × vector score
- **Disk cache**: embeddings cached in `.mem-persistence/embeddings/` — subsequent searches don't re-call the API
- **Default model**: `gemini-embedding-001` (free, 1500 req/min)
- **Fallback**: if the API fails, falls back to token-only search

### Other options

```bash
# Dedup threshold (default: 0.65)
MEM_PERSISTENCE_DEDUP_THRESHOLD=0.65

# Custom embedding model
MEM_PERSISTENCE_EMBEDDINGS_MODEL=text-embedding-3-large
```

## How Dedup Works

Before writing, mem-persistence checks if similar content already exists:

```
Input:  "GitHub configured with gh auth login, user emiliotorrens"
Match:  "gh auth login hecho — cuenta emiliotorrens, protocolo HTTPS"
Result: DUPLICATE (score: 0.90) — not written
```

Uses token similarity (Jaccard + containment), entity overlap (IDs, dates, versions), and segment comparison for dense multi-fact lines.

## Roadmap

- [x] Deduplication engine
- [x] Hybrid search (token + vector + MMR + temporal decay)
- [x] MCP server (stdio transport) — 6 tools, TypeScript + ESM
- [x] Embedding providers (Gemini free, OpenAI) with disk cache
- [x] Request/response logging (.mem-persistence/logs/)
- [ ] CLI (`mem-persistence search "query"`)
- [ ] Local embeddings via transformers.js
- [ ] npm publish

## Related

- **[layered-memstack](https://github.com/emiliotorrens/layered-memstack)** — OpenClaw skill that sets up a complete 3-layer memory system with automated crons, dedup, knowledge graph, and weekly audits. Uses mem-persistence as the MCP bridge.

## Inspiration & Credits

- **[Signet AI](https://github.com/Signet-AI/signetai)** — inspiration for markdown-first agent memory
- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework where this was born and battle-tested
- **[MCP](https://modelcontextprotocol.io)** — the protocol that makes cross-agent memory possible

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).
