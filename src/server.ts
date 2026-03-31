/**
 * server.ts — MCP Server exposing memory tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as memory from "./memory.js";

export function createServer(config: memory.MemoryConfig): McpServer {
  const server = new McpServer({
    name: "mem-persistence",
    version: "0.1.0",
  });

  // ─── memory_search ──────────────────────────────────────────────────────

  server.tool(
    "memory_search",
    "Search across all memory layers (L1 core, L2 topics/dailies, L3 references) with token-based ranking and temporal decay for recent notes.",
    {
      query: z.string().describe("Search query text"),
      maxResults: z
        .number()
        .optional()
        .describe("Max results to return (default: 20)"),
      layers: z
        .array(z.enum(["L1", "L2", "L3"]))
        .optional()
        .describe("Filter by layers (default: all)"),
    },
    async ({ query, maxResults, layers }) => {
      const results = await memory.search(query, config, {
        maxResults,
        layers,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  // ─── memory_read ────────────────────────────────────────────────────────

  server.tool(
    "memory_read",
    "Read a specific memory file by path (relative to workspace). Supports line range filtering.",
    {
      path: z
        .string()
        .describe("File path relative to workspace (e.g. 'MEMORY.md', 'memory/2026-03-31.md')"),
      startLine: z.number().optional().describe("Start line (1-indexed)"),
      endLine: z.number().optional().describe("End line (inclusive)"),
    },
    async ({ path, startLine, endLine }) => {
      try {
        const result = await memory.read(path, config, { startLine, endLine });
        return {
          content: [
            {
              type: "text" as const,
              text: `[${result.layer}] ${path} (${result.lines} lines)\n\n${result.content}`,
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── memory_write ───────────────────────────────────────────────────────

  server.tool(
    "memory_write",
    "Write content to a memory file. Automatically checks for duplicates when writing to MEMORY.md. Use append mode to add to existing files.",
    {
      path: z
        .string()
        .describe("File path relative to workspace"),
      content: z.string().describe("Content to write"),
      append: z
        .boolean()
        .optional()
        .describe("Append to existing file (default: false)"),
      dedupCheck: z
        .boolean()
        .optional()
        .describe("Check for duplicates against MEMORY.md (default: true)"),
    },
    async ({ path, content, append, dedupCheck }) => {
      try {
        const result = await memory.write(path, content, config, {
          append,
          dedupCheck,
        });
        const msg = result.written
          ? `✅ Written to ${result.path}`
          : `⏭️ Nothing written (all content was duplicate)`;
        const filteredMsg =
          result.filtered.length > 0
            ? `\nFiltered ${result.filtered.length} duplicate(s):\n${result.filtered.map((f) => `  - ${f}`).join("\n")}`
            : "";
        return {
          content: [{ type: "text" as const, text: msg + filteredMsg }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // ─── memory_checkpoint ──────────────────────────────────────────────────

  server.tool(
    "memory_checkpoint",
    "Save a context checkpoint to today's daily note (memory/YYYY-MM-DD.md). Use for preserving important context during long sessions.",
    {
      content: z
        .string()
        .describe("Checkpoint content (decisions, actions, facts, pending items)"),
    },
    async ({ content }) => {
      const result = await memory.checkpoint(content, config);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Checkpoint saved to ${result.path}`,
          },
        ],
      };
    }
  );

  // ─── memory_entities ────────────────────────────────────────────────────

  server.tool(
    "memory_entities",
    "Read or update the knowledge graph (reference/entities.md). Lists entity sections or retrieves/updates a specific section.",
    {
      section: z
        .string()
        .optional()
        .describe("Section name to read/update (e.g. 'Personas', 'Proyectos')"),
      update: z
        .string()
        .optional()
        .describe("Content to append to the section (requires section)"),
    },
    async ({ section, update }) => {
      const result = await memory.entities(config, { section, update });
      return {
        content: [
          {
            type: "text" as const,
            text: update
              ? `✅ Updated section "${section}"\n\n${result.content}`
              : result.content,
          },
        ],
      };
    }
  );

  // ─── memory_status ──────────────────────────────────────────────────────

  server.tool(
    "memory_status",
    "Get an overview of the memory system: file counts, line counts, last daily note, entities sections.",
    {},
    async () => {
      const s = await memory.status(config);
      const text = [
        `📁 Workspace: ${s.workspace}`,
        `📝 Core (${s.coreFile.exists ? `${s.coreFile.lines} lines, ${s.coreFile.sizeBytes} bytes` : "not found"})`,
        `📂 Memory: ${s.memoryDir.files} files, ${s.memoryDir.totalLines} lines`,
        `📚 Reference: ${s.referenceDir.files} files, ${s.referenceDir.totalLines} lines`,
        `🕸️ Entities: ${s.entitiesFile.exists ? `${s.entitiesFile.sections} sections` : "not found"}`,
        `📅 Last daily note: ${s.lastDailyNote ?? "none"}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  return server;
}
