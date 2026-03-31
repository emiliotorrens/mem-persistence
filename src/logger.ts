/**
 * logger.ts — Request/response logging for analysis
 *
 * Logs to workspace/.mem-persistence/logs/YYYY-MM-DD.jsonl
 * Each line is a JSON object with timestamp, tool, args, result, duration
 */

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface LogEntry {
  timestamp: string;
  tool: string;
  args: Record<string, unknown>;
  result?: {
    success: boolean;
    resultSize?: number;
    error?: string;
  };
  durationMs: number;
  clientInfo?: string;
}

let logDir: string | null = null;
let loggingEnabled = true;

export function initLogger(workspace: string, enabled = true) {
  logDir = join(workspace, ".mem-persistence", "logs");
  loggingEnabled = enabled;
}

export async function log(entry: LogEntry): Promise<void> {
  if (!loggingEnabled || !logDir) return;

  try {
    if (!existsSync(logDir)) {
      await mkdir(logDir, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const file = join(logDir, `${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // Silent fail — logging should never break the server
  }
}

/**
 * Wrap a tool handler with logging
 */
export function withLogging<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
): (args: T) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return async (args: T) => {
    const start = Date.now();
    try {
      const result = await handler(args);
      const totalSize = result.content.reduce((acc, c) => acc + (c.text?.length ?? 0), 0);

      await log({
        timestamp: new Date().toISOString(),
        tool: toolName,
        args: sanitizeArgs(args),
        result: {
          success: !result.isError,
          resultSize: totalSize,
        },
        durationMs: Date.now() - start,
      });

      return result;
    } catch (err: any) {
      await log({
        timestamp: new Date().toISOString(),
        tool: toolName,
        args: sanitizeArgs(args),
        result: {
          success: false,
          error: err.message,
        },
        durationMs: Date.now() - start,
      });
      throw err;
    }
  };
}

/**
 * Truncate large content args to avoid bloating logs
 */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + `... (${value.length} chars)`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
