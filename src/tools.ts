/**
 * MCP tool definitions: name, description, Zod input schema and handler.
 *
 * Handlers contain only tool logic and are free to throw; error formatting
 * and routing live in index.ts. Each tool's arguments are parsed with its
 * own Zod schema, so handlers receive fully typed, defaulted values.
 */
import { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserManager } from "./browser.js";

/** A tool as seen by the router: schema metadata plus an untyped entry point. */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Validates raw arguments against `inputSchema`, then runs the handler. */
  run(rawArgs: unknown, browser: BrowserManager): Promise<CallToolResult>;
}

interface ToolDefinition<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(args: z.output<z.ZodObject<S>>, browser: BrowserManager): Promise<CallToolResult>;
}

/** Binds a typed handler to its schema and erases the generic for the router. */
function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): Tool {
  const schema = z.object(def.inputSchema);
  const { handler, ...meta } = def;
  return {
    ...meta,
    run: async (rawArgs, browser) => handler(schema.parse(rawArgs ?? {}), browser),
  };
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

/** Thrown by assert_* tools; the router turns it into an isError result. */
class AssertionFailed extends Error {
  constructor(message: string) {
    super(`ASSERTION FAILED: ${message}`);
    this.name = "AssertionFailed";
  }
}

/** Screenshots larger than this are saved but not sent back inline. */
const MAX_INLINE_IMAGE_BYTES = 1_000_000;

// -----------------------------------------------------------------------------
// Shared parameter schemas
// -----------------------------------------------------------------------------

const SELECTOR_HELP =
  'Selector: "aria-ref=e5" from get_page_snapshot (preferred; also reaches into iframes), CSS ("#email", ' +
  '"button.submit"), text ("text=Sign in"), role ("role=button[name=/save/i]") or XPath ("xpath=//a")';

const selector = z.string().min(1).describe(SELECTOR_HELP);

const frame = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .describe(
    'CSS selector of the iframe containing the element (e.g. "iframe[name^=__privateStripeFrame]"), ' +
      "or a list for nested iframes, outermost first. Not needed with aria-ref selectors.",
  );

const label = z
  .string()
  .max(120)
  .optional()
  .describe('Name for this check in the test report, e.g. "Login shows welcome message"');

const timeout = (ms: number) =>
  z.number().int().positive().max(120_000).default(ms).describe("Timeout in milliseconds");

// -----------------------------------------------------------------------------
// Navigation & inspection
// -----------------------------------------------------------------------------

const navigateUrl = defineTool({
  name: "navigate_url",
  title: "Navigate to URL",
  description:
    "Navigate the active browser page to a URL. Returns the HTTP status code, final URL and page title. " +
    "Resets the console and network logs.",
  inputSchema: {
    url: z.url({ protocol: /^(https?|file)$/ }).describe("Absolute URL to open (http, https or file)"),
    waitUntil: z
      .enum(["domcontentloaded", "networkidle", "load"])
      .default("domcontentloaded")
      .describe('Load state to wait for. "networkidle" can hang on pages that keep requests open'),
    timeout: timeout(30_000),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ url, waitUntil, timeout: ms }, browser) {
    return json(await browser.navigate(url, waitUntil, ms));
  },
});

const getPageSnapshot = defineTool({
  name: "get_page_snapshot",
  title: "Get page snapshot",
  description:
    "Return the page's accessibility tree as YAML: roles, accessible names, values and states, including " +
    "iframe contents. Every element has a [ref=eN] handle; pass it to other tools as selector \"aria-ref=eN\". " +
    "Use this before interacting with a page instead of guessing selectors. Refs from older snapshots may go stale.",
  inputSchema: {
    selector: z.string().min(1).optional().describe("Only snapshot this element's subtree"),
    depth: z.number().int().positive().max(50).optional().describe("Limit tree depth"),
    maxLength: z.number().int().positive().default(30_000).describe("Truncate output beyond this many characters"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ selector: scope, depth, maxLength }, browser) {
    const result = await browser.snapshot(scope, depth);
    const truncated = result.snapshot.length > maxLength;
    return text(
      `Page: ${result.title}\nURL: ${result.url}\n\n` +
        (truncated
          ? `${result.snapshot.slice(0, maxLength)}\n… [truncated ${result.snapshot.length - maxLength} characters; use selector or depth to narrow]`
          : result.snapshot),
    );
  },
});

