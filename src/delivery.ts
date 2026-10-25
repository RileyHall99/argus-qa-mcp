/**
 * Sends finished recordings to people who can't see the test machine (the
 * agent may run on a third-party server): a webhook notification as soon as
 * the assessment finishes, and the report by email.
 *
 * The email waits until the agent has suggested a fix for every failure (the
 * report is most useful then), but no longer than ARGUS_EMAIL_WAIT_SECONDS.
 *
 * Recipients and endpoints come only from the environment, never from tool
 * arguments, so a page under test can't talk the agent into mailing the
 * report elsewhere.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import type { Recording, RecordingSummary } from "./recorder.js";
import { ARGUS_LOGO_PNG_CID, argusLogoPng } from "./report-theme.js";

function log(message: string): void {
  console.error(`[argus-qa-mcp] ${message}`);
}

/** A plain address only: no display names, comments or groups. */
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const NOTIFY_TIMEOUT_MS = 10_000;
const SMTP_TIMEOUT_MS = 30_000;

interface EmailConfig {
  to: string[];
  from: string;
  transport: { host: string; port: number; secure: boolean; requireTLS: boolean; auth?: { user: string; pass: string } };
  attachVideo: boolean;
  maxBytes: number;
  waitMs: number;
}

export interface DeliveryConfig {
  email?: EmailConfig;
  webhook?: URL;
  /** Configuration problems, reported in stop_recording instead of failing silently. */
  emailProblems: string[];
  notifyProblems: string[];
}

/** Outcome of delivery for one recording, as shown to the agent. */
export interface DeliveryStatus {
  notification?: string;
  email?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function deliveryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DeliveryConfig {
  const config: DeliveryConfig = { emailProblems: [], notifyProblems: [] };
  const problems = config.emailProblems;

  const hook = env["ARGUS_NOTIFY_WEBHOOK"]?.trim();
  if (hook) {
    try {
      const url = new URL(hook);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
      config.webhook = url;
    } catch {
      config.notifyProblems.push("ARGUS_NOTIFY_WEBHOOK is not a valid http(s) URL, so no notification is sent.");
    }
  }

  const to = list(env["ARGUS_EMAIL_TO"]);
  if (to.length === 0) return config;
  const badTo = to.filter((a) => !PLAIN_ADDRESS.test(a));
  const host = env["ARGUS_SMTP_HOST"]?.trim();
  const user = env["ARGUS_SMTP_USER"]?.trim();
  const from = env["ARGUS_EMAIL_FROM"]?.trim() || user || "";
  if (badTo.length) problems.push(`ARGUS_EMAIL_TO has invalid address(es): ${badTo.join(", ")}. Use plain addresses like client@example.com.`);
  if (!host) problems.push("ARGUS_EMAIL_TO is set but ARGUS_SMTP_HOST is not, so the report can't be emailed.");
  if (!PLAIN_ADDRESS.test(from)) problems.push("Set ARGUS_EMAIL_FROM (or ARGUS_SMTP_USER) to a plain sender address like argus@example.com.");
  if (badTo.length || !host || !PLAIN_ADDRESS.test(from)) return config;

  const port = positiveNumber(env["ARGUS_SMTP_PORT"], 587);
  const secure = bool(env["ARGUS_SMTP_SECURE"], port === 465);
  const local = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host!);
  const pass = env["ARGUS_SMTP_PASS"] ?? "";
  config.email = {
    to,
    from,
    transport: {
      host: host!,
      port,
      secure,
      // Never send the password in clear text to a remote server.
      requireTLS: !secure && bool(env["ARGUS_SMTP_REQUIRE_TLS"], !local),
      ...(user ? { auth: { user, pass } } : {}),
    },
    attachVideo: bool(env["ARGUS_EMAIL_ATTACH_VIDEO"], true),
    maxBytes: positiveNumber(env["ARGUS_EMAIL_MAX_MB"], 20) * 1024 * 1024,
    waitMs: positiveNumber(env["ARGUS_EMAIL_WAIT_SECONDS"], 180) * 1000,
  };
  return config;
}

