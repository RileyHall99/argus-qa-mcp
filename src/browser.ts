/**
 * Playwright lifecycle manager.
 *
 * Owns exactly one Chromium Browser -> BrowserContext -> Page chain for the
 * lifetime of the MCP server process. Every tool goes through `getPage()`,
 * which lazily launches the browser and transparently rebuilds whatever part
 * of the chain has died (browser disconnected, context closed, page crashed).
 *
 * Each context gets the same routing stack, re-applied whenever a context is
 * rebuilt (Playwright runs the most recently added route first):
 *   1. user mocks (mock_route)        - may short-circuit before anything below
 *   2. payment guard                  - blocks live payment-provider traffic
 *   3. host allowlist (if configured) - blocks off-list top-level navigations
 *
 * All logging goes to stderr: stdout belongs to the MCP JSON-RPC stream.
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
} from "playwright";
import {
  HostAllowlist,
  containsLivePaymentKey,
  isPaymentProviderHost,
  livePaymentBlockReason,
  sameSite,
} from "./guards.js";
import { Recording, type RecordingSummary } from "./recorder.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type WaitUntil = "domcontentloaded" | "networkidle" | "load";
export type ElementState = "visible" | "hidden" | "attached" | "detached";

/** CSS selector(s) of the iframe(s) to enter, outermost first. */
export type FramePath = string | string[] | undefined;

/** Common surface of Page and FrameLocator used to find elements. */
interface LocatorScope {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
}

/** A single diagnostic captured from the page since the last navigation. */
export interface PageDiagnostic {
  type: "console_error" | "uncaught_exception" | "request_failed" | "http_error" | "blocked_by_guard";
  message: string;
  url?: string;
  timestamp: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure?: string;
  durationMs?: number;
  mocked?: string;
  startedAt: string;
}

export interface NavigationResult {
  url: string;
  status: number | null;
  title: string;
}

export interface ActionResult {
  navigated: boolean;
  url: string;
}

export interface MockDefinition {
  urlPattern: string;
  method?: string;
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  abort?: string;
  delayMs: number;
  times?: number;
}

interface ActiveMock extends MockDefinition {
  id: string;
  hits: number;
}

export interface FillResult {
  masked: boolean;
}

/** How long after an action to watch for a navigation it may have triggered. */
const NAVIGATION_GRACE_MS = 750;

const VIEWPORT = { width: 1280, height: 800 };

/** Hard caps so a noisy page can't grow the buffers without bound. */
const MAX_DIAGNOSTICS = 500;
const MAX_NETWORK_ENTRIES = 1000;

/** Static asset types hidden from get_network_requests unless asked for. */
const STATIC_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media", "manifest"]);

/**
 * Default home for screenshots and recordings. Not the package directory:
 * when run via npx that lives in npm's cache, where nobody would find them.
 */
const OUTPUT_ROOT = path.join(os.homedir(), "argus-qa");

/** Browser channels Playwright can use instead of its bundled Chromium. */
const BROWSER_CHANNELS = new Set(["chrome", "chrome-beta", "msedge", "msedge-beta"]);

function log(message: string): void {
  console.error(`[argus] ${message}`);
}

