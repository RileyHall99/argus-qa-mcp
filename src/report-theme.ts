/**
 * Argus brand theme for report.html: the logo, the header bar and the
 * stylesheet. Brand palette: Obsidian Slate #0B0F19, Alabaster White #F8FAFC,
 * Gilded Amber #F59E0B, Sentinel Emerald #10B981, Vigilant Crimson #EF4444.
 *
 * The brand colors are used as fills, bars and borders. Text that sits on a
 * light background uses deeper shades of the same hues so it stays readable
 * (amber and emerald text on white would fail contrast). The report follows
 * the viewer's light/dark system setting and always prints light.
 *
 * Fonts are not downloaded: reports are opened offline and may hold
 * sensitive data, so Inter / JetBrains Mono are used only when installed.
 */
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/** The Argus eye: an amber iris watching from an obsidian ground. */
const EYE_PATHS =
  '<path d="M3 16C7.5 8.6 24.5 8.6 29 16C24.5 23.4 7.5 23.4 3 16Z" fill="none" stroke="#F59E0B" stroke-width="2.2" stroke-linejoin="round"/>' +
  '<circle cx="16" cy="16" r="5.6" fill="#F59E0B"/><circle cx="16" cy="16" r="2.4" fill="#0B0F19"/><circle cx="17.6" cy="14.4" r="1" fill="#F8FAFC"/>';

export const ARGUS_LOGO: string = `<svg class="logo" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">${EYE_PATHS}</svg>`;

export const ARGUS_FAVICON: string = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0B0F19"/>${EYE_PATHS}</svg>`,
)}`;

/** The full-width brand bar at the top of the report; `verdict` is the class and label of the status pill. */
export function brandBar(verdict: { tone: string; label: string }): string {
  return `<header class="brandbar">
  <div class="brandbar-inner">
    <a class="brand" href="https://github.com/RileyHall99/argus-qa-mcp" title="Argus QA MCP">${ARGUS_LOGO}<span class="wordmark">ARGUS</span></a>
    <span class="brand-divider" aria-hidden="true"></span>
    <span class="brand-kind">QA report</span>
    <span class="brand-spacer"></span>
    <span class="verdict-pill ${verdict.tone}">${verdict.label}</span>
    <code class="brand-version">${SERVER_NAME} v${SERVER_VERSION}</code>
  </div>