const takeScreenshot = defineTool({
  name: "take_screenshot",
  title: "Take screenshot",
  description:
    "Capture a PNG of the current page (full scrollable page or just the viewport) and save it to the " +
    "screenshot directory. Returns the file path and, unless returnImage is false or the image is very " +
    "large, the image itself.",
  inputSchema: {
    filename: z.string().default("screenshot.png").describe("File name; saved inside the screenshot directory"),
    fullPage: z.boolean().default(true).describe("Capture the full scrollable page instead of the viewport"),
    returnImage: z.boolean().default(true).describe("Include the image in the response (false saves context)"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler({ filename, fullPage, returnImage }, browser) {
    const shot = await browser.screenshot(filename, fullPage);
    const kb = Math.round(shot.data.length / 1024);
    if (!returnImage) return text(`Saved screenshot to ${shot.path} (${kb} KB)`);
    if (shot.data.length > MAX_INLINE_IMAGE_BYTES) {
      return text(
        `Saved screenshot to ${shot.path} (${kb} KB). Image not returned inline because it exceeds ` +
          `${MAX_INLINE_IMAGE_BYTES / 1_000_000} MB; take a viewport screenshot (fullPage: false) to view it.`,
      );
    }
    return {
      content: [
        { type: "text", text: `Saved screenshot to ${shot.path} (${kb} KB)` },
        { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" },
      ],
    };
  },
});

const getConsoleErrors = defineTool({
  name: "get_console_errors",
  title: "Get console errors",
  description:
    "Return JavaScript console errors, uncaught exceptions, failed network requests, HTTP >= 400 responses " +
    "and guard blocks recorded since the last navigate_url. Chrome's duplicate \"Failed to load resource\" " +
    "messages are merged into the matching network entry.",
  inputSchema: {
    firstPartyOnly: z
      .boolean()
      .default(false)
      .describe("Hide entries whose URL belongs to another site (analytics, ads, CDNs)"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ firstPartyOnly }, browser) {
    const { pageUrl, diagnostics, hiddenDuplicates, hiddenThirdParty } = browser.getDiagnostics(firstPartyOnly);
    const counts: Record<string, number> = {};
    for (const entry of diagnostics) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    return json({ pageUrl, total: diagnostics.length, counts, hiddenDuplicates, hiddenThirdParty, diagnostics });
  },
});

const getNetworkRequests = defineTool({
  name: "get_network_requests",
  title: "Get network requests",
  description:
    "List HTTP requests made by the page since the last navigate_url: method, URL, resource type, status, " +
    "duration, failure reason and whether a mock answered it. Static assets are hidden by default.",
  inputSchema: {
    urlContains: z.string().optional().describe('Only requests whose URL contains this text, e.g. "/api/"'),
    resourceTypes: z
      .array(z.enum(["document", "xhr", "fetch", "script", "stylesheet", "image", "font", "media", "websocket", "manifest", "other"]))
      .optional()
      .describe("Only these resource types (overrides includeStatic)"),
    failedOnly: z.boolean().default(false).describe("Only failed requests and HTTP >= 400"),
    includeStatic: z.boolean().default(false).describe("Include images, fonts, stylesheets and media"),
    limit: z.number().int().positive().max(1000).default(100).describe("Return at most this many (most recent)"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ urlContains, resourceTypes, failedOnly, includeStatic, limit }, browser) {
    return json(
      browser.getNetworkRequests({
        ...(urlContains !== undefined ? { urlContains } : {}),
        ...(resourceTypes !== undefined ? { resourceTypes } : {}),
        failedOnly,
        includeStatic,
        limit,
      }),
    );
  },
});

// -----------------------------------------------------------------------------
// Interaction
// -----------------------------------------------------------------------------

const clickElement = defineTool({
  name: "click_element",
  title: "Click element",
  description:
    "Click the first element matching a selector. Waits for any navigation the click triggers. " +
    'Note "text=" is a case-insensitive substring match against any element (headings included); prefer ' +
    'aria-ref from get_page_snapshot or scoped selectors like button:has-text("Login").',
  inputSchema: { selector, frame, timeout: timeout(5000) },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ selector: target, frame: framePath, timeout: ms }, browser) {
    const result = await browser.click(target, framePath, ms);
    return text(`Clicked "${target}"` + (result.navigated ? `; page navigated to ${result.url}` : ""));
  },
});

const fillInput = defineTool({
  name: "fill_input",
  title: "Fill input",
  description:
    "Clear an input, textarea or contenteditable element and fill it with text. Values typed into password " +
    "and payment-card fields are masked in recordings. Card fields are refused if the page uses a LIVE " +
    "payment environment; use the provider's test mode and test cards (e.g. Stripe 4242 4242 4242 4242).",
  inputSchema: {
    selector,
    text: z.string().describe("Text to enter (an empty string just clears the field)"),
    frame,
    timeout: timeout(5000),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ selector: target, text: value, frame: framePath, timeout: ms }, browser) {
    const result = await browser.fill(target, framePath, value, ms);
    return text(`Filled "${target}" with ${value.length} character(s)${result.masked ? " (sensitive field, masked in recordings)" : ""}`);
  },
});

