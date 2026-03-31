/**
 * index.ts — Entry point: start MCP server over stdio
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { defaultConfig } from "./memory.js";
import { resolve } from "path";

async function main() {
  // Parse --workspace from argv
  const args = process.argv.slice(2);
  let workspace = process.cwd();

  const wsIdx = args.indexOf("--workspace");
  if (wsIdx >= 0 && args[wsIdx + 1]) {
    workspace = resolve(args[wsIdx + 1]);
  }

  // Also check MEM_PERSISTENCE_WORKSPACE env var
  if (process.env.MEM_PERSISTENCE_WORKSPACE) {
    workspace = resolve(process.env.MEM_PERSISTENCE_WORKSPACE);
  }

  const config = defaultConfig(workspace);

  // Override config from env vars
  if (process.env.MEM_PERSISTENCE_DEDUP_THRESHOLD) {
    config.dedupThreshold = parseFloat(
      process.env.MEM_PERSISTENCE_DEDUP_THRESHOLD
    );
  }

  // Embedding config from env vars
  const embProvider = process.env.MEM_PERSISTENCE_EMBEDDINGS || "none";
  if (embProvider === "gemini" || embProvider === "openai") {
    config.embeddings = {
      provider: embProvider,
      apiKey:
        process.env.MEM_PERSISTENCE_EMBEDDINGS_API_KEY ||
        (embProvider === "gemini"
          ? process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
          : process.env.OPENAI_API_KEY),
      model: process.env.MEM_PERSISTENCE_EMBEDDINGS_MODEL,
    };
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