</header>`;
}

export const REPORT_CSS: string = `
  :root {
    color-scheme: light;
    --obsidian: #0B0F19; --alabaster: #F8FAFC; --amber: #F59E0B; --emerald: #10B981; --crimson: #EF4444;
    --bg: var(--alabaster); --surface: #FFFFFF; --surface-2: #F1F5F9;
    --ink: var(--obsidian); --muted: #556072; --line: #E2E8F0;
    --accent-ink: #B45309; --accent-soft: #FEF3C7;
    --pass-ink: #047857; --pass-soft: #ECFDF5;
    --fail-ink: #B91C1C; --fail-soft: #FEF2F2; --fail-line: #FECACA;
    --agent: #8B5CF6; --agent-ink: #5B21B6; --agent-soft: #F5F3FF;
    --neutral-soft: #F1F5F9;
    --font-sans: Inter, "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: var(--obsidian); --surface: #111725; --surface-2: #182032;
      --ink: var(--alabaster); --muted: #94A3B8; --line: #253047;
      --accent-ink: #FBBF24; --accent-soft: rgba(245, 158, 11, .13);
      --pass-ink: #34D399; --pass-soft: rgba(16, 185, 129, .12);
      --fail-ink: #F87171; --fail-soft: rgba(239, 68, 68, .11); --fail-line: rgba(239, 68, 68, .38);
      --agent-ink: #C4B5FD; --agent-soft: rgba(139, 92, 246, .14);
      --neutral-soft: #182032;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 var(--font-sans); }
  a { color: var(--accent-ink); }
  code, pre, kbd { font-family: var(--font-mono); }
  code { font-size: 12px; background: var(--surface-2); padding: .05rem .3rem; border-radius: 4px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .muted { color: var(--muted); } .small { font-size: 12px; }

  /* Brand bar: always obsidian, in both themes and in print. */
  .brandbar { background: var(--obsidian); color: var(--alabaster); border-bottom: 2px solid var(--amber); padding-top: env(safe-area-inset-top, 0px); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .brandbar-inner { max-width: 1140px; margin: 0 auto; padding: .7rem 1.25rem; display: flex; align-items: center; flex-wrap: wrap; gap: .4rem .85rem; }
  .brand { display: inline-flex; align-items: center; gap: .55rem; color: var(--alabaster); text-decoration: none; }
  .brand .logo { filter: drop-shadow(0 0 6px rgba(245, 158, 11, .45)); }
  .wordmark { font-weight: 800; font-size: 1.25rem; letter-spacing: .22em; }
  .brand-divider { width: 1px; height: 1.3rem; background: #334155; }
  .brand-kind { color: #CBD5E1; font-weight: 500; }
  .brand-spacer { flex: 1 1 auto; }
  .brand-version { background: transparent; color: #94A3B8; font-size: 11.5px; padding: 0; }
  .verdict-pill { font-size: 11px; font-weight: 800; letter-spacing: .08em; padding: .2rem .65rem; border-radius: 999px; color: var(--obsidian); }
  .verdict-pill.passed { background: var(--emerald); } .verdict-pill.failed { background: var(--crimson); } .verdict-pill.no-checks { background: #CBD5E1; }

  main { max-width: 1140px; margin: 0 auto; padding: 1.6rem 1.25rem 3rem; }
  .eyebrow { margin: 0 0 .2rem; font-size: 11.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent-ink); }
  h1 { margin: 0 0 .2rem; font-size: 1.9rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.2; overflow-wrap: anywhere; }
  .site-address { margin: 0 0 .5rem; font-family: var(--font-mono); font-size: 13px; overflow-wrap: anywhere; }
  .site-address a { font-weight: 600; text-decoration: none; } .site-address a:hover { text-decoration: underline; }
  .run-meta { margin: 0; font-size: 13px; }
  .run-meta strong { color: var(--ink); }
  .run-time { font-family: var(--font-mono); font-size: 12px; }

  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 1rem 0 0; }
  .toolbar button { font: inherit; font-size: 12px; font-weight: 600; padding: .3rem .8rem; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); cursor: pointer; }
  .toolbar button:hover { border-color: var(--amber); }
  .toolbar button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

  details.section { border-top: 1px solid var(--line); margin-top: 1.3rem; }
  details.section > summary { list-style: none; display: flex; align-items: baseline; gap: .7rem; padding: .85rem 0 .45rem; cursor: pointer; user-select: none; }
  details.section > summary::-webkit-details-marker { display: none; }
  details.section > summary::before { content: "\\25B8"; color: var(--muted); display: inline-block; transition: transform .15s; }
  details.section[open] > summary::before { transform: rotate(90deg); color: var(--amber); }
  details.section > summary h2 { margin: 0; font-size: 1.2rem; font-weight: 750; }
  details.section > summary:hover h2 { color: var(--accent-ink); }
  .section-body { padding-bottom: .6rem; }

  .verdict { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.2rem; border-radius: 10px; margin: .4rem 0 1rem; border-left: 5px solid; background: var(--surface); }
  .verdict.passed { background: var(--pass-soft); border-color: var(--emerald); } .verdict.failed { background: var(--fail-soft); border-color: var(--crimson); } .verdict.no-checks { background: var(--neutral-soft); border-color: var(--muted); }
  .verdict .big { font-size: 1.6rem; font-weight: 800; letter-spacing: .06em; }
  .verdict.passed .big { color: var(--pass-ink); } .verdict.failed .big { color: var(--fail-ink); }
  .stats { display: flex; flex-wrap: wrap; gap: .75rem; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .6rem .9rem; min-width: 110px; }
  .stat .value { font-size: 1.4rem; font-weight: 750; font-variant-numeric: tabular-nums; } .stat .label { color: var(--muted); font-size: 12px; }
  .stat.good { border-top: 3px solid var(--emerald); } .stat.good .value { color: var(--pass-ink); }
  .stat.bad { border-top: 3px solid var(--crimson); } .stat.bad .value { color: var(--fail-ink); }

  /* Badges: obsidian text on the brand status colors. */
  .badge { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .04em; padding: .1rem .45rem; border-radius: 4px; color: var(--obsidian); }
  .badge.pass { background: var(--emerald); } .badge.fail { background: var(--crimson); }

  .table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--line); padding: .5rem .6rem; text-align: left; vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  th { font-size: 11.5px; color: var(--muted); font-weight: 650; text-transform: uppercase; letter-spacing: .04em; background: var(--surface-2); }
  tr.fail td { background: var(--fail-soft); }
  tr.fail td:first-child { box-shadow: inset 3px 0 0 var(--crimson); }
  td.page { font-size: 12px; color: var(--muted); word-break: break-all; }

  .error-card { border: 1px solid var(--fail-line); border-left: 4px solid var(--crimson); background: var(--fail-soft); border-radius: 8px; padding: .8rem 1rem; margin: .75rem 0; }
  .error-card p { margin: .4rem 0; }
  .suggestion { background: var(--accent-soft); border-left: 3px solid var(--amber); padding: .35rem .6rem; border-radius: 0 6px 6px 0; }
  .suggestion strong { color: var(--accent-ink); }
  .empty { color: var(--muted); font-style: italic; }

  video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; margin-bottom: 1rem; border: 1px solid var(--line); }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }
  .shots img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  code.cmd { display: block; background: var(--obsidian); color: var(--alabaster); padding: .7rem .8rem; border-radius: 6px; word-break: break-all; border-left: 3px solid var(--amber); }
  code.cmd::before { content: "$ "; color: var(--amber); }
  details summary { cursor: pointer; font-weight: 600; }

  /* Explanation and screenshot side by side; stacked only on narrow screens. */
  .evidence { display: flex; gap: .9rem; align-items: flex-start; }
  .evidence .why { flex: 1 1 auto; min-width: 0; }
  .shot { flex: 0 0 200px; display: block; text-decoration: none; color: var(--muted); font-size: 11px; text-align: center; }
  .shot img { display: block; width: 100%; border: 1px solid var(--fail-line); border-radius: 4px; margin-bottom: .2rem; background: #fff; }
  a.shot:hover img { border-color: var(--amber); }
  td.why-col { min-width: 400px; }
  td.fix-col { min-width: 220px; }

  .agent-fix { border-left: 3px solid var(--agent); background: var(--agent-soft); padding: .4rem .6rem; border-radius: 0 6px 6px 0; }
  .agent-fix p { margin: .25rem 0; white-space: pre-wrap; }
  .agent-fix-block { margin-top: .6rem; } .fix-label { font-size: 12px; font-weight: 700; color: var(--agent-ink); margin-bottom: .2rem; }
  .target { display: inline-block; font-size: 11px; font-weight: 700; padding: .05rem .45rem; border-radius: 4px; background: var(--agent-soft); color: var(--agent-ink); border: 1px solid var(--agent); }
  .target.app { background: var(--fail-soft); color: var(--fail-ink); border-color: var(--crimson); }
  .target.environment { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--amber); }

  .seek { display: inline-block; margin-top: .45rem; padding: .15rem .6rem; border-radius: 999px; background: var(--amber); color: var(--obsidian); font-size: 12px; font-weight: 700; text-decoration: none; }
  a.seek:hover { background: #FBBF24; }
  .attachment { background: var(--accent-soft); border-left: 3px solid var(--amber); padding: .5rem .7rem; border-radius: 0 6px 6px 0; }

  .report-footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); display: flex; align-items: center; gap: .5rem; color: var(--muted); font-size: 12px; }
  .report-footer .logo { width: 18px; height: 18px; }

  @media (max-width: 760px) {
    .evidence { flex-wrap: wrap; } .shot { flex-basis: 100%; } td.why-col, td.fix-col { min-width: 0; }
    .brand-divider, .brand-kind { display: none; }
  }
  @media print {
    :root { color-scheme: light; --bg: #fff; --surface: #fff; --surface-2: #F1F5F9; --ink: #0B0F19; --muted: #556072; --line: #E2E8F0;
      --accent-ink: #B45309; --accent-soft: #FEF3C7; --pass-ink: #047857; --pass-soft: #ECFDF5; --fail-ink: #B91C1C; --fail-soft: #FEF2F2; --fail-line: #FECACA;
      --agent-ink: #5B21B6; --agent-soft: #F5F3FF; --neutral-soft: #F1F5F9; }
    .no-print, details.section:not([open]) { display: none; }
    .badge, .verdict-pill, tr.fail td, .verdict, .error-card { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

/** The eye as a 56 px PNG, for email: most email clients don't show SVG. */
const ARGUS_LOGO_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAADgAAAA4CAYAAACohjseAAAFhUlEQVR4nOxYa2wUVRQ+d7bQ7kyDMQZoERMECqJBASWhiTGRaFAqPlCRhMpjW2JMwCg2ahN+EOsjGjSSlF+lLViqWI1RXEyQ6A8Tm/omKsYUCAZ16UMxSmd2Sztz+Ga3XXZn785uHwSmmS/dzsy95/Xd57lXoQkOhSY4fIJeh0/Q6/AJeh0+Qa/DJ+h1+AS9Dp+g11FAlwB6i1pKJs0gi0rxOYMEnhZdG39PIIKm/YuYzsTf8WMhIsWb9C4aZwgaB3ATTTWEugokVuHzLhKimEYBZjoniD9jEmFtUA+LJ+hvGiNGTVBvUpfgcd/Q7zaYkttC1BleeMhz/JktBFuRvsEvjN4No3eP0igwIoLcRpMNXa1kFs9C8cYc0gkCcS9Z3AyTdyWatHYM/3aiZ1vRswOUJ/ImaDQFn8LQqYVKiasgs4FgjmOolZFQVMoHzH3QOQmO82A/mEPWnrcva1XGbsoDOQn2NWjTsSC0wfkd2WRsQnh8CmuHhMmTSRFhGg0svp8VcR5vK9FAFQhvTlafTF9izq8p3qx3u5l0Jag3qvei194FuaskHk4hiHqFrYNF1f0n4kWtdLURU49huJXSaMAcUdlYKKrprP0Zayycb5FSgRi2wOb1meL0Hxr/UczPI9lMZiXY16RtQOVeSRQ/4N+LWsj4WKJzADqPyeydH2Tq7Epsu/NmBqlw9oNQ+J24p91pfx9sb3TqG43Bh7HYbEfIi5x1CpuVwapYq8yvlGBfo/YCeu1Vh2NdMG8PhqK7UMcZOs1aiUjsaxlo+24SPf9BIen9CYLvtOyhFfesiL9bX6wmjnye4oYtdZJRKtZTj9MO7yAlel3wafRoHXpUTVVCRFtl8zIjk4k2FVU6ydlzTDGthWpV9C0ZuSEskhUe+LqAtrQGk+RsLCsvvygw65F0BSEU3dSWyGyJHWQhhjcDbN6CqE6mKuGvHr28xqmTRtBoCM40KbDbQe5nzdKXBTfHTpELhMXLZOV14cKMspqaWjp9+k/qaP+K6GhdppIlb6xh2HNeJaMcsf2WpiaUBnskpZalEbQCyjaM2SnJAizJ2oC+fHjSu0JQBsGe/4l6+wIZoh9+dJAW31pOFQ+spe6uSKYpIW+sNJkQ9cLnnSDZezEEmoJF75lUOddkG5O6jy4PivIR0gK6hRlzzk0mjSAWkZ1okX+S30RlxiT1MO+jaygH4CgjlZqGsTB3qplV54aSwbhMPrac4Ldpmj6gYXsQs5NlTGeRZe1KlUsjiFXIHi/rHO6WGINqR7S5aBa5wSJpUC89FMuq8srq/hHZGkZsb+EcxNSOpeXmtAqF1g5xSClyoDikH0ZTPDmU7CYgxFyLlV+wSm1FqXRrCQRMaVDLF5hUvy5KWqGVLLPf7bLby+S9KwLcISu3fSOGbaYZ+Ck9y2F0HK2XbfhZN3qcFqpR3SBx8z2G8utYrtucNdg/30OrrpHZS9voSyyaXJDV9ftaSM+wYW8BWBNqZRv9ELkWmTH3VK1ZDUG7UVo5nKoVWOGiDf2d8aKxp2pn1CLjJrGO/rU/c6VqNhQyHw+GYvuzmcyZbIPkUrZEC3pmPmUP7ARa99CYk22TK7hAWNhTV8LWStdkm+hXbCcbtU3Gt24m8z8uYeyjNZ8D0enukhyF9044n8ekBPOxLciKWiyOw3ZZzuMScRemyGt2VkV52R4BkgdeS9QgmAU5pPN0kZ9c/MBL9AYSj/2X5MDrhL5HXQztxJWFoKUux/b0V0H5X1kw2cMvjGdYqzZ+pFFgfC+dGGSZ7h7TpZPgI/FLpwH9k8t66eSG+LXhAK4KBZWA8My0a8PEaSSCZyR+bcj0B967r+hrwysZ/tW91+ET9Dp8gl6HT9Dr8Al6HT5Br8Mn6HVMeIIXAAAA//9DBvvoAAAABklEQVQDAGcsJqA0zDucAAAAAElFTkSuQmCC";

/** Content-ID the email body uses to show the attached logo. */
export const ARGUS_LOGO_PNG_CID: string = "argus-logo@argus-qa";

export function argusLogoPng(): Buffer {
  return Buffer.from(ARGUS_LOGO_PNG_BASE64, "base64");
}