const selectOption = defineTool({
  name: "select_option",
  title: "Select option",
  description: "Choose option(s) in a <select> element, matching each by its value or its visible label.",
  inputSchema: {
    selector,
    options: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe("Option value/label, or several for a multi-select"),
    frame,
    timeout: timeout(5000),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ selector: target, options, frame: framePath, timeout: ms }, browser) {
    const selected = await browser.selectOption(target, framePath, Array.isArray(options) ? options : [options], ms);
    return text(`Selected ${JSON.stringify(selected)} in "${target}"`);
  },
});

const pressKey = defineTool({
  name: "press_key",
  title: "Press key",
  description:
    'Press a key or chord, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+A". Focuses the element ' +
    "first when a selector is given, otherwise sends it to whatever has focus. Waits for any navigation it triggers.",
  inputSchema: {
    key: z.string().min(1).describe("Key name as used by Playwright keyboard.press"),
    selector: selector.optional(),
    frame,
    timeout: timeout(5000),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ key, selector: target, frame: framePath, timeout: ms }, browser) {
    const result = await browser.pressKey(key, target, framePath, ms);
    return text(
      `Pressed ${key}${target ? ` on "${target}"` : ""}` + (result.navigated ? `; page navigated to ${result.url}` : ""),
    );
  },
});

const hoverElement = defineTool({
  name: "hover_element",
  title: "Hover element",
  description: "Move the mouse over an element, e.g. to open a dropdown menu or reveal a tooltip.",
  inputSchema: { selector, frame, timeout: timeout(5000) },
  annotations: { readOnlyHint: false, openWorldHint: true },
  async handler({ selector: target, frame: framePath, timeout: ms }, browser) {
    await browser.hover(target, framePath, ms);
    return text(`Hovering over "${target}"`);
  },
});

const waitFor = defineTool({
  name: "wait_for",
  title: "Wait for",
  description:
    "Wait until an element (by selector) or a piece of visible text reaches a state: visible (default), " +
    "hidden, attached or detached. Useful after actions that load content asynchronously.",
  inputSchema: {
    selector: selector.optional(),
    text: z.string().min(1).optional().describe("Visible text to wait for (substring match)"),
    state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
    frame,
    timeout: timeout(10_000),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ selector: target, text: label, state, frame: framePath, timeout: ms }, browser) {
    if (!target === !label) throw new Error("Provide exactly one of selector or text.");
    await browser.waitFor(target ? { selector: target } : { text: label! }, framePath, state, ms);
    return text(`${target ? `"${target}"` : `Text "${label}"`} is ${state}`);
  },
});

// -----------------------------------------------------------------------------
// Assertions: PASS returns normally, FAIL returns isError with details
// -----------------------------------------------------------------------------

