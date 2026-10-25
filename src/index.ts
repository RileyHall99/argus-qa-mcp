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
import { explainError, type ErrorExplanation } from "./errors.js";
import { tools, type Tool } from "./tools.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

function log(message: string): void {
  console.error(`[argus] ${message}`);
}

/** Full message of any thrown value, without the ANSI colors Playwright adds. */
function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid arguments: ${z.prettifyError(error)}`;
  }
  return stripVTControlCharacters(error instanceof Error ? error.message : String(error)).trim();
}

/**
 * Formats a failure for the model: plain-language headline, explanation and
 * suggestion first, then the start of Playwright's call log for reference.
 */
function formatError(toolName: string, explained: ErrorExplanation, message: string): string {
  const lines = [`${toolName} failed: ${explained.title}`, explained.explanation];
  if (explained.suggestion) lines.push(`Suggestion: ${explained.suggestion}`);
  // The raw message adds nothing for single-line errors, which the explanation already restates.
  if (message.includes("\n") && explained.title !== "Assertion failed") {
    const details = message.split("\n").filter((line) => line.trim() !== "").slice(0, 8);
    lines.push("", "Details:", ...details);
  }
  return lines.join("\n");
}

/**
 * Router: runs a tool and converts any failure into an MCP tool error
 * (`isError: true`) so it never escapes as a protocol-level exception.
 */
async function routeToolCall(tool: Tool, args: unknown, browser: BrowserManager): Promise<CallToolResult> {
  const started = Date.now();
  let result: CallToolResult;
  let explained: ErrorExplanation | undefined;
  try {
    // While recording, group this call's Playwright actions under the tool name in the trace.
    result = await browser.traceStep(tool.name, () => tool.run(args, browser));
    log(`${tool.name} ok (${Date.now() - started}ms)`);
  } catch (error) {
    const message = errorMessage(error);
    explained = explainError(message);
    log(`${tool.name} failed (${Date.now() - started}ms): ${explained.title}: ${explained.explanation}`);
    result = {
      isError: true,
      content: [{ type: "text", text: formatError(tool.name, explained, message) }],
    };
  }
  await logToRecording(browser, tool, args, result, started, explained);
  return result;
}

/** Failures that are about the request rather than the page; a screenshot would show nothing useful. */
const NON_PAGE_ERRORS = new Set(["Invalid request", "Invalid arguments", "Browser not available"]);

/**
 * Appends the call to the active recording's action log (text output only,
 * no image data). A failed call also gets a screenshot of the page as it
 * was when it failed, for the report.
 */
async function logToRecording(
  browser: BrowserManager,
  tool: Tool,
  args: unknown,
  result: CallToolResult,
  started: number,
  error: ErrorExplanation | undefined,
): Promise<void> {
  const recording = browser.activeRecording;
  if (!recording) return;
  // Taken before the screenshot so the video timestamp points at the failure, not after it.
  const finished = Date.now();
  const failureScreenshot = error && !NON_PAGE_ERRORS.has(error.title) ? await browser.captureFailureScreenshot() : undefined;
  const textOutput = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const pageUrl = browser.currentUrl;
  const pageTitle = pageUrl ? await browser.currentTitle() : undefined;
  recording.logAction({
    tool: tool.name,
    args: args ?? {},
    ok: result.isError !== true,
    summary: textOutput.length > 600 ? `${textOutput.slice(0, 600)}…` : textOutput,
    startedAt: started,
    durationMs: finished - started,
    ...(error ? { error } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(failureScreenshot ? { failureScreenshot } : {}),
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
  process.on("unhandledRejection", (reason) => log(`Unhandled rejection: ${errorMessage(reason)}`));
  process.on("uncaughtException", (error) => log(`Uncaught exception: ${errorMessage(error)}`));

  await server.connect(new StdioServerTransport());
  log(
    `${SERVER_NAME} v${SERVER_VERSION} running on stdio ` +
      `(headless=${browser.headless}, screenshots=${browser.screenshotDir})`,
  );
}

main().catch((error: unknown) => {
  log(`Fatal startup error: ${errorMessage(error)}`);
  process.exit(1);
});
