/**
 * Session recording artifacts.
 *
 * A Recording owns one output folder and collects everything a developer
 * needs to review an agent's browser session afterwards:
 *   - trace.zip      Playwright trace (DOM snapshots, network, console, per-action screenshots)
 *   - video-N.webm   Screen recording of each page opened while recording
 *   - screenshots/   Copies of screenshots taken via take_screenshot
 *   - actions.json   Ordered log of every MCP tool call with args, outcome and timing
 *   - report.html    Self-contained report: verdict, test results, errors, then the details
 *
 * The BrowserManager drives the Playwright side (tracing, video capture);
 * this module only manages files, the logs and the report.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Video } from "playwright";
import type { ErrorExplanation } from "./errors.js";
import { ARGUS_FAVICON, ARGUS_LOGO, REPORT_CSS, brandBar } from "./report-theme.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface ActionLogEntry {
  index: number;
  tool: string;
  args: unknown;
  ok: boolean;
  /** First part of the tool's text output (or its error message). */
  summary: string;
  /** Plain-language explanation when the call failed. */
  error?: ErrorExplanation;
  /** Page URL after the call. */
  pageUrl?: string;
  /** Page title after the call. */
  pageTitle?: string;
  /** Screenshot of the page when the call failed, relative to the recording folder. */
  screenshot?: string;
  /** Where the failure appears in the recorded video (set when the recording is saved). */
  video?: VideoPosition;
  /** Milliseconds since the recording started. */
  offsetMs: number;
  durationMs: number;
}

/** A point in one of the recording's videos. */
export interface VideoPosition {
  /** Video file name, e.g. "video.webm". */
  file: string;
  /** Seconds from the start of that video. */
  seconds: number;
  /** Display form, e.g. "0:12" or "video-2.webm 0:05". */
  label: string;
}

/** What callers pass to logAction; index, offset and video position are derived. */
export type ActionLogInput = Omit<ActionLogEntry, "index" | "offsetMs" | "screenshot" | "video"> & {
  startedAt: number;
  /** PNG of the page at the moment of failure. */
  failureScreenshot?: Buffer;
};

/** m:ss for video positions. */
function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A diagnostic produced by the website itself (console error, failed request, ...). */
interface PageDiagnosticInput {
  type: string;
  message: string;
  url?: string;
}

interface PageErrorEntry extends PageDiagnosticInput {
  pageUrl?: string;
  /** Milliseconds since the recording started, at first occurrence. */
  firstSeenMs: number;
  count: number;
}

/** Evidence attached to a failure: a screenshot path and the moment in the video. */
interface FailureEvidence {
  /** Absolute path of the screenshot taken when it failed. */
  screenshot?: string;
  /** Approximate position in the video, e.g. "0:12". */
  videoTime?: string;
  videoFile?: string;
}

/** Failures may carry the agent's suggested fix once suggest_fix has been called. */
interface WithSuggestedFix {
  suggestedFix?: AgentSuggestion;
}

export interface CheckResult extends FailureEvidence, WithSuggestedFix {
  step: number;
  check: string;
  passed: boolean;
  page?: string;
  /** Why it failed (expected vs actual), only for failures. */
  reason?: string;
}

export interface ToolErrorSummary extends FailureEvidence, WithSuggestedFix {
  step: number;
  tool: string;
  problem: string;
  explanation: string;
  suggestion?: string;
}

/** The website a recording tested, worked out from the pages it visited. */
export interface TestedSite {
  /** Page title, e.g. "Acme Shop", or the host when no page had a title. */
  name: string;
  /** Where the site lives, e.g. "https://staging.acme.com" or a file path. */
  address: string;
  /** Other sites the run also visited, by address. */
  otherSites: string[];
}

export interface RecordingSummary {
  name: string;
  /** The website under test; absent if no page was opened. */
  site?: TestedSite;
  directory: string;
  startedAt: string;
  stoppedAt: string;
  /** "failed" if any check failed or any tool call errored. */
  verdict: "passed" | "failed" | "no checks";
  actions: number;
  /** Outcome of assert_* tool calls made while recording. */
  assertions: { passed: number; failed: number };
  failedChecks: CheckResult[];
  toolErrors: ToolErrorSummary[];
  /** Distinct errors the website produced (console, exceptions, failed requests). */
  pageErrors: number;
  report: string;
  trace: string | null;
  videos: string[];
  screenshots: string[];
  notes: string[];
  viewTrace: string | null;
  /** Instruction to the agent when failures still lack a suggested fix. */
  nextStep?: string;
}