const assertText = defineTool({
  name: "assert_text",
  title: "Assert text",
  description:
    "Test assertion: PASS if the text is visible on the page (or inside the element matched by selector) " +
    "within the timeout, otherwise FAIL (isError) with the text that was actually there.",
  inputSchema: {
    text: z.string().min(1).describe("Expected text"),
    selector: selector.optional(),
    exact: z.boolean().default(false).describe("Require the whole text to match instead of a substring"),
    label,
    frame,
    timeout: timeout(5000),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ text: expected, selector: target, exact, label: name, frame: framePath, timeout: ms }, browser) {
    const where = target ? `in "${target}"` : "on the page";
    const result = await browser.assertText(expected, target, framePath, exact, ms);
    if (!result.passed) {
      throw new AssertionFailed(
        `${name ? `"${name}": ` : ""}expected ${exact ? "exact " : ""}text "${expected}" ${where}, but it was not found within ${ms} ms.` +
          (result.actual !== undefined ? `\nActual text ${where}:\n${result.actual}` : ""),
      );
    }
    return text(`PASS: ${name ? `${name}: ` : ""}text "${expected}" is visible ${where}`);
  },
});

const assertVisible = defineTool({
  name: "assert_visible",
  title: "Assert visible",
  description:
    "Test assertion: PASS if the element is visible (or, with visible=false, hidden/absent) within the " +
    "timeout, otherwise FAIL (isError).",
  inputSchema: {
    selector,
    visible: z.boolean().default(true).describe("false asserts the element is hidden or absent"),
    label,
    frame,
    timeout: timeout(5000),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ selector: target, visible, label: name, frame: framePath, timeout: ms }, browser) {
    const ok = await browser.assertVisible(target, framePath, visible, ms);
    if (!ok) {
      throw new AssertionFailed(
        `${name ? `"${name}": ` : ""}expected "${target}" to be ${visible ? "visible" : "hidden"}, but it ` +
          `${visible ? "did not appear" : "was still visible"} within ${ms} ms.`,
      );
    }
    return text(`PASS: ${name ? `${name}: ` : ""}"${target}" is ${visible ? "visible" : "hidden"}`);
  },
});

// -----------------------------------------------------------------------------
// Network mocking
// -----------------------------------------------------------------------------

