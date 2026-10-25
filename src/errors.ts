/**
 * Turns raw Playwright/tool error messages into plain-language explanations:
 * what went wrong, the likely cause, and what to try next. Used for the text
 * returned to the agent and for the recording report.
 *
 * Playwright's messages end with a "Call log" describing every step it took;
 * the last steps reveal the real cause (element never found, found but
 * hidden, covered by another element, ...), so the whole message is parsed.
 */

export interface ErrorExplanation {
  /** Short headline, e.g. "Element not found". */
  title: string;
  /** One or two sentences on what happened, in plain language. */
  explanation: string;
  /** What to try next, when there is a useful suggestion. */
  suggestion?: string;
}

const SNAPSHOT_HINT = "Use get_page_snapshot to see what is on the page and use its aria-ref selectors.";

/** Matches the call-log line naming what Playwright was looking for. */
const WAITING_FOR = /^\s*- waiting for ((?:locator|getBy\w+)\(.+)$/m;

/**
 * Readable target from the call log, e.g. `"#email"`, `text "Hello"` or
 * `"#cardnumber" inside iframe "#card-frame"`; "the selector" if unknown.
 */
function selectorFrom(message: string): string {
  const chain = WAITING_FOR.exec(message)?.[1];
  if (!chain) return "the selector";
  const parts = [...chain.matchAll(/(locator|getBy\w+)\('(.+?)'(?:,[^)]*)?\)/g)].map(([, kind, value]) =>
    kind === "getByText" ? `text "${value}"` : `"${value}"`,
  );
  if (parts.length === 0) return "the selector";
  const target = parts[parts.length - 1]!;
  return parts.length > 1 ? `${target} inside iframe ${parts.slice(0, -1).join(" > ")}` : target;
}

function timeoutFrom(message: string): string {
  const ms = /Timeout (\d+)ms exceeded/.exec(message)?.[1];
  return ms ? `${ms} ms` : "the timeout";
}

const NETWORK_ERRORS: Record<string, [string, string, string?]> = {
  ERR_NAME_NOT_RESOLVED: ["Domain not found", "The domain name could not be resolved (DNS lookup failed).", "Check the URL for typos, and that the site is reachable from this machine."],
  ERR_CONNECTION_REFUSED: ["Connection refused", "The server refused the connection; nothing is listening at that address and port.", "Make sure the app or dev server is running and the port is correct."],
  ERR_CONNECTION_RESET: ["Connection reset", "The server dropped the connection mid-request.", "The server may have crashed or restarted; try again."],
  ERR_CONNECTION_TIMED_OUT: ["Connection timed out", "The server did not respond in time.", "Check the server is up and reachable (VPN, firewall)."],
  ERR_TIMED_OUT: ["Connection timed out", "The request took too long and was abandoned."],
  ERR_INTERNET_DISCONNECTED: ["No internet connection", "This machine appears to be offline."],
  ERR_ADDRESS_UNREACHABLE: ["Address unreachable", "The network address could not be reached."],
  ERR_UNSAFE_PORT: ["Port blocked by the browser", "Chromium refuses to connect to this port for security reasons.", "Serve the site on a common port such as 3000, 8080 or 4173."],
  ERR_TOO_MANY_REDIRECTS: ["Redirect loop", "The page redirected too many times, usually a redirect loop on the server (often login or HTTPS rules)."],
  ERR_BLOCKED_BY_CLIENT: ["Blocked by Argus", "Argus blocked this request (host allowlist or payment guard)."],
  ERR_ABORTED: ["Navigation aborted", "The navigation was cancelled, for example by a redirect, a download, or another navigation starting."],
  ERR_EMPTY_RESPONSE: ["Empty response", "The server closed the connection without sending anything."],
  ERR_SSL_PROTOCOL_ERROR: ["TLS/SSL error", "The secure connection could not be established."],
};