/** A fix proposed by the client's AI agent for one failed step (via suggest_fix). */
export interface AgentSuggestion {
  fix: string;
  /** The agent's diagnosis of the root cause. */
  cause?: string;
  /** Who should act on it: the application, the test itself, or the environment. */
  target?: "app" | "test" | "environment";
  addedAt: string;
}

/** What renderReport draws from, besides the summary. */
interface ReportData {
  checks: CheckResult[];
  log: ActionLogEntry[];
  pageErrors: PageErrorEntry[];
  videoFiles: string[];
  durationMs: number;
}

/** Rendering a single-file copy of the report for email. */
interface EmailCopy {
  /** Images inlined as data: URIs, by path relative to the recording folder. */
  images: Map<string, string>;
  /** Videos attached to the same email. */
  attachedVideos: Set<string>;
}

/** Images larger than this are left out of the emailed report rather than inlined. */
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

/** Unique page errors kept per recording; repeats only bump a counter. */
const MAX_PAGE_ERRORS = 300;

/** Turns a free-form name into something safe for a folder name. */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? "recording" : slug;
}

function timestampForPath(date: Date): string {
  // 2026-10-24T22:15:20.123Z -> 2026-10-24_22-15-20
  return date.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function isAssertion(tool: string): boolean {
  return tool.startsWith("assert_");
}

/** Human-readable name of a check: its label, or a description built from its arguments. */
function describeCheck(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a["label"] === "string" && a["label"].trim() !== "") return a["label"];
  const frame = a["frame"] === undefined ? "" : ` inside iframe ${[a["frame"]].flat().join(" > ")}`;
  if (tool === "assert_text") {
    const where = typeof a["selector"] === "string" ? `in ${a["selector"]}` : "on the page";
    return `Text "${String(a["text"])}"${a["exact"] === true ? " (exact match)" : ""} is visible ${where}${frame}`;
  }
  if (tool === "assert_visible") {
    return `${String(a["selector"])} is ${a["visible"] === false ? "hidden" : "visible"}${frame}`;
  }
  return tool;
}

/** Compact one-line view of tool arguments for tables. */
function compactArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Path part of a URL for display ("/checkout.html"), falling back to the full URL. */
function shortPage(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

/** Site a page belongs to: its origin for http(s), the file for file: URLs; none for blank and error pages. */
function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
  } catch {
    // not a URL
  }
  return undefined;
}

interface SiteVisit {
  steps: number;
  /** Distinct page titles seen on the site, in order. */
  titles: string[];
  /** Title of the site's home page, if the run opened it. */
  homeTitle?: string;
}

/**
 * A site's name from its page titles: the home page's title; otherwise the
 * part most titles share ("Cart | Acme", "Log in | Acme" -> "Acme"); otherwise
 * the only title seen. Undefined when the titles have nothing in common.
 */
function siteName({ titles, homeTitle }: SiteVisit): string | undefined {
  if (homeTitle) return homeTitle;
  if (titles.length === 1) return titles[0];
  const counts = new Map<string, number>();
  for (const title of titles) {
    const parts = new Set(title.split(/\s+[|·•:–—-]\s+/).map((p) => p.trim()).filter(Boolean));
    for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] >= 2 && best[1] > titles.length / 2 ? best[0] : undefined;
}

/** The site the run spent most of its steps on (the first one visited wins a tie). */
function testedSite(log: ActionLogEntry[]): TestedSite | undefined {
  const sites = new Map<string, SiteVisit>();
  for (const a of log) {
    const site = siteOf(a.pageUrl);
    if (!site) continue;
    const visit = sites.get(site) ?? { steps: 0, titles: [] };
    visit.steps++;
    if (a.pageTitle && !visit.titles.includes(a.pageTitle)) visit.titles.push(a.pageTitle);
    if (a.pageTitle && site.startsWith("http") && /^\/(index\.html?)?$/.test(new URL(a.pageUrl!).pathname)) visit.homeTitle ??= a.pageTitle;
    sites.set(site, visit);
  }
  let main: [string, SiteVisit] | undefined;
  for (const site of sites) if (!main || site[1].steps > main[1].steps) main = site;
  if (!main) return undefined;
  const [address, visit] = main;
  const host = address.startsWith("http") ? new URL(address).host : path.basename(address);
  return { name: siteName(visit) ?? host, address, otherSites: [...sites.keys()].filter((s) => s !== address) };
}

export class Recording {
  readonly startedAt = new Date();
  readonly dir: string;
  readonly tracePath: string;
  /** Playwright writes videos here under random names; finalize() renames them. */
  readonly videoTmpDir: string;

