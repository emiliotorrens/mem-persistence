# mem-persistence

> 🧠 Persistent memory MCP server for AI agents — one memory, every agent, your files.

mem-persistence lets Claude Desktop, Claude Code, Cursor, Zed, and any MCP-compatible client share the same persistent memory, backed by plain Markdown files you own and can edit by hand.

## Why?

AI agents have amnesia. Each tool keeps its own silo — Claude Code forgets what OpenClaw knows, Cursor can't recall what you told Claude yesterday. Your context is scattered across sessions that evaporate.

mem-persistence fixes this:

- **Markdown is the source of truth** — not a database, not a binary blob. Files you can read, edit, and version with git.
- **Hybrid search** — token matching + semantic embeddings for accurate recall.
- **Embedding providers** — Gemini (free), OpenAI, or none (token-only). Cached to disk.
- **Deduplication** — prevents writing the same fact twice (token + entity overlap detection).
- **Works offline** — no cloud dependency. Embeddings are optional.

## MCP Tools

| Tool | Description |
|---|---|
| `memory_search(query, maxResults?)` | Hybrid search across all `.md` files |
| `memory_write(content, file?, section?)` | Write with automatic deduplication |
| `memory_read(path, from?, lines?)` | Read a specific file or section |
| `memory_checkpoint(summary)` | Save a session checkpoint to a daily note |
| `memory_entities(query?)` | Query the knowledge graph (if `entities.md` exists) |
| `memory_status()` | Index stats: files, chunks, last sync |

---

## Installation

```bash
# From source (npm publish coming soon)
git clone https://github.com/emiliotorrens/mem-persistence.git
cd mem-persistence
npm install
npm run build
```

---

## Quick Start

**1. Start the server**

```bash
node dist/index.js --workspace /path/to/your/workspace --port 3456
```