/** Parses an env flag; anything other than an explicit false-y value is true. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

export class BrowserManager {
  private static instance: BrowserManager | undefined;

  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  /** In-flight launch, so concurrent tool calls share one launch. */
  private pending: Promise<Page> | undefined;

  private diagnostics: PageDiagnostic[] = [];
  private network: NetworkEntry[] = [];
  private readonly networkByRequest = new WeakMap<Request, NetworkEntry>();

  private readonly mocks = new Map<string, ActiveMock>();
  /** One handler per mock, reused on every context so it can be unrouted precisely. */
  private readonly mockHandlers = new Map<string, (route: Route) => Promise<void>>();
  private nextMockId = 1;

  /** Set when the current document loads a live payment key or calls a live provider. */
  private livePaymentReason: string | undefined;

  /** Values typed into password/card fields; masked in recording logs. */
  private readonly secrets = new Set<string>();

  /** Active recording, if any; its options shape every new context. */
  private recording: Recording | undefined;
  /** ARGUS_RECORD auto-starts one recording per process, once. */
  private autoRecordPending = envFlag("ARGUS_RECORD", false);

  readonly headless = envFlag("ARGUS_HEADLESS", true);
  readonly allowlist = new HostAllowlist(process.env["ARGUS_ALLOWED_HOSTS"]);
  readonly screenshotDir = path.resolve(
    process.env["ARGUS_SCREENSHOT_DIR"] ?? path.join(OUTPUT_ROOT, "screenshots"),
  );
  readonly recordingsDir = path.resolve(
    process.env["ARGUS_RECORDINGS_DIR"] ?? path.join(OUTPUT_ROOT, "recordings"),
  );
  /** ARGUS_BROWSER_CHANNEL=chrome|msedge uses an installed browser instead of Playwright's Chromium. */
  readonly browserChannel = process.env["ARGUS_BROWSER_CHANNEL"]?.trim().toLowerCase() || undefined;

  private constructor() {}

  static getInstance(): BrowserManager {
    BrowserManager.instance ??= new BrowserManager();
    return BrowserManager.instance;
  }

  /**
   * Returns a live page, (re)creating the browser/context/page as needed.
   * This is the single auto-recovery point for the whole server.
   */
  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
      return this.page;
    }
    // Deduplicate concurrent recovery attempts.
    this.pending ??= this.ensurePage().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser?.isConnected()) {
      await this.launchBrowser();
    }
    if (this.autoRecordPending) {
      this.autoRecordPending = false;
      this.recording = await Recording.create(this.recordingsDir, "session", true, this.secrets);
      log(`Auto-recording to ${this.recording.dir}`);
    }
    this.context ??= await this.createContext();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.attachPageListeners(this.page);
      this.recording?.trackVideo(this.page.video());
      this.resetPageLogs();
      log("Opened new page");
    }
    return this.page;
  }

  /**
   * Creates the browser context with the routing stack applied. While
   * recording, the context captures video (fixed at creation time in
   * Playwright) and starts a trace.
   */
  private async createContext(storageState?: StorageState): Promise<BrowserContext> {
    const recording = this.recording;
    const context = await this.browser!.newContext({
      viewport: VIEWPORT,
      ...(storageState ? { storageState } : {}),
      ...(recording?.video ? { recordVideo: { dir: recording.videoTmpDir, size: VIEWPORT } } : {}),
    });
    context.on("close", () => {
      if (this.context === context) {
        this.context = undefined;
        this.page = undefined;
      }
    });

    // Registered lowest-priority first; see the file header.
    if (this.allowlist.enabled) {
      await context.route("**/*", (route) => this.allowlistRoute(route));
    }
    await context.route(
      (url) => isPaymentProviderHost(url.hostname),
      (route) => this.paymentGuardRoute(route),
    );
    for (const mock of this.mocks.values()) {
      await context.route(mock.urlPattern, this.mockHandlers.get(mock.id)!);
    }

    if (recording) {
      await context.tracing.start({ name: "trace", title: recording.name, screenshots: true, snapshots: true });
    }
    return context;
  }

  /**
   * Replaces the current context with a fresh one carrying over cookies and
   * localStorage, then reopens the page that was showing. Needed because
   * video recording can only be switched on or off when a context is created.
   */
  private async recreateContext(): Promise<void> {
    const old = this.context;
    const url = this.page && !this.page.isClosed() ? this.page.url() : "about:blank";
    const state = old ? await old.storageState() : undefined;
    this.context = undefined;
    this.page = undefined;
    await old?.close();
    this.context = await this.createContext(state);
    const page = await this.getPage();
    if (url !== "about:blank") {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
        log(`Could not reopen ${url}: ${String(error)}`);
      });
    }
  }

  private async launchBrowser(): Promise<void> {
    // Drop references to anything belonging to a dead browser.
    this.context = undefined;
    this.page = undefined;

    const channel = this.browserChannel;
    if (channel && !BROWSER_CHANNELS.has(channel)) {
      throw new Error(`ARGUS_BROWSER_CHANNEL must be one of: ${[...BROWSER_CHANNELS].join(", ")} (got "${channel}")`);
    }
    log(`Launching ${channel ?? "Chromium"} (headless=${this.headless})`);
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: this.headless, ...(channel ? { channel } : {}) });
    } catch (error) {
      // Replace Playwright's long install banner with one actionable line.
      const message = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|is not found at/i.test(message)) {
        throw new Error(
          channel
            ? `Could not find an installed "${channel}" browser. Install it, or unset ARGUS_BROWSER_CHANNEL to use Playwright's Chromium.`
            : "Chromium for Playwright is not installed. Run: npx playwright install chromium  " +
                "(or set ARGUS_BROWSER_CHANNEL=chrome to use your installed Google Chrome).",
        );
      }
      throw error;
    }
    browser.on("disconnected", () => {
      // Only clear state if this is still the current browser instance.
      if (this.browser === browser) {
        log("Browser disconnected; will relaunch on next tool call");
        this.recording?.note("Browser disconnected; the trace up to this point was lost and a new one was started.");
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
      }
    });
    this.browser = browser;
  }

  // ---------------------------------------------------------------------------
  // Routing: allowlist, payment guard, mocks
  // ---------------------------------------------------------------------------

  private async allowlistRoute(route: Route): Promise<void> {
    const request = route.request();
    let isTopLevel = false;
    try {
      isTopLevel = request.isNavigationRequest() && request.frame().parentFrame() === null;
    } catch {
      // Service-worker requests have no frame; they are never top-level navigations.
    }
    if (isTopLevel && !this.allowlist.allows(request.url())) {
      this.record({
        type: "blocked_by_guard",
        message: `Navigation blocked: host not in ARGUS_ALLOWED_HOSTS (${this.allowlist.entries.join(", ")})`,
        url: request.url(),
      });
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  }

  private async paymentGuardRoute(route: Route): Promise<void> {
    const request = route.request();
    const reason = livePaymentBlockReason(new URL(request.url()), request.postData());
    if (reason) {
      this.livePaymentReason ??= reason;
      log(`Payment guard blocked ${request.method()} ${request.url()}: ${reason}`);
      this.record({ type: "blocked_by_guard", message: `Payment guard: ${reason}`, url: request.url() });
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  }

  private async mockRoute(mock: ActiveMock, route: Route): Promise<void> {
    const request = route.request();
    const exhausted = mock.times !== undefined && mock.hits >= mock.times;
    if (exhausted || (mock.method && request.method() !== mock.method)) {
      await route.fallback();
      return;
    }
    mock.hits += 1;
    const entry = this.networkByRequest.get(request);
    if (entry) entry.mocked = mock.id;
    if (mock.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    if (mock.abort) {
      await route.abort(mock.abort);
      return;
    }
    await route.fulfill({
      status: mock.status,
      body: mock.body,
      contentType: mock.contentType,
      headers: { "access-control-allow-origin": "*", ...mock.headers },
    });
  }

  async addMock(definition: MockDefinition): Promise<ActiveMock> {
    const mock: ActiveMock = { ...definition, id: `mock-${this.nextMockId++}`, hits: 0 };
    this.mocks.set(mock.id, mock);
    this.mockHandlers.set(mock.id, (route) => this.mockRoute(mock, route));
    // Make sure a context exists, then attach the route to it directly.
    await this.getPage();
    await this.context!.route(mock.urlPattern, this.mockHandlers.get(mock.id)!);
    return { ...mock };
  }

  /** Removes one mock (by id) or all of them from the live context. */
  async clearMocks(id?: string): Promise<{ removed: string[]; remaining: ActiveMock[] }> {
    if (id !== undefined && !this.mocks.has(id)) {
      const active = [...this.mocks.keys()].join(", ") || "none";
      throw new Error(`No mock with id "${id}". Active mocks: ${active}`);
    }
    const ids = id !== undefined ? [id] : [...this.mocks.keys()];
    for (const mockId of ids) {
      const mock = this.mocks.get(mockId)!;
      const handler = this.mockHandlers.get(mockId)!;
      this.mocks.delete(mockId);
      this.mockHandlers.delete(mockId);
      // Passing the handler removes only this mock, never the guard routes.
      await this.context?.unroute(mock.urlPattern, handler);
    }
    return { removed: ids, remaining: this.listMocks() };
  }

  listMocks(): ActiveMock[] {
    return [...this.mocks.values()].map((mock) => ({ ...mock }));
  }

  // ---------------------------------------------------------------------------
  // Page listeners and logs
  // ---------------------------------------------------------------------------

  /** Hooks console/exception/network listeners that feed the diagnostics tools. */
  private attachPageListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const loc = msg.location();
      this.record({
        type: "console_error",
        message: msg.text(),
        ...(loc.url ? { url: loc.lineNumber || loc.columnNumber ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : loc.url } : {}),
      });
    });

    page.on("pageerror", (error: Error) => {
      this.record({
        type: "uncaught_exception",
        message: error.stack ?? `${error.name}: ${error.message}`,
      });
    });

    page.on("request", (request: Request) => {
      const entry: NetworkEntry = {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        status: null,
        startedAt: new Date().toISOString(),
      };
      this.networkByRequest.set(request, entry);
      this.network.push(entry);
      if (this.network.length > MAX_NETWORK_ENTRIES) {
        this.network.splice(0, this.network.length - MAX_NETWORK_ENTRIES);
      }
    });

    page.on("requestfinished", (request: Request) => {
      const entry = this.networkByRequest.get(request);
      if (!entry) return;
      const timing = request.timing();
      if (timing.responseEnd > 0) entry.durationMs = Math.round(timing.responseEnd);
    });

    page.on("requestfailed", (request: Request) => {
      const failure = request.failure()?.errorText ?? "failed";
      const entry = this.networkByRequest.get(request);
      if (entry) entry.failure = failure;
      // Guard blocks are already recorded with a clearer message.
      if (failure.includes("ERR_BLOCKED_BY_CLIENT")) return;
      this.record({ type: "request_failed", message: `${request.method()} ${failure}`, url: request.url() });
    });

    page.on("response", (response: Response) => {
      const entry = this.networkByRequest.get(response.request());
      if (entry) entry.status = response.status();
      if (response.status() < 400) return;
      this.record({
        type: "http_error",
        message: `${response.request().method()} ${response.status()} ${response.statusText()}`.trim(),
        url: response.url(),
      });
    });

    page.on("framenavigated", (frame) => {
      // The live-payment verdict belongs to the document that produced it.
      if (frame === page.mainFrame()) this.livePaymentReason = undefined;
    });

    page.on("crash", () => {
      // A crashed page can't be reused; close it so getPage() opens a new one.
      log("Page crashed; it will be replaced on next tool call");
      if (this.page === page) this.page = undefined;
      page.close().catch(() => {});
    });
  }

  private record(entry: Omit<PageDiagnostic, "timestamp">): void {
    this.diagnostics.push({ ...entry, timestamp: new Date().toISOString() });
    if (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
    }
  }

  private resetPageLogs(): void {
    this.diagnostics = [];
    this.network = [];
  }

  // ---------------------------------------------------------------------------
  // Element helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves a selector, optionally inside (nested) iframes. `aria-ref=eN`
   * selectors from get_page_snapshot already reach into iframes on their own.
   */
  async locate(selector: string, frame: FramePath): Promise<Locator> {
    // .first() avoids strict-mode failures when the selector matches several nodes.
    return (await this.scope(frame)).locator(selector).first();
  }

  /** First element whose visible text contains (or, with exact, equals) `text`. */
  async locateText(text: string, frame: FramePath, exact = false): Promise<Locator> {
    return (await this.scope(frame)).getByText(text, { exact }).first();
  }

  /** The page itself, or the innermost of a chain of iframes. */
  private async scope(frame: FramePath): Promise<LocatorScope> {
    const page = await this.getPage();
    const frames = frame === undefined ? [] : Array.isArray(frame) ? frame : [frame];
    let scope: LocatorScope = page;
    for (const frameSelector of frames) {
      scope = scope.locator(frameSelector).first().contentFrame();
    }
    return scope;
  }

  /**
   * Runs an action and, if it starts a main-frame navigation (link, form
   * submit, Enter key), waits for the new page's DOM before returning.
   */
  private async withNavigationWatch(timeout: number, action: () => Promise<void>): Promise<ActionResult> {
    const page = await this.getPage();
    const navigated = page
      .waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: NAVIGATION_GRACE_MS,
      })
      .then(
        () => true,
        () => false,
      );
    await action();
    if (await navigated) {
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
      return { navigated: true, url: page.url() };
    }
    return { navigated: false, url: page.url() };
  }

  /**
   * Classifies a form field: password and payment-card fields are sensitive
   * (masked in recordings); card fields are additionally checked by the
   * payment guard before anything is typed into them.
   */
  private async classifyField(locator: Locator, timeout: number): Promise<{ sensitive: boolean; card: boolean }> {
    return locator.evaluate(
      (el) => {
        const attr = (name: string): string => (el.getAttribute(name) ?? "").toLowerCase();
        const hints = [attr("autocomplete"), attr("name"), attr("id"), attr("aria-label"), attr("placeholder"), attr("data-elements-stable-field-name")].join(" ");
        const card = /\bcc-|card|cardnumber|cvc|cvv|csc|security code|expir/.test(hints);
        return { sensitive: card || attr("type") === "password", card };
      },
      undefined,
      { timeout },
    );
  }

  /** Looks for live payment keys in the page HTML and every frame URL. */
  private async scanForLivePaymentKeys(page: Page): Promise<void> {
    if (this.livePaymentReason) return;
    const frameUrls = page.frames().map((frame) => frame.url()).join("\n");
    const html = await page.content().catch(() => "");
    if (containsLivePaymentKey(frameUrls) || containsLivePaymentKey(html)) {
      this.livePaymentReason = "page loads a live payment key (pk_live_)";
    }
  }

  // ---------------------------------------------------------------------------
  // Browser actions used by the tool handlers
  // ---------------------------------------------------------------------------

  async navigate(url: string, waitUntil: WaitUntil, timeout: number): Promise<NavigationResult> {
    if (!this.allowlist.allows(url)) {
      throw new Error(`Host not allowed. ARGUS_ALLOWED_HOSTS permits: ${this.allowlist.entries.join(", ")}`);
    }
    const page = await this.getPage();
    // "Since page load": each explicit navigation starts fresh error/network logs.
    this.resetPageLogs();
    const response = await page.goto(url, { waitUntil, timeout });
    return {
      url: page.url(),
      status: response?.status() ?? null,
      title: await page.title(),
    };
  }

  async click(selector: string, frame: FramePath, timeout: number): Promise<ActionResult> {
    const locator = await this.locate(selector, frame);
    return this.withNavigationWatch(timeout, () => locator.click({ timeout }));
  }

  async hover(selector: string, frame: FramePath, timeout: number): Promise<void> {
    const locator = await this.locate(selector, frame);
    await locator.hover({ timeout });
  }

  async fill(selector: string, frame: FramePath, text: string, timeout: number): Promise<FillResult> {
    const locator = await this.locate(selector, frame);
    const field = await this.classifyField(locator, timeout);
    // Register before the guard check so even a refused value is masked in logs.
    if (field.sensitive && text !== "") this.secrets.add(text);
    if (field.card && text.trim() !== "") {
      await this.scanForLivePaymentKeys(await this.getPage());
      if (this.livePaymentReason) {
        throw new Error(
          `Payment guard: refusing to type into a card field because ${this.livePaymentReason}. ` +
            "Only test/sandbox payment environments may be used.",
        );
      }
    }
    // Locator.fill() clears the field before typing the new value.
    await locator.fill(text, { timeout });
    return { masked: field.sensitive };
  }

  async selectOption(selector: string, frame: FramePath, options: string[], timeout: number): Promise<string[]> {
    const locator = await this.locate(selector, frame);
    // Each string matches an <option> by value or by visible label.
    return locator.selectOption(options, { timeout });
  }

  async pressKey(key: string, selector: string | undefined, frame: FramePath, timeout: number): Promise<ActionResult> {
    const page = await this.getPage();
    const target = selector ? await this.locate(selector, frame) : undefined;
    return this.withNavigationWatch(timeout, () =>
      target ? target.press(key, { timeout }) : page.keyboard.press(key),
    );
  }

  /** Waits for an element (by selector or visible text) to reach a state. */
  async waitFor(
    target: { selector?: string; text?: string },
    frame: FramePath,
    state: ElementState,
    timeout: number,
  ): Promise<void> {
    const locator = target.selector
      ? await this.locate(target.selector, frame)
      : await this.locateText(target.text ?? "", frame);
    await locator.waitFor({ state, timeout });
  }

  /**
   * Checks that text is visible: anywhere on the page, or inside the element
   * matched by `selector`. Waits up to `timeout` for it to appear.
   */
  async assertText(
    text: string,
    selector: string | undefined,
    frame: FramePath,
    exact: boolean,
    timeout: number,
  ): Promise<{ passed: boolean; actual?: string }> {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const target = selector
      ? (await this.locate(selector, frame)).filter({ hasText: exact ? new RegExp(`^\\s*${escaped}\\s*$`) : text })
      : await this.locateText(text, frame, exact);
    try {
      await target.waitFor({ state: "visible", timeout });
      return { passed: true };
    } catch {
      // Report what was actually there to make the failure actionable.
      const container = await this.locate(selector ?? "body", frame);
      const actual = await container.innerText({ timeout: 1000 }).catch(() => undefined);
      return actual === undefined ? { passed: false } : { passed: false, actual: actual.trim().slice(0, 500) };
    }
  }

  /** Returns whether the element reaches the expected visibility in time. */
  async assertVisible(selector: string, frame: FramePath, visible: boolean, timeout: number): Promise<boolean> {
    const locator = await this.locate(selector, frame);
    try {
      await locator.waitFor({ state: visible ? "visible" : "hidden", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** AI-oriented accessibility snapshot with [ref=eN] handles usable as `aria-ref=eN`. */
  async snapshot(selector: string | undefined, depth: number | undefined): Promise<{ url: string; title: string; snapshot: string }> {
    const page = await this.getPage();
    const options = { mode: "ai" as const, ...(depth !== undefined ? { depth } : {}) };
    const snapshot = selector
      ? await page.locator(selector).first().ariaSnapshot(options)
      : await page.ariaSnapshot(options);
    return { url: page.url(), title: await page.title(), snapshot };
  }

  /** Saves a PNG into the screenshot directory and returns its path and bytes. */
  async screenshot(filename: string, fullPage: boolean): Promise<{ path: string; data: Buffer }> {
    const page = await this.getPage();
    await mkdir(this.screenshotDir, { recursive: true });
    const filePath = path.join(this.screenshotDir, sanitizeFilename(filename));
    const data = await page.screenshot({ path: filePath, fullPage, type: "png" });
    await this.recording?.addScreenshot(filePath);
    return { path: filePath, data };
  }

  /**
   * Console/network diagnostics. Chrome logs a "Failed to load resource"
   * console error for every failed request; those duplicates of network
   * entries are dropped. Optionally hides entries from other sites.
   */
  getDiagnostics(firstPartyOnly: boolean): {
    pageUrl: string | null;
    diagnostics: PageDiagnostic[];
    hiddenDuplicates: number;
    hiddenThirdParty: number;
  } {
    const pageUrl = this.page && !this.page.isClosed() ? this.page.url() : null;
    const pageHost = pageUrl ? hostOf(pageUrl) : null;
    const networkUrls = new Set(
      this.diagnostics.filter((d) => d.type !== "console_error" && d.url).map((d) => d.url),
    );

    let hiddenDuplicates = 0;
    let hiddenThirdParty = 0;
    const diagnostics = this.diagnostics.filter((d) => {
      if (d.type === "console_error" && d.message.startsWith("Failed to load resource") && d.url && networkUrls.has(d.url)) {
        hiddenDuplicates++;
        return false;
      }
      if (firstPartyOnly && pageHost && d.url) {
        const host = hostOf(d.url);
        if (host && !sameSite(host, pageHost)) {
          hiddenThirdParty++;
          return false;
        }
      }
      return true;
    });
    return { pageUrl, diagnostics, hiddenDuplicates, hiddenThirdParty };
  }

  getNetworkRequests(filter: {
    urlContains?: string;
    resourceTypes?: string[];
    failedOnly: boolean;
    includeStatic: boolean;
    limit: number;
  }): { total: number; matched: number; requests: NetworkEntry[] } {
    const matched = this.network.filter((entry) => {
      if (filter.urlContains && !entry.url.includes(filter.urlContains)) return false;
      if (filter.resourceTypes && filter.resourceTypes.length > 0) {
        if (!filter.resourceTypes.includes(entry.resourceType)) return false;
      } else if (!filter.includeStatic && STATIC_RESOURCE_TYPES.has(entry.resourceType)) {
        return false;
      }
      if (filter.failedOnly && entry.failure === undefined && (entry.status === null || entry.status < 400)) {
        return false;
      }
      return true;
    });
    return {
      total: this.network.length,
      matched: matched.length,
      // Most recent last; keep the tail when truncating.
      requests: matched.slice(-filter.limit).map((entry) => ({ ...entry })),
    };
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  get activeRecording(): Recording | undefined {
    return this.recording;
  }

  /**
   * Starts tracing (and optionally video) for everything that follows. With
   * video on, the context is rebuilt so the current page and cookies carry over
   * but in-memory page state (e.g. an unsaved SPA form) does not.
   */
  async startRecording(name: string, video: boolean): Promise<Recording> {
    if (this.recording) {
      throw new Error(`Already recording "${this.recording.name}"; call stop_recording first.`);
    }
    await this.getPage();
    this.recording = await Recording.create(this.recordingsDir, name, video, this.secrets);
    try {
      if (video) {
        await this.recreateContext();
      } else {
        await this.context!.tracing.start({ name: "trace", title: name, screenshots: true, snapshots: true });
      }
    } catch (error) {
      this.recording = undefined;
      throw error;
    }
    log(`Recording "${name}" to ${this.recording.dir}`);
    return this.recording;
  }

  /** Saves the trace, finalizes videos and writes the report. */
  async stopRecording(options: { reopen: boolean } = { reopen: true }): Promise<RecordingSummary> {
    const recording = this.recording;
    if (!recording) throw new Error("No recording in progress; call start_recording first.");

    let traceSaved = false;
    if (this.context) {
      await this.context.tracing
        .stop({ path: recording.tracePath })
        .then(() => (traceSaved = true))
        .catch((error: unknown) => log(`Could not save trace: ${String(error)}`));
    }

    // Videos are only complete once their page closes, so a video recording
    // needs its context torn down; the next context is created without video.
    this.recording = undefined;
    if (recording.video) {
      if (options.reopen && this.context) {
        await this.recreateContext();
      } else {
        await this.context?.close();
      }
    }

    const summary = await recording.finalize(traceSaved);
    log(`Recording saved: ${summary.report}`);
    return summary;
  }

  /**
   * Runs `fn` inside a named trace group so the Trace Viewer shows Playwright
   * actions nested under the MCP tool call that caused them.
   */
  async traceStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const tracing = this.recording ? this.context?.tracing : undefined;
    const grouped = tracing ? await tracing.group(label).then(() => true, () => false) : false;
    try {
      return await fn();
    } finally {
      if (grouped) await tracing!.groupEnd().catch(() => {});
    }
  }

  /** Closes the browser, finalizing any active recording first; safe to call more than once. */
  async close(): Promise<void> {
    if (this.recording) {
      await this.stopRecording({ reopen: false }).catch((error: unknown) =>
        log(`Could not finalize recording: ${String(error)}`),
      );
    }
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    if (browser) {
      await browser.close().catch((error: unknown) => log(`Error closing browser: ${String(error)}`));
    }
  }
}

/**
 * Keeps screenshots inside the screenshot directory: strips any path
 * components (no "../" escapes), replaces unsafe characters, forces .png.
 */
function sanitizeFilename(filename: string): string {
  const base = path.basename(filename.trim()).replace(/[^\w.-]/g, "_");
  const name = base === "" || base.startsWith(".") ? `screenshot${base}` : base;
  return /\.png$/i.test(name) ? name : `${name}.png`;
}
