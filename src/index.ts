#!/usr/bin/env node
/**
 * Entry point: builds the MCP server, routes tool calls to the browser
 * manager, and serves over stdio.
 *
 * stdout carries the JSON-RPC stream, so every diagnostic goes to stderr.
 */
import { stripVTControlCharacters } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserManager } from "./browser.js";
import { tools, type Tool } from "./tools.js";

const SERVER_NAME = "argus-qa-mcp";
const SERVER_VERSION = "0.1.0";

function log(message: string): void {
  console.error(`[argus] ${message}`);
}

/** Turns any thrown value into a readable message for the model. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid arguments:\n${z.prettifyError(error)}`;
  }
  if (error instanceof Error) {
    // Playwright errors include a multi-line call log; the first lines are the useful part.
    // Strip ANSI color codes Playwright adds to its call log.
    const lines = stripVTControlCharacters(error.message)
      .split("\n")
      .filter((line) => line.trim() !== "");
    return lines.slice(0, 8).join("\n");
  }
  return String(error);
}

/**
 * Router: runs a tool and converts any failure into an MCP tool error
 * (`isError: true`) so it never escapes as a protocol-level exception.
 */
async function routeToolCall(tool: Tool, args: unknown, browser: BrowserManager): Promise<CallToolResult> {
  const started = Date.now();
  let result: CallToolResult;
  try {
    // While recording, group this call's Playwright actions under the tool name in the trace.
    result = await browser.traceStep(tool.name, () => tool.run(args, browser));
    log(`${tool.name} ok (${Date.now() - started}ms)`);
  } catch (error) {
    const message = describeError(error);
    log(`${tool.name} failed (${Date.now() - started}ms): ${message.split("\n")[0]}`);
    result = {
      isError: true,
      content: [{ type: "text", text: `${tool.name} failed: ${message}` }],
    };
  }
  logToRecording(browser, tool, args, result, started);
  return result;
}

/** Appends the call to the active recording's action log (text output only, no image data). */
function logToRecording(
  browser: BrowserManager,
  tool: Tool,
  args: unknown,
  result: CallToolResult,
  started: number,
): void {
  const recording = browser.activeRecording;
  if (!recording) return;
  const textOutput = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  recording.logAction({
    tool: tool.name,
    args: args ?? {},
    ok: result.isError !== true,
    summary: textOutput.length > 600 ? `${textOutput.slice(0, 600)}…` : textOutput,
    startedAt: started,
    durationMs: Date.now() - started,
  });
}

async function main(): Promise<void> {
  const browser = BrowserManager.getInstance();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => routeToolCall(tool, args, browser),
    );
  }

  // Close Chromium when the client goes away so no orphaned browsers linger.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${reason})`);
    await browser.close();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));

  // Last-resort guards: log instead of letting the process die mid-session.
  process.on("unhandledRejection", (reason) => log(`Unhandled rejection: ${describeError(reason)}`));
  process.on("uncaughtException", (error) => log(`Uncaught exception: ${describeError(error)}`));

  await server.connect(new StdioServerTransport());
  log(
    `${SERVER_NAME} v${SERVER_VERSION} running on stdio ` +
      `(headless=${browser.headless}, screenshots=${browser.screenshotDir})`,
  );
}

main().catch((error: unknown) => {
  log(`Fatal startup error: ${describeError(error)}`);
  process.exit(1);
});