/** "step 4" / "steps 4, 9". */
function stepList(steps: number[]): string {
  return `step${steps.length === 1 ? "" : "s"} ${steps.join(", ")}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const VERDICT_LABEL: Record<RecordingSummary["verdict"], string> = { passed: "PASSED", failed: "FAILED", "no checks": "NO CHECKS" };

/** "2 checks failed, 7 steps errored" / "all 22 checks passed". */
function outcome(summary: RecordingSummary): string {
  const { passed, failed } = summary.assertions;
  if (summary.verdict === "passed") return `all ${plural(passed, "check")} passed`;
  if (summary.verdict === "no checks") return `no checks were run${summary.toolErrors.length ? `, ${plural(summary.toolErrors.length, "step")} errored` : ""}`;
  return [failed ? `${failed} of ${passed + failed} checks failed` : "", summary.toolErrors.length ? `${plural(summary.toolErrors.length, "step")} errored` : ""]
    .filter(Boolean)
    .join(", ");
}

/**
 * A failure's explanation shortened for the email body: the page's full text
 * (from "Actual text on the page:") is cut to a few lines, since the attached
 * report has it all.
 */
function brief(why: string): string {
  const lines = why.split("\n");
  const actual = lines.findIndex((l) => l.startsWith("Actual text"));
  const kept = actual === -1 ? lines : [...lines.slice(0, actual + 1), ...lines.slice(actual + 1).filter((l) => l.trim()).slice(0, 3)];
  let text = kept.join("\n");
  if (text.length > 500) text = `${text.slice(0, 499)}…`;
  return text.length < why.length ? `${text}\n… (full text in the attached report)` : text;
}

function siteLabel(summary: RecordingSummary): string {
  return summary.site ? summary.site.name : summary.name;
}

/** Subject and body text are built from page titles, which the tested site controls: keep them to one plain line. */
function oneLine(value: string, max = 140): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class ReportDelivery {
  private transporter: Transporter | undefined;
  /** Emails waiting for the agent's suggested fixes, by recording. */
  private readonly pending = new Map<Recording, { timer: NodeJS.Timeout; done: Promise<string> | undefined }>();

  constructor(private readonly config: DeliveryConfig) {
    for (const problem of [...config.emailProblems, ...config.notifyProblems]) log(`Delivery: ${problem}`);
  }

  get emailEnabled(): boolean {
    return this.config.email !== undefined;
  }

  /**
   * Called when a recording is saved: notifies the webhook now, and emails the
   * report now or once every failure has a suggested fix.
   */
  async recordingStopped(recording: Recording, summary: RecordingSummary, withoutFix: number[]): Promise<DeliveryStatus | undefined> {
    const status: DeliveryStatus = {};
    if (this.config.webhook) status.notification = await this.notify(this.config.webhook, summary);
    const email = this.config.email;
    if (email) {
      if (withoutFix.length === 0 || email.waitMs === 0) {
        status.email = await this.send(recording);
      } else {
        const timer = setTimeout(() => void this.flushOne(recording), email.waitMs);
        timer.unref();
        this.pending.set(recording, { timer, done: undefined });
        status.email =
          `The report will be emailed to ${email.to.join(", ")} once every failure has a suggested fix ` +
          `(call suggest_fix for ${stepList(withoutFix)}), or in ${Math.round(email.waitMs / 1000)} s regardless.`;
      }
    } else if (this.config.emailProblems.length) {
      status.email = `Not emailed: ${this.config.emailProblems.join(" ")}`;
    }
    if (this.config.notifyProblems.length) status.notification = `Not sent: ${this.config.notifyProblems.join(" ")}`;
    return status.email || status.notification ? status : undefined;
  }

  /** Called after each suggest_fix; sends a waiting email once nothing is left to fix. */
  async suggestionAdded(recording: Recording, withoutFix: number[]): Promise<string | undefined> {
    if (!this.pending.has(recording)) return undefined;
    if (withoutFix.length > 0) return `The report will be emailed once ${stepList(withoutFix)} also ${withoutFix.length === 1 ? "has" : "have"} a suggested fix.`;
    return this.flushOne(recording);
  }

  /** Sends every waiting email now (a new recording started, or the server is shutting down). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((recording) => this.flushOne(recording)));
  }

  private flushOne(recording: Recording): Promise<string> {
    const entry = this.pending.get(recording);
    if (!entry) return Promise.resolve("Already emailed.");
    clearTimeout(entry.timer);
    entry.done ??= this.send(recording).finally(() => this.pending.delete(recording));
    return entry.done;
  }

  private async notify(url: URL, summary: RecordingSummary): Promise<string> {
    const site = summary.site;
    const text =
      `Argus finished assessing ${oneLine(siteLabel(summary), 100)}${site?.address.startsWith("http") ? ` (${site.address})` : ""}: ` +
      `${VERDICT_LABEL[summary.verdict]}, ${outcome(summary)}` +
      `${summary.pageErrors ? `, ${plural(summary.pageErrors, "website error")}` : ""}.` +
      (this.config.email ? ` The report is being emailed to ${plural(this.config.email.to.length, "recipient")}.` : "");
    const host = url.hostname;
    const body = host === "hooks.slack.com"
      ? { text }
      : /(^|\.)discord(app)?\.com$/.test(host)
        ? { content: text }
        : {
            event: "assessment.finished",
            text,
            verdict: summary.verdict,
            site: site ?? null,
            recording: summary.name,
            startedAt: summary.startedAt,
            stoppedAt: summary.stoppedAt,
            assertions: summary.assertions,
            stepErrors: summary.toolErrors.length,
            websiteErrors: summary.pageErrors,
            failedChecks: summary.failedChecks.map((c) => ({ step: c.step, check: c.check, reason: c.reason })),
            reportEmailed: this.config.email !== undefined,
          };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!response.ok) return `Webhook notification failed: HTTP ${response.status} from ${host}.`;
      return `Notified ${host} that the assessment finished.`;
    } catch (error) {
      log(`Webhook notification failed: ${error instanceof Error ? error.message : String(error)}`);
      return `Webhook notification failed: could not reach ${host} (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  private async send(recording: Recording): Promise<string> {
    const email = this.config.email!;
    const summary = recording.lastSummary;
    if (!summary) return "Not emailed: the recording was not saved.";
    try {
      // Videos are attached in order while they fit; the report (with inlined images) always goes.
      const attachedVideos: string[] = [];
      const skippedVideos: string[] = [];
      let draft = await recording.portableReport([]);
      let used = Buffer.byteLength(draft) * 1.37;
      for (const videoPath of email.attachVideo ? summary.videos : []) {
        const size = (await stat(videoPath).catch(() => undefined))?.size;
        if (size !== undefined && used + size * 1.37 <= email.maxBytes) {
          attachedVideos.push(path.basename(videoPath));
          used += size * 1.37;
        } else {
          skippedVideos.push(path.basename(videoPath));
        }
      }
      if (attachedVideos.length) draft = await recording.portableReport(attachedVideos);

      const label = oneLine(siteLabel(summary), 80);
      const subject = `[Argus] ${VERDICT_LABEL[summary.verdict]}: ${label} · ${oneLine(outcome(summary), 80)}`;
      this.transporter ??= nodemailer.createTransport({
        ...email.transport,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      await this.transporter.sendMail({
        from: { name: "Argus QA", address: email.from },
        to: email.to,
        subject,
        text: emailText(summary, attachedVideos, skippedVideos),
        html: emailHtml(summary, attachedVideos, skippedVideos),
        attachments: [
          { filename: "report.html", content: draft, contentType: "text/html; charset=utf-8" },
          ...attachedVideos.map((file) => ({ filename: file, path: path.join(summary.directory, file), contentType: "video/webm" })),
          { filename: "argus.png", content: argusLogoPng(), cid: ARGUS_LOGO_PNG_CID, contentType: "image/png" },
        ],
      });
      const sent = `Report emailed to ${email.to.join(", ")}${attachedVideos.length ? ` with ${attachedVideos.join(", ")}` : ""}.`;
      log(sent);
      return skippedVideos.length ? `${sent} Not attached (over ARGUS_EMAIL_MAX_MB or disabled): ${skippedVideos.join(", ")}.` : sent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Emailing the report failed: ${message}`);
      return `Emailing the report failed: ${message}. The report is still saved at ${summary.report}.`;
    }
  }
}

/** What's attached and what isn't, for the email body. */
function attachmentNote(attachedVideos: string[], skippedVideos: string[]): string {
  const parts = ["The full report is attached as report.html; open it in any browser."];
  if (attachedVideos.length) parts.push(`The screen recording is attached (${attachedVideos.join(", ")}); each failure in the report gives its time in the video.`);
  if (skippedVideos.length) parts.push(`The screen recording (${skippedVideos.join(", ")}) was too large to attach and is kept with the test run.`);
  return parts.join(" ");
}

function emailText(summary: RecordingSummary, attachedVideos: string[], skippedVideos: string[]): string {
  const lines = [
    `ARGUS QA REPORT`,
    ``,
    `Website: ${oneLine(siteLabel(summary))}${summary.site ? ` (${summary.site.address})` : ""}`,
    `Result:  ${VERDICT_LABEL[summary.verdict]}, ${outcome(summary)}`,
    `Run:     ${summary.name}, ${summary.startedAt} to ${summary.stoppedAt}`,
    `Website errors: ${summary.pageErrors}`,
    ``,
  ];
  const failures = [
    ...summary.failedChecks.map((c) => ({ step: c.step, title: `Check failed: ${c.check}`, why: c.reason ?? "", fix: c.suggestedFix })),
    ...summary.toolErrors.map((e) => ({ step: e.step, title: `${e.problem} (${e.tool})`, why: e.explanation, fix: e.suggestedFix })),
  ].sort((a, b) => a.step - b.step);
  if (failures.length) {
    lines.push("WHAT FAILED", "");
    for (const f of failures) {
      lines.push(`Step ${f.step}: ${f.title}`, `  Why: ${brief(f.why).replace(/\n/g, "\n       ")}`);
      if (f.fix) lines.push(`  Suggested fix${f.fix.target ? ` (${f.fix.target})` : ""}: ${oneLine(f.fix.fix, 600)}`);
      lines.push("");
    }
  }
  lines.push(attachmentNote(attachedVideos, skippedVideos), "", "Sent by Argus QA (argus-qa-mcp).");
  return lines.join("\n");
}

/** Email-client-safe HTML: tables and inline styles only, no scripts or external images. */
function emailHtml(summary: RecordingSummary, attachedVideos: string[], skippedVideos: string[]): string {
  const tone = { passed: "#10B981", failed: "#EF4444", "no checks": "#CBD5E1" }[summary.verdict];
  const failures = [
    ...summary.failedChecks.map((c) => ({ step: c.step, title: c.check, kind: "Check failed", why: c.reason ?? "", fix: c.suggestedFix })),
    ...summary.toolErrors.map((e) => ({ step: e.step, title: e.problem, kind: e.tool, why: e.explanation, fix: e.suggestedFix })),
  ].sort((a, b) => a.step - b.step);
  const targetLabel = { app: "Fix in the app", test: "Fix in the test", environment: "Fix the environment" } as const;
  const rows = failures
    .map(
      (f) => `<tr><td style="padding:12px 0;border-top:1px solid #E2E8F0;">
  <div style="font-size:12px;color:#B91C1C;font-weight:700;">STEP ${f.step} &middot; ${escapeHtml(f.kind)}</div>
  <div style="font-size:15px;font-weight:700;margin:2px 0 4px;">${escapeHtml(oneLine(f.title, 200))}</div>
  <div style="font-size:13px;color:#334155;white-space:pre-wrap;">${escapeHtml(brief(f.why))}</div>
  ${
    f.fix
      ? `<div style="margin-top:8px;padding:8px 10px;background:#F5F3FF;border-left:3px solid #8B5CF6;font-size:13px;">
    <strong style="color:#5B21B6;">AI agent's suggested fix${f.fix.target ? ` &middot; ${targetLabel[f.fix.target]}` : ""}</strong><br>${escapeHtml(f.fix.fix)}</div>`
      : ""
  }
</td></tr>`,
    )
    .join("\n");
  const stat = (value: number | string, label: string) =>
    `<td style="padding:10px 14px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;"><div style="font-size:20px;font-weight:800;">${value}</div><div style="font-size:12px;color:#556072;">${label}</div></td>`;
  const site = summary.site;
  return `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;color:#0B0F19;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;">
<tr><td style="background:#0B0F19;border-bottom:2px solid #F59E0B;padding:14px 20px;">
  <img src="cid:${ARGUS_LOGO_PNG_CID}" width="28" height="28" alt="" style="vertical-align:middle;">
  <span style="color:#F8FAFC;font-weight:800;font-size:18px;letter-spacing:4px;vertical-align:middle;margin-left:8px;">ARGUS</span>
  <span style="color:#CBD5E1;font-size:13px;vertical-align:middle;margin-left:10px;">QA report</span>
</td></tr>
<tr><td style="padding:22px 20px 6px;">
  <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#B45309;">WEBSITE TESTED</div>
  <div style="font-size:24px;font-weight:800;margin:2px 0;">${escapeHtml(oneLine(siteLabel(summary), 120))}</div>
  ${site ? `<div style="font-family:Consolas,monospace;font-size:13px;color:#B45309;">${escapeHtml(site.address)}</div>` : ""}
  <div style="font-size:13px;color:#556072;margin-top:6px;">Test run <strong style="color:#0B0F19;">${escapeHtml(summary.name)}</strong> &middot; ${escapeHtml(summary.stoppedAt)}</div>
</td></tr>
<tr><td style="padding:14px 20px;">
  <div style="border-left:5px solid ${tone};background:${summary.verdict === "failed" ? "#FEF2F2" : summary.verdict === "passed" ? "#ECFDF5" : "#F1F5F9"};padding:12px 14px;border-radius:8px;">
    <span style="font-size:20px;font-weight:800;letter-spacing:2px;color:${summary.verdict === "failed" ? "#B91C1C" : summary.verdict === "passed" ? "#047857" : "#334155"};">${VERDICT_LABEL[summary.verdict]}</span>
    <span style="font-size:14px;margin-left:10px;">${escapeHtml(outcome(summary))}</span>
  </div>
  <table role="presentation" cellpadding="0" cellspacing="6" style="margin-top:8px;"><tr>
    ${stat(summary.assertions.passed, "checks passed")}${stat(summary.assertions.failed, "checks failed")}${stat(summary.toolErrors.length, "steps errored")}${stat(summary.pageErrors, "website errors")}
  </tr></table>
</td></tr>
${failures.length ? `<tr><td style="padding:4px 20px 8px;"><div style="font-size:16px;font-weight:800;margin-bottom:4px;">What failed</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` : ""}
<tr><td style="padding:12px 20px 20px;font-size:13px;color:#334155;">
  <div style="background:#FEF3C7;border-left:3px solid #F59E0B;padding:10px 12px;border-radius:0 6px 6px 0;">${escapeHtml(attachmentNote(attachedVideos, skippedVideos))}</div>
</td></tr>
<tr><td style="padding:12px 20px;border-top:1px solid #E2E8F0;font-size:12px;color:#556072;">Sent by Argus QA &middot; argus-qa-mcp</td></tr>
</table></td></tr></table></body></html>`;
}
