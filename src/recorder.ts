/**
 * Session recording artifacts.
 *
 * A Recording owns one output folder and collects everything a developer
 * needs to review an agent's browser session afterwards:
 *   - trace.zip      Playwright trace (DOM snapshots, network, console, per-action screenshots)
 *   - video-N.webm   Screen recording of each page opened while recording
 *   - screenshots/   Copies of screenshots taken via take_screenshot
 *   - actions.json   Ordered log of every MCP tool call with args, outcome and timing
 *   - report.html    Self-contained summary page tying the above together
 *
 * The BrowserManager drives the Playwright side (tracing, video capture);
 * this module only manages files and the log.
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Video } from "playwright";

export interface ActionLogEntry {
  index: number;
  tool: string;
  args: unknown;
  ok: boolean;
  /** First part of the tool's text output (or its error message). */
  summary: string;
  /** Milliseconds since the recording started. */
  offsetMs: number;
  durationMs: number;
}

export interface RecordingSummary {
  name: string;
  directory: string;
  startedAt: string;
  stoppedAt: string;
  actions: number;
  /** Outcome of assert_* tool calls made while recording. */
  assertions: { passed: number; failed: number };
  report: string;
  trace: string | null;
  videos: string[];
  screenshots: string[];
  notes: string[];
  viewTrace: string | null;
}

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

export class Recording {
  readonly startedAt = new Date();
  readonly dir: string;
  readonly tracePath: string;
  /** Playwright writes videos here under random names; finalize() renames them. */
  readonly videoTmpDir: string;

  private readonly actions: ActionLogEntry[] = [];
  private readonly videos: Video[] = [];
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

  /** Registers a page's video so finalize() can save it once the page closes. */
  trackVideo(video: Video | null): void {
    if (video) this.videos.push(video);
  }

  logAction(entry: Omit<ActionLogEntry, "index" | "offsetMs"> & { startedAt: number }): void {
    const { startedAt, ...rest } = entry;
    // Stored raw; finalize() masks secrets so values learned later also cover earlier entries.
    this.actions.push({
      index: this.actions.length + 1,
      // start_recording itself begins slightly before the recording exists.
      offsetMs: Math.max(0, startedAt - this.startedAt.getTime()),
      ...rest,
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
   * Writes videos, the action log and the HTML report. Must be called after
   * the recording context is closed, otherwise video files are incomplete.
   */
  async finalize(traceSaved: boolean): Promise<RecordingSummary> {
    const stoppedAt = new Date();

    const videoFiles: string[] = [];
    for (const [i, video] of this.videos.entries()) {
      const file = this.videos.length === 1 ? "video.webm" : `video-${i + 1}.webm`;
      try {
        await video.saveAs(path.join(this.dir, file));
        await video.delete();
        videoFiles.push(file);
      } catch (error) {
        this.note(`Could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await rm(this.videoTmpDir, { recursive: true, force: true });

    if (!traceSaved) this.note("Trace was not saved (the browser context was lost before stopping).");

    const summary: RecordingSummary = {
      name: this.name,
      directory: this.dir,
      startedAt: this.startedAt.toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      actions: this.actions.length,
      assertions: {
        passed: this.actions.filter((a) => a.tool.startsWith("assert_") && a.ok).length,
        failed: this.actions.filter((a) => a.tool.startsWith("assert_") && !a.ok).length,
      },
      report: path.join(this.dir, "report.html"),
      trace: traceSaved ? this.tracePath : null,
      videos: videoFiles.map((file) => path.join(this.dir, file)),
      screenshots: this.screenshots.map((file) => path.join(this.dir, file)),
      notes: [...this.notes],
      viewTrace: traceSaved ? `npx playwright show-trace "${this.tracePath}"` : null,
    };

    const redactedLog = this.redact(this.actions);
    await writeFile(
      path.join(this.dir, "actions.json"),
      JSON.stringify({ ...summary, log: redactedLog }, null, 2),
    );
    await writeFile(summary.report, this.renderReport(summary, videoFiles, redactedLog));
    return summary;
  }

  private renderReport(summary: RecordingSummary, videoFiles: string[], actions: ActionLogEntry[]): string {
    const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
    const rows = actions
      .map(
        (a) => `<tr class="${a.ok ? "ok" : "err"}">
  <td>${a.index}</td><td>${seconds(a.offsetMs)}</td><td><code>${escapeHtml(a.tool)}</code></td>
  <td><pre>${escapeHtml(JSON.stringify(a.args, null, 1) ?? "")}</pre></td>
  <td>${a.ok ? "ok" : "error"}</td><td>${a.durationMs}ms</td><td><pre>${escapeHtml(a.summary)}</pre></td>
</tr>`,
      )
      .join("\n");
    const videos = videoFiles
      .map((file) => `<video controls preload="metadata" src="${escapeHtml(file)}"></video>`)
      .join("\n");
    const shots = this.screenshots
      .map((file) => `<a href="${escapeHtml(file)}"><img src="${escapeHtml(file)}" alt="${escapeHtml(file)}"></a>`)
      .join("\n");
    const notes = summary.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("\n");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Recording: ${escapeHtml(summary.name)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1b1b1b; }
  h1 { margin-bottom: .2rem; } .meta { color: #666; margin-top: 0; }
  video { width: 100%; max-height: 70vh; background: #000; border-radius: 6px; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #ddd; padding: .4rem; text-align: left; vertical-align: top; }
  tr.err td { background: #fdecec; } pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }
  .shots img { width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .good { color: #1a7f37; } .bad { color: #c62828; }
  code.cmd { display: block; background: #f4f4f4; padding: .6rem; border-radius: 4px; }
</style></head><body>
<h1>${escapeHtml(summary.name)}</h1>
<p class="meta">${escapeHtml(summary.startedAt)} &rarr; ${escapeHtml(summary.stoppedAt)} &middot; ${summary.actions} tool call(s)${
      summary.assertions.passed + summary.assertions.failed > 0
        ? ` &middot; assertions: <strong class="${summary.assertions.failed ? "bad" : "good"}">${summary.assertions.passed} passed, ${summary.assertions.failed} failed</strong>`
        : ""
    }</p>
${videos ? `<h2>Video</h2>\n${videos}` : ""}
${
  summary.viewTrace
    ? `<h2>Trace</h2><p>Step-by-step DOM snapshots, network and console for every action. Open with:</p>
<code class="cmd">${escapeHtml(summary.viewTrace)}</code>
<p>or drag <code>trace.zip</code> onto <a href="https://trace.playwright.dev">trace.playwright.dev</a> (runs locally in your browser).</p>`
    : ""
}
<h2>Tool calls</h2>
<table><thead><tr><th>#</th><th>At</th><th>Tool</th><th>Args</th><th>Status</th><th>Took</th><th>Result</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">No tool calls were recorded.</td></tr>'}
</tbody></table>
${shots ? `<h2>Screenshots</h2>\n<div class="shots">${shots}</div>` : ""}
${notes ? `<h2>Notes</h2>\n<ul>${notes}</ul>` : ""}
</body></html>
`;
  }
}
