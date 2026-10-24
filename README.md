# Argus QA MCP

**Let Claude (or any MCP-capable AI agent) QA-test your web app, and leave evidence behind.**

Argus is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent a real Chromium browser through Playwright, plus the things you need to trust its results:

- **Recordings for review**: every session can produce a video, a Playwright trace (DOM snapshots, network and console for each step) and an HTML report of every action the agent took.
- **Real test verdicts**: `assert_text` / `assert_visible` return PASS or FAIL, and the report tallies them.
- **Network mocking**: simulate API errors, payment declines, outages and slow responses without touching your backend.
- **Safety guards**: refuses to enter card details on pages using a *live* payment environment, blocks live payment API traffic, optionally restricts which sites the agent may visit, and masks passwords and card numbers in recordings.

<!-- TODO: add a demo GIF of a recorded run and its report here -->

## Quick start

Requires Node.js 22+.

**1. Install the browser (once):**

```sh
npx playwright install chromium
```

Or skip this and use your installed Google Chrome by setting `ARGUS_BROWSER_CHANNEL=chrome` (see [Configuration](#configuration)).

**2. Add Argus to your client.**

Claude Code:

```sh
claude mcp add argus -- npx -y argus-qa-mcp
```

Claude Desktop: add this to `claude_desktop_config.json` (on Windows `%APPDATA%\Claude\`, on macOS `~/Library/Application Support/Claude/`) and restart:

```json
{
  "mcpServers": {
    "argus": {
      "command": "npx",
      "args": ["-y", "argus-qa-mcp"]
    }
  }
}
```

**3. Ask for a test:**

> Start a recording called "login flow". Go to https://the-internet.herokuapp.com/login, log in as tomsmith / SuperSecretPassword!, assert that "You logged into a secure area!" is shown, report any console errors, then stop the recording.

Argus writes the recording to `~/argus-qa/recordings/<date>_login-flow/`. Open `report.html` to review it.

## Tools

| Tool | What it does |
|---|---|
| `navigate_url` | Open a URL; returns status code, final URL and title. Resets the console and network logs. |
| `get_page_snapshot` | Accessibility tree of the page (including iframes) with `[ref=eN]` handles. Pass `aria-ref=eN` as a selector to any other tool. |
| `click_element` | Click an element; waits for any navigation it triggers. |
| `fill_input` | Clear and fill a field. Password and card values are masked in recordings. |
| `select_option` | Choose option(s) in a `<select>` by value or label. |
| `press_key` | Press a key or chord (`Enter`, `Tab`, `Control+A`), optionally on an element. |
| `hover_element` | Hover an element (menus, tooltips). |
| `wait_for` | Wait for an element or text to become visible, hidden, attached or detached. |
| `take_screenshot` | Save a PNG (viewport or full page) and optionally return it. |
| `assert_text` | PASS if text is visible on the page or in an element, otherwise FAIL with the actual text. |
| `assert_visible` | PASS if an element is visible (or hidden), otherwise FAIL. |
| `get_console_errors` | Console errors, uncaught exceptions, failed requests, HTTP errors and guard blocks, deduplicated, optionally first-party only. |
| `get_network_requests` | The page's HTTP requests with status, timing, failures and mock hits. |
| `mock_route` | Answer matching requests with a canned response, a network error or a delay. |
| `clear_mocks` | Remove one mock or all of them. |
| `start_recording` | Start recording a trace, an optional video and the action log. |
| `stop_recording` | Save the recording and report; returns paths and assertion results. |

Element tools accept a `frame` parameter (an iframe selector, or a list for nested iframes), though `aria-ref` selectors reach into iframes without it.

## Configuration

All settings are environment variables, set in your client's MCP config (`"env": { ... }`, or `-e NAME=value` with `claude mcp add`).

| Variable | Default | Purpose |
|---|---|---|
| `ARGUS_HEADLESS` | `true` | `false` shows the browser window. |
| `ARGUS_BROWSER_CHANNEL` | *(bundled Chromium)* | `chrome`, `msedge` (or `-beta`) to use an installed browser. |
| `ARGUS_ALLOWED_HOSTS` | *(any)* | Comma-separated hosts the agent may open as pages, e.g. `staging.myapp.com,localhost`. Subdomains included. |
| `ARGUS_RECORD` | `false` | `true` records every session automatically; saved when the client disconnects. |
| `ARGUS_RECORDINGS_DIR` | `~/argus-qa/recordings` | Where recordings are written. |
| `ARGUS_SCREENSHOT_DIR` | `~/argus-qa/screenshots` | Where screenshots are written. |

## Safety model

Argus is meant for testing **sites you own or are authorized to test**, ideally staging environments with test payment credentials.

| Guard | Behavior |
|---|---|
| Payment guard (always on) | Blocks requests that use Stripe live keys (`pk_live_`/`sk_live_`/`rk_live_`) or that reach Adyen live, Braintree production or PayPal live REST APIs, and refuses to type into card fields on a page that loads a live key. Test and sandbox modes are unaffected. |
| Host allowlist (opt-in) | With `ARGUS_ALLOWED_HOSTS` set, top-level navigation to any other host is refused, whether by `navigate_url` or by a link click. Sub-resources such as CDNs still load. |
| Secret masking | Values typed into password and payment-card fields are replaced with `••••••` in `actions.json` and `report.html`. |

**Limits you should know about:**

- The **Playwright trace (`trace.zip`) still contains typed values**, including passwords. Treat trace files as sensitive.
- The payment guard recognizes **Stripe, Adyen, Braintree and PayPal** only. It can't detect other providers, or a backend that charges cards server-side with its own secret key. It is a safety net, not proof that a site is in test mode.
- `firstPartyOnly` compares the last two labels of the host name, so it treats e.g. `a.co.uk` and `b.co.uk` as the same site.

## Recordings

`start_recording` → (test steps) → `stop_recording` produces:

```
~/argus-qa/recordings/2026-10-24_22-43-42_login-flow/
├── report.html     # video, tool-call table (failures in red), assertion tally, screenshots
├── trace.zip       # open with: npx playwright show-trace trace.zip  (or drag onto trace.playwright.dev)
├── video.webm
├── actions.json    # machine-readable log of every tool call
└── screenshots/
```

Starting a recording with video reloads the current page into a new browser context. Cookies, localStorage and the URL are kept; unsaved in-page state is not. Use `video: false` to record just the trace without a reload.

## Development

```sh
npm install
npx playwright install chromium
npm run build       # compile src/ to dist/
npm run typecheck   # strict type-check without emitting
npm run dev         # run the server from source with tsx
```

To try a local build in Claude Code: `claude mcp add argus-dev -- node /path/to/argus-qa-mcp/dist/index.js`.

## License

[MIT](LICENSE)