const mockRoute = defineTool({
  name: "mock_route",
  title: "Mock network route",
  description:
    "Intercept browser requests matching a URL glob and answer them with a canned response, an error, or a " +
    "delay, without contacting the real server. Tests UI behavior for API errors, payment declines, timeouts " +
    "and outages. Only the browser sees the mock; no backend is contacted. Mocks persist until clear_mocks.",
  inputSchema: {
    urlPattern: z.string().min(1).describe('Glob matched against the full URL, e.g. "**/api/checkout*" or "https://api.example.com/v1/**"'),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("Only mock this HTTP method"),
    status: z.number().int().min(100).max(599).default(200).describe("HTTP status to return"),
    json: z.any().optional().describe("JSON body (sets content-type application/json)"),
    body: z.string().optional().describe("Raw body text (ignored when json is given)"),
    contentType: z.string().optional().describe("Content-Type for a raw body (default text/plain)"),
    headers: z.record(z.string(), z.string()).default({}).describe("Extra response headers"),
    abort: z
      .enum(["failed", "aborted", "timedout", "connectionrefused", "connectionreset", "internetdisconnected", "namenotresolved"])
      .optional()
      .describe("Fail the request with this network error instead of responding"),
    delayMs: z.number().int().min(0).max(60_000).default(0).describe("Delay before responding"),
    times: z.number().int().positive().optional().describe("Only mock the first N matching requests"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler(args, browser) {
    const hasJson = args.json !== undefined;
    const mock = await browser.addMock({
      urlPattern: args.urlPattern,
      ...(args.method ? { method: args.method } : {}),
      status: args.status,
      body: hasJson ? JSON.stringify(args.json) : (args.body ?? ""),
      contentType: hasJson ? "application/json" : (args.contentType ?? "text/plain"),
      headers: args.headers,
      ...(args.abort ? { abort: args.abort } : {}),
      delayMs: args.delayMs,
      ...(args.times !== undefined ? { times: args.times } : {}),
    });
    return json({ added: mock.id, activeMocks: browser.listMocks() });
  },
});

const clearMocks = defineTool({
  name: "clear_mocks",
  title: "Clear mocks",
  description: "Remove one mock by id, or all mocks when no id is given. Returns the mocks still active and their hit counts.",
  inputSchema: {
    id: z.string().optional().describe('Mock id returned by mock_route, e.g. "mock-1"'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler({ id }, browser) {
    return json(await browser.clearMocks(id));
  },
});

// -----------------------------------------------------------------------------
// Recording
// -----------------------------------------------------------------------------

const startRecording = defineTool({
  name: "start_recording",
  title: "Start recording",
  description:
    "Start recording the browser session for later review by a developer: a Playwright trace " +
    "(DOM snapshots, network, console for every step), an optional video, and a log of every tool call. " +
    "With video on, the page is reloaded into a fresh recording context (cookies and localStorage are kept). " +
    "Call stop_recording when done to save everything.",
  inputSchema: {
    name: z.string().max(80).default("session").describe('Short label for the recording, e.g. "login flow"'),
    video: z.boolean().default(true).describe("Also capture a .webm screen recording"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler({ name, video }, browser) {
    const recording = await browser.startRecording(name, video);
    return text(`Recording "${recording.name}" started (video=${recording.video}). Output folder: ${recording.dir}`);
  },
});

const stopRecording = defineTool({
  name: "stop_recording",
  title: "Stop recording",
  description:
    "Stop the active recording and save its trace.zip, video, screenshots, actions.json and an " +
    "HTML report. Returns the overall verdict, the failed checks and errored steps with explanations, " +
    "the number of website errors, the file paths and the command to open the trace viewer. " +
    "If anything failed, follow up with suggest_fix for each failed step. When email delivery is configured, " +
    "the report is emailed to the configured recipients once every failure has a suggested fix (see delivery in the result).",
  inputSchema: {},
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler(_args, browser) {
    return json(await browser.stopRecording());
  },
});

const suggestFix = defineTool({
  name: "suggest_fix",
  title: "Suggest a fix",
  description:
    "Add your suggested fix for a failed step to the recording's report, shown in the \"AI agent's suggested fix\" column. " +
    "Use the step numbers from stop_recording (failedChecks / toolErrors) or from failed tool calls during the recording. " +
    "Diagnose the actual cause from the evidence (error explanation, actual page text, screenshot, console and network errors) " +
    "and give a concrete fix: name the selector, file, endpoint or setting to change. Say whether the fix belongs in the app " +
    "(a real bug), the test (wrong selector or expectation) or the environment (server down, missing data). " +
    "Works during a recording or after stop_recording; calling it again for a step replaces the earlier suggestion.",
  inputSchema: {
    step: z.number().int().positive().describe("Step number of the failed check or tool call"),
    fix: z.string().min(1).max(2000).describe("The concrete fix to make"),
    cause: z.string().max(1000).optional().describe("Your diagnosis of the root cause"),
    target: z
      .enum(["app", "test", "environment"])
      .optional()
      .describe("Where the fix belongs: app (bug in the site), test (the test is wrong) or environment"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler({ step, fix, cause, target }, browser) {
    const result = await browser.suggestFix(step, { fix, ...(cause ? { cause } : {}), ...(target ? { target } : {}) });
    const remaining = result.withoutFix.length
      ? `Failures still without a suggested fix: steps ${result.withoutFix.join(", ")}.`
      : "Every failure now has a suggested fix.";
    const where = result.stopped ? `Report updated: ${result.report}` : "It will appear in the report when the recording is stopped.";
    return text(`Added suggested fix for step ${step} in "${result.recording}". ${remaining}\n${where}${result.email ? `\n${result.email}` : ""}`);
  },
});

/** Registration order is the order clients see in tools/list. */
export const tools: readonly Tool[] = [
  navigateUrl,
  getPageSnapshot,
  clickElement,
  fillInput,
  selectOption,
  pressKey,
  hoverElement,
  waitFor,
  takeScreenshot,
  assertText,
  assertVisible,
  getConsoleErrors,
  getNetworkRequests,
  mockRoute,
  clearMocks,
  startRecording,
  stopRecording,
  suggestFix,
];