  private readonly actions: ActionLogEntry[] = [];
  private readonly pageErrors = new Map<string, PageErrorEntry>();
  /** Each page's video and when it started (epoch ms), to map failures to video time. */
  private readonly videos: { video: Video; startedAt: number }[] = [];
  /** Failure screenshots still being written; finalize() waits for them. */
  private readonly pendingWrites: Promise<void>[] = [];
  /** Suggested fixes from the client agent, by step number. */
  private readonly suggestions = new Map<number, AgentSuggestion>();
  /** Set once finalize() has saved the videos; outputs can then be rewritten. */
  private saved: { traceSaved: boolean; savedFiles: (string | undefined)[]; stoppedAt: Date } | undefined;
  /** The latest summary and data written to report.html, for the emailed copy. */
  private rendered: { summary: RecordingSummary; data: ReportData } | undefined;
  private readonly screenshots: string[] = [];
  private readonly notes: string[] = [];

  private constructor(
    readonly name: string,
    readonly video: boolean,
    root: string,
    /** Live set of values typed into password/card fields, masked in the log. */
    private readonly secrets: ReadonlySet<string>,
  ) {
    this.dir = path.join(root, `${timestampForPath(this.startedAt)}_${slugify(name)}`);
    this.tracePath = path.join(this.dir, "trace.zip");
    this.videoTmpDir = path.join(this.dir, ".video-tmp");
  }

  static async create(root: string, name: string, video: boolean, secrets: ReadonlySet<string>): Promise<Recording> {
    const recording = new Recording(name, video, root, secrets);
    await mkdir(recording.dir, { recursive: true });
    return recording;
  }