**2. Point your client to it** — add to Claude Desktop config:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3456/mem-persistence/mcp"
    }
  }
}
```

**3. Add agent instructions** so the agent uses memory proactively:

Copy [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) into:

| Editor | Where to paste |
|---|---|
| Claude Desktop | Settings → Personal Preferences |
| Claude Code | `CLAUDE.md` in project root |
| Cursor | `.cursorrules` in project root |
| Windsurf | `.windsurfrules` in project root |

Done. The agent will now search memory before answering and write important facts automatically.

---

## Workspace

The `--workspace` flag points to the directory where your memory files live. mem-persistence indexes all `.md` files it finds there recursively.

**Works with any directory containing `.md` files.** No specific structure required. That said, search quality improves with a layered layout:

| Layer | Path | Purpose |
|---|---|---|
| L1 | `MEMORY.md` | Long-term curated memory — highest search priority |
| L2 | `memory/*.md` | Daily notes, recent context |
| L3 | `reference/*.md` | Detailed data, historical records |

If you want this structure set up automatically (with crons, dedup, and knowledge graph), see [layered-memstack](https://github.com/emiliotorrens/layered-memstack).

You can also set the workspace via environment variable instead of the flag:

```bash
MEM_PERSISTENCE_WORKSPACE=/path/to/your/workspace
```

---

## Deployment

### HTTP mode (recommended)

Run the server **once** as a persistent background service. All clients — local and remote — connect via URL. No API keys in client configs, no new process per window.

```bash
# 1. Install pm2
npm install -g pm2

# 2. Copy and edit the config template
cp ecosystem.config.cjs.example ecosystem.config.cjs
# → Set your workspace path and optional API keys (see Embeddings section)

# 3. Start and persist
pm2 start ecosystem.config.cjs
pm2 save       # save process list
pm2 startup    # autostart on system reboot (follow the printed instructions)
```

All clients use the same URL:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3456/mem-persistence/mcp"
    }
  }
}
```

Health check: `curl http://127.0.0.1:3456/health`

### stdio mode

Claude Desktop spawns the server on demand. Easier to start with, but requires API keys in every client config and spawns a new process per window.

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/path/to/mem-persistence/dist/index.js",
        "--workspace", "/path/to/your/workspace"
      ],
      "env": {
        "MEM_PERSISTENCE_EMBEDDINGS": "gemini",
        "GOOGLE_API_KEY": "your-key-here"
      }
    }
  }
}
```

> **WSL users (Windows):** replace `"command": "node"` with `"command": "wsl"` and add `"node"` as the first element of `args`.

### Remote access via Tailscale

Access the same memory from a laptop, tablet, or any other machine using Tailscale or a private VPN.

> ⚠️ **Security:** mem-persistence has no built-in authentication. **Never expose the port to the public internet.** Always use Tailscale, a VPN, or a firewall rule to restrict access.

In `ecosystem.config.cjs`, change `--host 127.0.0.1` to `--host 0.0.0.0` to listen on all interfaces. Then on the remote machine:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://my-machine.tail1234.ts.net:3456/mem-persistence/mcp"
    }
  }
}
```

No API keys, no paths, no wsl. Just the URL. Embeddings are handled by the server.

---

## Embeddings (optional — but recommended)

By default, search uses **token matching only** (Jaccard + containment + entity overlap). No API calls, works offline, good for keyword queries.

Enabling embeddings adds **semantic understanding** on top:

| Query | Token-only | With embeddings |
|---|---|---|
| `"mem-persistence GitHub"` | ✅ keyword match | ✅ higher confidence |
| `"where does Emilio work"` | ❌ no keyword overlap | ✅ understands meaning |
| `"what trips are coming up?"` | ❌ misses if phrased differently | ✅ matches semantically |
| API calls needed | Never | Only for new content (cached after first call) |
| Works offline | ✅ always | ✅ after first run |

**Get a free Gemini API key** → [aistudio.google.com](https://aistudio.google.com) → Get API key.

Set in `ecosystem.config.cjs` (HTTP mode) or as env vars (stdio mode):

```bash
MEM_PERSISTENCE_EMBEDDINGS=gemini    # "gemini" or "openai"
GOOGLE_API_KEY=your-key              # Gemini — free
OPENAI_API_KEY=your-key              # OpenAI — $0.02/M tokens
```

Details:
- **Hybrid scoring**: 0.4 × token + 0.6 × vector
- **Disk cache**: stored in `.mem-persistence/embeddings/` — no repeated API calls for the same content
- **Default model**: `gemini-embedding-001` (free, 1500 req/min)
- **Silent fallback**: if the API is unavailable, falls back to token-only automatically

---

## Deduplication

Before writing, mem-persistence checks if similar content already exists:

```
Input:  "GitHub configured with gh auth login, user emiliotorrens"
Match:  "gh auth login hecho — cuenta emiliotorrens, protocolo HTTPS"
Result: DUPLICATE (score: 0.90) — not written
```

Uses token similarity (Jaccard + containment) and entity overlap (IDs, dates, versions, URLs).

Adjust the threshold: `MEM_PERSISTENCE_DEDUP_THRESHOLD=0.65` (default — lower = stricter).

---

## Roadmap

- [x] Deduplication engine
- [x] Hybrid search (token + vector + MMR + temporal decay)
- [x] MCP server — stdio and HTTP transports, 6 tools, TypeScript + ESM
- [x] Embedding providers: Gemini (free) and OpenAI, with disk cache
- [x] Request/response logging (`.mem-persistence/logs/`)
- [x] HTTP mode — Tailscale-friendly, pm2-ready
- [ ] CLI (`mem-persistence search "query"`)
- [ ] Local embeddings via transformers.js (offline, no API key)
- [ ] npm publish

---

## Related

- **[layered-memstack](https://github.com/emiliotorrens/layered-memstack)** — OpenClaw skill that sets up a 3-layer memory system with automated crons, dedup, and knowledge graph. Uses mem-persistence as the MCP bridge.

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework where this was born and battle-tested
- **[MCP](https://modelcontextprotocol.io)** — the protocol that makes cross-agent memory possible

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).