export function explainError(message: string): ErrorExplanation {
  // --- Argus's own errors -------------------------------------------------
  if (message.startsWith("ASSERTION FAILED: ")) {
    return { title: "Assertion failed", explanation: message.slice("ASSERTION FAILED: ".length) };
  }
  if (message.startsWith("Payment guard:")) {
    return {
      title: "Blocked by payment guard",
      explanation: message.replace(/^Payment guard:\s*(\w)/, (_match, first: string) => first.toUpperCase()),
      suggestion: "Point the test at a staging site that uses the payment provider's test mode (e.g. Stripe pk_test_ keys).",
    };
  }
  if (message.startsWith("Host not allowed")) {
    return { title: "Blocked by host allowlist", explanation: message, suggestion: "Add the host to ARGUS_ALLOWED_HOSTS if it should be tested." };
  }
  if (message.includes("Chromium for Playwright is not installed") || message.includes("ARGUS_BROWSER_CHANNEL")) {
    return { title: "Browser not available", explanation: message };
  }
  if (message.startsWith("Invalid arguments")) {
    return { title: "Invalid arguments", explanation: message.replace(/^Invalid arguments:\s*/, "The tool was called with invalid input: ") };
  }

  // --- Selector problems ----------------------------------------------------
  if (/while parsing (css )?selector|Unknown engine/.test(message)) {
    return {
      title: "Invalid selector",
      explanation: `The selector could not be parsed: ${message.split("\n")[0]?.replace(/^\w+\.\w+:\s*/, "")}`,
      suggestion: 'Check the syntax. Supported forms: CSS ("#id"), text=, role=, xpath= and aria-ref=eN.',
    };
  }

  // --- Element interaction failures (read the call log) ---------------------
  const selector = selectorFrom(message);
  if (/Element is not a <select> element/.test(message)) {
    return { title: "Not a dropdown", explanation: `${selector} matched an element that is not a <select>.`, suggestion: "Custom dropdowns are usually clicked open and then an option clicked." };
  }
  if (/Element is not an <input>, <textarea>/.test(message)) {
    return { title: "Not a text field", explanation: `${selector} matched an element that cannot be typed into.`, suggestion: SNAPSHOT_HINT };
  }
  if (/did not find some options/.test(message)) {
    return { title: "Option not found", explanation: `The dropdown ${selector} has no option with that value or label.`, suggestion: "Check the exact option text with get_page_snapshot." };
  }
  if (/Timeout \d+ms exceeded/.test(message) && WAITING_FOR.test(message)) {
    const timeout = timeoutFrom(message);
    const awaited = / to be (visible|hidden|attached|detached)\s*$/m.exec(message)?.[1];
    if (awaited) {
      const found = /locator resolved to/.test(message);
      return {
        title: "Wait timed out",
        explanation: `${selector} did not become ${awaited} within ${timeout}${awaited === "visible" && !found ? " (it never appeared on the page)" : ""}.`,
        suggestion: "Increase the timeout if the page is slow, or check that the action that should cause this actually happened.",
      };
    }
    const covering = /^\s*-?\s*(<.+?>.*?) (?:from .+? )?subtree intercepts pointer events/m.exec(message) ?? /^\s*-?\s*(<.+?>.*?) intercepts pointer events/m.exec(message);
    if (covering) {
      return {
        title: "Element is covered",
        explanation: `${selector} was found, but another element is on top of it and would receive the click: ${covering[1]}`,
        suggestion: "Close the overlay first (cookie banner, modal, spinner), or wait for it to disappear with wait_for.",
      };
    }
    if (/element is not visible/.test(message)) {
      return { title: "Element is hidden", explanation: `${selector} exists on the page but is not visible, so it cannot be used.`, suggestion: "It may appear after another action (open a menu, hover, switch a tab), or be the wrong one of several matches." };
    }
    if (/element is not enabled/.test(message)) {
      return { title: "Element is disabled", explanation: `${selector} was found but is disabled.`, suggestion: "Complete the required fields or steps that enable it first." };
    }
    if (/element is not editable/.test(message)) {
      return { title: "Field is read-only", explanation: `${selector} was found but cannot be edited.` };
    }
    if (/element is not stable/.test(message)) {
      return { title: "Element kept moving", explanation: `${selector} was still animating or moving after ${timeout}.`, suggestion: "Wait for animations to finish, then retry." };
    }
    if (!/locator resolved to/.test(message)) {
      const inFrame = /contentFrame\(\)/.test(message);
      const isRef = /aria-ref=/.test(selector);
      return {
        title: "Element not found",
        explanation: `No element matched ${selector} within ${timeout}.`,
        suggestion: isRef
          ? "aria-ref handles only last until the page changes; take a fresh get_page_snapshot and use the new ref."
          : inFrame
            ? "The iframe selector may be wrong, or the iframe has not loaded yet. Check it with get_page_snapshot."
            : `The element may not exist, may load later (use wait_for), or be inside an iframe (use the frame parameter or an aria-ref). ${SNAPSHOT_HINT}`,
      };
    }
    return { title: "Timed out", explanation: `${selector} was found but the action did not complete within ${timeout}.`, suggestion: SNAPSHOT_HINT };
  }

  // --- Navigation ------------------------------------------------------------
  const netCode = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (netCode) {
    const known = NETWORK_ERRORS[netCode];
    const url = /net::ERR_[A-Z_]+ at (\S+)/.exec(message)?.[1];
    if (known) {
      const [title, explanation, suggestion] = known;
      return { title, explanation: url ? `${explanation} (${url})` : explanation, ...(suggestion ? { suggestion } : {}) };
    }
    if (netCode.startsWith("ERR_CERT")) {
      return { title: "Certificate error", explanation: `The site's HTTPS certificate is invalid (${netCode}).`, suggestion: "Common on staging sites with self-signed certificates." };
    }
    return { title: "Network error", explanation: `The request failed with ${netCode}${url ? ` (${url})` : ""}.` };
  }
  if (/page\.goto: Timeout \d+ms exceeded/.test(message)) {
    const waitUntil = /waiting until "(\w+)"/.exec(message)?.[1];
    return {
      title: "Page load timed out",
      explanation: `The page did not finish loading within ${timeoutFrom(message)}${waitUntil ? ` (waiting for "${waitUntil}")` : ""}.`,
      suggestion: waitUntil === "networkidle"
        ? 'Pages with polling, analytics or open connections may never become idle; use waitUntil "domcontentloaded" and wait_for instead.'
        : "The server may be slow; raise the timeout or check that it responds.",
    };
  }
  if (/is interrupted by another navigation/.test(message)) {
    return { title: "Navigation interrupted", explanation: "The page started navigating somewhere else (a redirect, or an error page) before this navigation finished." };
  }

  // --- Browser lifecycle -------------------------------------------------------
  if (/Target page, context or browser has been closed|Target closed|Browser has been closed/.test(message)) {
    return { title: "Browser closed or crashed", explanation: "The page or browser closed while the action was running.", suggestion: "Argus opens a fresh browser on the next call; repeat the step." };
  }

  // --- Recording / mocks / arguments -------------------------------------------
  if (/No recording in progress|No recording to annotate|did not fail, so it cannot take|Already recording|No mock with id|Provide exactly one of/.test(message)) {
    return { title: "Invalid request", explanation: message.split("\n")[0] ?? message };
  }

  return { title: "Unexpected error", explanation: message.split("\n")[0] ?? message };
}