  /** Replaces every known secret inside any string of `value` with a mask. */
  private redact<T>(value: T): T {
    if (this.secrets.size === 0) return value;
    const mask = (text: string): string => {
      let out = text;
      for (const secret of this.secrets) out = out.split(secret).join("••••••");
      return out;
    };
    return JSON.parse(JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === "string" ? mask(v) : v))) as T;
  }

  /**
   * Registers a page's video so finalize() can save it once the page closes.
   * Playwright starts recording when the page is created, which is now.
   */
  trackVideo(video: Video | null): void {
    if (video) this.videos.push({ video, startedAt: Date.now() });
  }

  logAction(entry: ActionLogInput): void {
    const { startedAt, failureScreenshot, ...rest } = entry;
    const index = this.actions.length + 1;
    // Stored raw; finalize() masks secrets so values learned later also cover earlier entries.
    const action: ActionLogEntry = {
      index,
      // start_recording itself begins slightly before the recording exists.
      offsetMs: Math.max(0, startedAt - this.startedAt.getTime()),
      ...rest,
    };
    if (failureScreenshot) {
      const file = `failures/step-${String(index).padStart(3, "0")}-${rest.tool}.png`;
      action.screenshot = file;
      this.pendingWrites.push(
        mkdir(path.join(this.dir, "failures"), { recursive: true })
          .then(() => writeFile(path.join(this.dir, file), failureScreenshot))
          .catch((error: unknown) => {
            delete action.screenshot;
            this.note(`Could not save failure screenshot for step ${index}: ${String(error)}`);
          }),
      );
    }
    this.actions.push(action);
  }

  /**
   * Where a moment (epoch ms) falls in the saved videos: the latest video that
   * had started by then. Approximate, since the first frames lag page creation slightly.
   */
  private videoPosition(at: number, savedFiles: (string | undefined)[]): VideoPosition | undefined {
    for (let i = this.videos.length - 1; i >= 0; i--) {
      const file = savedFiles[i];
      const startedAt = this.videos[i]!.startedAt;
      if (file && startedAt <= at) {
        const seconds = (at - startedAt) / 1000;
        return { file, seconds, label: savedFiles.filter(Boolean).length > 1 ? `${file} ${clock(seconds)}` : clock(seconds) };
      }
    }
    return undefined;
  }

  /** Records an error produced by the website; repeats of the same error are counted, not duplicated. */
  addPageError(diagnostic: PageDiagnosticInput, pageUrl: string | undefined): void {
    const key = `${diagnostic.type}|${diagnostic.message}|${diagnostic.url ?? ""}`;
    const existing = this.pageErrors.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (this.pageErrors.size >= MAX_PAGE_ERRORS) return;
    this.pageErrors.set(key, {
      type: diagnostic.type,
      message: diagnostic.message,
      ...(diagnostic.url ? { url: diagnostic.url } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      firstSeenMs: Date.now() - this.startedAt.getTime(),
      count: 1,
    });
  }

  /** Free-form event worth surfacing in the report (e.g. a browser crash). */
  note(message: string): void {
    this.notes.push(`${new Date().toISOString()}  ${message}`);
  }

  /** Copies a screenshot into the recording folder so the report is self-contained. */
  async addScreenshot(sourcePath: string): Promise<void> {
    const dir = path.join(this.dir, "screenshots");
    await mkdir(dir, { recursive: true });
    const base = `${String(this.screenshots.length + 1).padStart(2, "0")}-${path.basename(sourcePath)}`;
    await copyFile(sourcePath, path.join(dir, base));
    this.screenshots.push(`screenshots/${base}`);
  }

  /**
   * Page errors worth showing: Chrome's "Failed to load resource" console
   * message duplicates the network entry for the same URL, so it is dropped.
   */
  private reportablePageErrors(): PageErrorEntry[] {
    const all = [...this.pageErrors.values()];
    const networkUrls = new Set(all.filter((e) => e.type !== "console_error" && e.url).map((e) => e.url));
    return all.filter((e) => !(e.type === "console_error" && e.message.startsWith("Failed to load resource") && e.url && networkUrls.has(e.url)));
  }

  /** Steps that failed (checks and errored tool calls), in order. */
  failedSteps(): number[] {
    return this.actions.filter((a) => !a.ok).map((a) => a.index);
  }

  /**
   * Attaches the client agent's suggested fix to a failed step (replacing any
   * earlier one). After the recording has been saved, the report and
   * actions.json are rewritten so the suggestion appears immediately.
   */
  async addSuggestion(step: number, suggestion: Omit<AgentSuggestion, "addedAt">): Promise<{ withoutFix: number[]; report: string }> {
    const failed = this.failedSteps();
    if (!failed.includes(step)) {
      const listed = failed.length ? `Failed steps: ${failed.join(", ")}` : "Nothing has failed in this recording";
      throw new Error(`Step ${step} did not fail, so it cannot take a suggested fix. ${listed}.`);
    }
    this.suggestions.set(step, { ...suggestion, addedAt: new Date().toISOString() });
    if (this.saved) await this.writeOutputs();
    return { withoutFix: this.stepsWithoutFix(), report: path.join(this.dir, "report.html") };
  }

  /** Failed steps the agent has not suggested a fix for yet. */
  stepsWithoutFix(): number[] {
    return this.failedSteps().filter((s) => !this.suggestions.has(s));
  }

  /**
   * Saves videos, then writes the action log and the HTML report. Must be
   * called after the recording context is closed, otherwise video files are incomplete.
   */
  async finalize(traceSaved: boolean): Promise<RecordingSummary> {
    const stoppedAt = new Date();

    await Promise.all(this.pendingWrites);

    // savedFiles[i] is the file for this.videos[i], or undefined if it could not be saved.
    const savedFiles: (string | undefined)[] = [];
    for (const [i, { video }] of this.videos.entries()) {
      const file = this.videos.length === 1 ? "video.webm" : `video-${i + 1}.webm`;
      try {
        await video.saveAs(path.join(this.dir, file));
        await video.delete();
        savedFiles.push(file);
      } catch (error) {
        savedFiles.push(undefined);
        this.note(`Could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await rm(this.videoTmpDir, { recursive: true, force: true });

    if (!traceSaved) this.note("Trace was not saved (the browser context was lost before stopping).");
    this.saved = { traceSaved, savedFiles, stoppedAt };
    return this.writeOutputs();
  }

  /** Builds the summary and (re)writes actions.json and report.html. Safe to call repeatedly. */
  private async writeOutputs(): Promise<RecordingSummary> {
    const { traceSaved, savedFiles, stoppedAt } = this.saved!;
    const videoFiles = savedFiles.filter((file): file is string => file !== undefined);
    const log = this.redact(this.actions);
    const suggestions = this.redact(Object.fromEntries(this.suggestions)) as Record<string, AgentSuggestion>;
    const fixFor = (a: ActionLogEntry): { suggestedFix?: AgentSuggestion } => {
      const fix = suggestions[String(a.index)];
      return fix ? { suggestedFix: fix } : {};
    };
    for (const action of log) {
      if (action.ok) continue;
      // The failure happened as the step ended.
      const position = this.videoPosition(this.startedAt.getTime() + action.offsetMs + action.durationMs, savedFiles);
      if (position) action.video = position;
    }
    const evidence = (a: ActionLogEntry): FailureEvidence => ({
      ...(a.screenshot ? { screenshot: path.join(this.dir, a.screenshot) } : {}),
      ...(a.video ? { videoTime: clock(a.video.seconds), videoFile: a.video.file } : {}),
    });

    const pageErrors = this.redact(this.reportablePageErrors());
    const checks: CheckResult[] = log
      .filter((a) => isAssertion(a.tool))
      .map((a) => ({
        step: a.index,
        check: describeCheck(a.tool, a.args),
        passed: a.ok,
        ...(a.pageUrl ? { page: a.pageUrl } : {}),
        ...(!a.ok ? { reason: a.error?.explanation ?? a.summary, ...evidence(a), ...fixFor(a) } : {}),
      }));
    const toolErrors: ToolErrorSummary[] = log
      .filter((a) => !a.ok && !isAssertion(a.tool))
      .map((a) => ({
        step: a.index,
        tool: a.tool,
        problem: a.error?.title ?? "Error",
        explanation: a.error?.explanation ?? a.summary,
        ...(a.error?.suggestion ? { suggestion: a.error.suggestion } : {}),
        ...evidence(a),
        ...fixFor(a),
      }));
    const failedChecks = checks.filter((c) => !c.passed);
    const withoutFix = log.filter((a) => !a.ok && !suggestions[String(a.index)]).map((a) => a.index);

    const site = testedSite(log);
    const summary: RecordingSummary = {
      name: this.name,
      ...(site ? { site } : {}),
      directory: this.dir,
      startedAt: this.startedAt.toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      verdict: failedChecks.length > 0 || toolErrors.length > 0 ? "failed" : checks.length > 0 ? "passed" : "no checks",
      actions: log.length,
      assertions: { passed: checks.length - failedChecks.length, failed: failedChecks.length },
      failedChecks,
      toolErrors,
      pageErrors: pageErrors.length,
      report: path.join(this.dir, "report.html"),
      trace: traceSaved ? this.tracePath : null,
      videos: videoFiles.map((file) => path.join(this.dir, file)),
      screenshots: this.screenshots.map((file) => path.join(this.dir, file)),
      notes: [...this.notes],
      viewTrace: traceSaved ? `npx playwright show-trace "${this.tracePath}"` : null,
      ...(withoutFix.length
        ? {
            nextStep:
              `${withoutFix.length === 1 ? "Step" : "Steps"} ${withoutFix.join(", ")} failed without a suggested fix. For each, call suggest_fix with its step number, ` +
              "your diagnosis of the cause, and the concrete fix; it is added to the report.",
          }
        : {}),
    };

    await writeFile(
      path.join(this.dir, "actions.json"),
      JSON.stringify({ ...summary, checks, pageErrorLog: pageErrors, log }, null, 2),
    );
    const data: ReportData = { checks, log, pageErrors, videoFiles, durationMs: stoppedAt.getTime() - this.startedAt.getTime() };
    this.rendered = { summary, data };
    await writeFile(summary.report, this.renderReport(summary, data));
    return summary;
  }

  /** The summary as last saved (including later suggested fixes); undefined until the recording is saved. */
  get lastSummary(): RecordingSummary | undefined {
    return this.rendered?.summary;
  }

  /**
   * report.html as one self-contained file for email: screenshots are inlined,
   * and the video section points at the attachments named in `attachedVideos`.
   */
  async portableReport(attachedVideos: readonly string[]): Promise<string> {
    if (!this.rendered) throw new Error("The recording has not been saved yet.");
    const { summary, data } = this.rendered;
    const images = new Map<string, string>();
    for (const file of [...data.log.flatMap((a) => (a.screenshot ? [a.screenshot] : [])), ...this.screenshots]) {
      const bytes = await readFile(path.join(this.dir, file)).catch(() => undefined);
      if (bytes && bytes.length <= MAX_INLINE_IMAGE_BYTES) images.set(file, `data:image/png;base64,${bytes.toString("base64")}`);
    }
    return this.renderReport(summary, data, { images, attachedVideos: new Set(attachedVideos) });
  }

  private renderReport(summary: RecordingSummary, data: ReportData, emailCopy?: EmailCopy): string {
    const { checks, log, pageErrors, videoFiles } = data;
    const passedCount = summary.assertions.passed;
    const failedCount = summary.assertions.failed;
    const verdictLabel = { passed: "PASSED", failed: "FAILED", "no checks": "NO CHECKS" }[summary.verdict];
    const verdictNote =
      summary.verdict === "failed"
        ? [failedCount ? `${failedCount} check${failedCount === 1 ? "" : "s"} failed` : "", summary.toolErrors.length ? `${summary.toolErrors.length} step${summary.toolErrors.length === 1 ? "" : "s"} errored` : ""].filter(Boolean).join(" and ")
        : summary.verdict === "passed"
          ? `All ${passedCount} check${passedCount === 1 ? "" : "s"} passed`
          : "No assert_text / assert_visible checks were run";

    const stat = (value: string | number, label: string, tone = ""): string =>
      `<div class="stat ${tone}"><div class="value">${value}</div><div class="label">${label}</div></div>`;
    /** A collapsible report section; `note` is shown beside the heading so a collapsed section still says what it holds. */
    const section = (id: string, title: string, body: string, { open = true, note = "" } = {}): string =>
      `<details class="section" id="${id}"${open ? " open" : ""}><summary><h2>${title}</h2>${note ? `<span class="muted small">${escapeHtml(note)}</span>` : ""}</summary>
<div class="section-body">
${body}
</div>
</details>`;
    const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
    const site = summary.site;
    /** A site address, linked when it is a web address. */
    const siteLink = (address: string): string =>
      address.startsWith("http") ? `<a href="${escapeHtml(address)}" target="_blank" rel="noopener">${escapeHtml(address)}</a>` : `<code>${escapeHtml(address)}</code>`;

    const byStep = new Map(log.map((a) => [a.index, a]));
    const anyFailedCheck = checks.some((c) => !c.passed);
    const videoId = (file: string): string => `video-${file.replace(/[^a-z0-9]/gi, "-")}`;
    /** "▶ 0:12 in video" link; starts playback 2 s early so the lead-up is visible. */
    const seekLink = (a: ActionLogEntry | undefined): string => {
      if (!a?.video) return "";
      // The emailed copy has no player to seek; it just names the moment in the attached video.
      if (emailCopy) return `<span class="seek" title="Time in the attached video">&#9654; ${escapeHtml(a.video.label)} in video</span>`;
      const start = Math.max(0, a.video.seconds - 2).toFixed(1);
      return `<a class="seek" href="${escapeHtml(a.video.file)}#t=${start}" data-video="${videoId(a.video.file)}" data-time="${start}" title="Jump to just before the failure in the video">&#9654; ${escapeHtml(a.video.label)} in video</a>`;
    };
    const thumbnail = (a: ActionLogEntry | undefined): string => {
      if (!a?.screenshot) return "";
      if (emailCopy) {
        const src = emailCopy.images.get(a.screenshot);
        return src ? `<span class="shot"><img src="${src}" alt="The page when step ${a.index} failed"><span>Page at failure</span></span>` : "";
      }
      return `<a class="shot" href="${escapeHtml(a.screenshot)}" target="_blank" title="Open full size"><img src="${escapeHtml(a.screenshot)}" alt="The page when step ${a.index} failed" loading="lazy"><span>Page at failure</span></a>`;
    };

    const targetLabels: Record<NonNullable<AgentSuggestion["target"]>, string> = {
      app: "Fix in the app",
      test: "Fix in the test",
      environment: "Fix the environment",
    };
    /** The client agent's diagnosis and fix for a failure, from suggest_fix. */
    const agentFix = (fix: AgentSuggestion | undefined): string =>
      fix
        ? `<div class="agent-fix">${fix.target ? `<span class="target ${fix.target}">${targetLabels[fix.target]}</span>` : ""}${
            fix.cause ? `<p><strong>Cause:</strong> ${escapeHtml(fix.cause)}</p>` : ""
          }<p>${escapeHtml(fix.fix)}</p></div>`
        : '<span class="empty small">No suggestion yet</span>';

    const checkRows = checks
      .map((c) => {
        const entry = byStep.get(c.step);
        return `<tr class="${c.passed ? "pass" : "fail"}">
  <td><span class="badge ${c.passed ? "pass" : "fail"}">${c.passed ? "PASS" : "FAIL"}</span></td>
  <td>${c.step}</td>
  <td>${escapeHtml(c.check)}</td>
  <td class="page">${escapeHtml(shortPage(c.page))}</td>
  <td class="why-col">${c.reason ? `<div class="evidence"><div class="why"><pre>${escapeHtml(c.reason)}</pre>${seekLink(entry)}</div>${thumbnail(entry)}</div>` : ""}</td>
  ${anyFailedCheck ? `<td class="fix-col">${c.passed ? "" : agentFix(c.suggestedFix)}</td>` : ""}
</tr>`;
      })
      .join("\n");

    const errorCards = summary.toolErrors
      .map((e) => {
        const entry = byStep.get(e.step);
        return `<div class="error-card">
  <div class="error-head"><span class="badge fail">ERROR</span> <strong>${escapeHtml(e.problem)}</strong> <span class="muted">step ${e.step} &middot; <code>${escapeHtml(e.tool)}</code>${entry?.pageUrl ? ` &middot; ${escapeHtml(shortPage(entry.pageUrl))}` : ""}</span></div>
  <div class="evidence">
    <div class="why">
      <p>${escapeHtml(e.explanation)}</p>
      ${e.suggestion ? `<p class="suggestion"><strong>Try:</strong> ${escapeHtml(e.suggestion)}</p>` : ""}
      ${entry ? `<p class="muted small">Called with <code>${escapeHtml(compactArgs(entry.args))}</code></p>` : ""}
      ${seekLink(entry)}
      <div class="agent-fix-block"><div class="fix-label">AI agent's suggested fix</div>${agentFix(e.suggestedFix)}</div>
    </div>
    ${thumbnail(entry)}
  </div>
</div>`;
      })
      .join("\n");

    const pageErrorLabels: Record<string, string> = {
      console_error: "Console error",
      uncaught_exception: "Uncaught exception",
      request_failed: "Request failed",
      http_error: "HTTP error",
      blocked_by_guard: "Blocked by Argus",
    };
    const pageErrorRows = pageErrors
      .map(
        (e) => `<tr>
  <td>${escapeHtml(pageErrorLabels[e.type] ?? e.type)}</td>
  <td><pre>${escapeHtml(e.message)}</pre>${e.url ? `<div class="muted small">${escapeHtml(e.url)}</div>` : ""}</td>
  <td class="page">${escapeHtml(shortPage(e.pageUrl))}</td>
  <td>${seconds(e.firstSeenMs)}</td>
  <td>${e.count > 1 ? `&times;${e.count}` : ""}</td>
</tr>`,
      )
      .join("\n");

    const logRows = log
      .map(
        (a) => `<tr class="${a.ok ? "" : "fail"}">
  <td>${a.index}</td><td>${seconds(a.offsetMs)}</td><td><code>${escapeHtml(a.tool)}</code></td>
  <td><pre>${escapeHtml(JSON.stringify(a.args, null, 1) ?? "")}</pre></td>
  <td>${a.ok ? "ok" : `<span class="badge fail">${isAssertion(a.tool) ? "FAIL" : "ERROR"}</span>`}</td><td>${a.durationMs}ms</td>
  <td>${a.error ? `<strong>${escapeHtml(a.error.title)}</strong><pre>${escapeHtml(a.error.explanation)}</pre>${seekLink(a)}` : `<pre>${escapeHtml(a.summary)}</pre>`}</td>
</tr>`,
      )
      .join("\n");

    const videos = emailCopy
      ? videoFiles
          .map((file) =>
            emailCopy.attachedVideos.has(file)
              ? `<p class="attachment">&#127902; <strong>${escapeHtml(file)}</strong> is attached to this email. Each failure above gives its time in the video.</p>`
              : `<p class="attachment muted">${escapeHtml(file)} was too large to email; it is kept with the test run.</p>`,
          )
          .join("\n")
      : videoFiles
      .map(
        (file) =>
          `${videoFiles.length > 1 ? `<p class="muted small">${escapeHtml(file)}</p>` : ""}<video id="${videoId(file)}" controls preload="metadata" src="${escapeHtml(file)}"></video>`,
      )
      .join("\n");
    const shots = this.screenshots
      .map((file) => {
        if (!emailCopy) return `<a href="${escapeHtml(file)}"><img src="${escapeHtml(file)}" alt="${escapeHtml(file)}"></a>`;
        const src = emailCopy.images.get(file);
        return src ? `<img src="${src}" alt="${escapeHtml(file)}">` : `<p class="muted small">${escapeHtml(file)} (too large to email)</p>`;
      })
      .join("\n");
    const notes = summary.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("\n");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(verdictLabel)}: ${escapeHtml(site ? `${site.name} · ${summary.name}` : summary.name)} · Argus</title>
<link rel="icon" href="${ARGUS_FAVICON}">
<style>${REPORT_CSS}</style></head><body>
${brandBar({ tone: summary.verdict.replace(" ", "-"), label: verdictLabel })}
<main>
${
  site
    ? `<p class="eyebrow">Website tested</p>
<h1>${escapeHtml(site.name)}</h1>
<p class="site-address">${siteLink(site.address)}${site.otherSites.length ? ` <span class="muted small">&middot; also visited ${site.otherSites.map(siteLink).join(", ")}</span>` : ""}</p>
<p class="run-meta muted">Test run <strong>${escapeHtml(summary.name)}</strong> &middot; <span class="run-time">${escapeHtml(summary.startedAt)} &rarr; ${escapeHtml(summary.stoppedAt)}</span></p>`
    : `<p class="eyebrow">Test run</p>
<h1>${escapeHtml(summary.name)}</h1>
<p class="run-meta muted"><span class="run-time">${escapeHtml(summary.startedAt)} &rarr; ${escapeHtml(summary.stoppedAt)}</span> &middot; no web page was opened</p>`
}
<div class="toolbar no-print">
  <button type="button" data-sections="open">Show all sections</button>
  <button type="button" data-sections="close">Hide all sections</button>
  <span class="muted small">Click a section's heading to show or hide it. Hidden sections are also left out when printing or saving as PDF.</span>
</div>

${section(
  "summary",
  "Summary",
  `<div class="verdict ${summary.verdict.replace(" ", "-")}">
  <div class="big">${verdictLabel}</div><div>${escapeHtml(verdictNote)}</div>
</div>
<div class="stats">
  ${stat(passedCount, "checks passed", passedCount ? "good" : "")}
  ${stat(failedCount, "checks failed", failedCount ? "bad" : "")}
  ${stat(summary.toolErrors.length, "steps errored", summary.toolErrors.length ? "bad" : "")}
  ${stat(pageErrors.length, "page errors", pageErrors.length ? "bad" : "")}
  ${stat(log.length, "tool calls")}
  ${stat(seconds(data.durationMs), "duration")}
</div>`,
  { note: verdictLabel },
)}

${section(
  "test-results",
  "Test results",
  checks.length
    ? `<div class="table-wrap"><table><thead><tr><th>Result</th><th>Step</th><th>Check</th><th>Page</th><th>Why it failed</th>${anyFailedCheck ? "<th>AI agent's suggested fix</th>" : ""}</tr></thead>
<tbody>
${checkRows}
</tbody></table></div>`
    : '<p class="empty">No checks were run. Use assert_text and assert_visible to record pass/fail results.</p>',
  { note: checks.length ? `${passedCount} passed, ${failedCount} failed` : "no checks" },
)}

${section("run-errors", "Errors during the run", errorCards || '<p class="empty">No steps failed.</p>', { note: count(summary.toolErrors.length, "error") })}

${section(
  "website-errors",
  "Errors from the website",
  `<p class="muted">Console errors, uncaught exceptions and failed requests the site produced while it was being tested.</p>
${
  pageErrors.length
    ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Message</th><th>Page</th><th>First seen</th><th>Repeats</th></tr></thead>
<tbody>
${pageErrorRows}
</tbody></table></div>`
    : '<p class="empty">The website reported no errors.</p>'
}`,
  { note: count(pageErrors.length, "error") },
)}

${videos ? section("video", "Video", videos, { note: count(videoFiles.length, "video") }) : ""}
${
  summary.viewTrace && emailCopy
    ? section(
        "trace",
        "Trace",
        "<p>The Playwright trace (<code>trace.zip</code>) is kept with the test run and not emailed: it records every value typed during the run, including passwords.</p>",
      )
    : summary.viewTrace
    ? section(
        "trace",
        "Trace",
        `<p>Step-by-step DOM snapshots, network and console for every action. Open with:</p>
<code class="cmd">${escapeHtml(summary.viewTrace)}</code>
<p>or drag <code>trace.zip</code> onto <a href="https://trace.playwright.dev">trace.playwright.dev</a> (runs locally in your browser).</p>`,
      )
    : ""
}
${shots ? section("screenshots", "Screenshots", `<div class="shots">${shots}</div>`, { note: count(this.screenshots.length, "screenshot") }) : ""}

${section(
  "tool-calls",
  "All tool calls",
  `<div class="table-wrap"><table><thead><tr><th>#</th><th>At</th><th>Tool</th><th>Args</th><th>Status</th><th>Took</th><th>Result</th></tr></thead>
<tbody>
${logRows || '<tr><td colspan="7">No tool calls were recorded.</td></tr>'}
</tbody></table></div>`,
  { open: summary.verdict !== "failed", note: `${count(log.length, "call")}, in order` },
)}
${notes ? section("notes", "Notes", `<ul>${notes}</ul>`, { note: count(summary.notes.length, "note") }) : ""}
<footer class="report-footer">${ARGUS_LOGO}<span>Generated by <strong>Argus</strong> &middot; ${SERVER_NAME} v${SERVER_VERSION}${emailCopy ? " &middot; emailed copy" : ""}</span></footer>
</main>
<script>
  // Show / hide all sections.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sections]");
    if (!button) return;
    const open = button.dataset.sections === "open";
    for (const section of document.querySelectorAll("details.section")) section.open = open;
  });
  // "▶ 0:12 in video" links: seek the embedded player instead of opening the file.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a.seek");
    const video = link && document.getElementById(link.dataset.video);
    if (!video) return;
    event.preventDefault();
    // Reopen the Video section if it was hidden.
    const section = video.closest("details.section");
    if (section) section.open = true;
    const play = () => { video.currentTime = Number(link.dataset.time); video.play().catch(() => {}); };
    video.scrollIntoView({ behavior: "smooth", block: "center" });
    if (video.readyState >= 1) play(); else video.addEventListener("loadedmetadata", play, { once: true });
  });
</script>
</body></html>
`;
  }
}
