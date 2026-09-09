<div align="center">

# Agent in Chrome

**Let your AI agent drive the Chrome you're already using — not a blank browser it spawns for itself.**

by Liang · [liangai.org](https://liangai.org)

It inherits the sessions you're already logged into: intranet tools, Gmail, admin dashboards, staging environments. No re-authentication, no profile migration.

[中文](./README.md) · [Quick start](#quick-start) · [Extension vs CLI mode](#two-modes) · [Tools](#tool-reference) · [Security](#security-and-transparency)

[![npm](https://img.shields.io/npm/v/@liang-hz/agent-in-chrome?color=cb3837&label=npm)](https://www.npmjs.com/package/@liang-hz/agent-in-chrome)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-125%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![tests](https://img.shields.io/github/actions/workflow/status/Liang-HZ/agent-in-chrome/test.yml?branch=main&label=tests)](https://github.com/Liang-HZ/agent-in-chrome/actions/workflows/test.yml)

</div>

---

## What this is

Agent in Chrome connects an AI agent (Claude Code, Claude Desktop, Trae, Codex, and others) to **the Chrome sitting in front of you**. It exposes a browser toolset over [MCP](https://modelcontextprotocol.io) so the agent can read pages, click, fill forms, and capture network traffic — all carrying your existing login state, all in background tabs that never steal your foreground.

**How does it compare?** The table below scores only **native, out-of-the-box capability**: ✅ = works without writing code, ❌ = not available. (Most of these tools ship an arbitrary-code-execution escape hatch, so in principle anything can be rebuilt by hand — count that and every cell turns ✅ and the table stops meaning anything.) Based on a source-code read and hands-on measurement on 2026-08-18, against @playwright/mcp 0.0.79 · chrome-devtools-mcp 1.7.0 · browser-use 0.13.8 · ego lite 0.4.6.14. No recommendation implied — pick by your situation.

| | Agent in Chrome | Playwright MCP | Chrome DevTools MCP | browser-use | ego lite |
|---|:---:|:---:|:---:|:---:|:---:|
| Drives the browser you're using (inherits login state) | ✅ | ✅¹ | ✅² | ✅³ | ❌⁴ |
| No browser restart with a debug port | ✅ | ✅ | ❌ | ❌ | ✅ |
| Concurrent sessions with non-overlapping tab ownership | ✅ | ✅¹ | ❌ | ❌ | ✅ |
| Speaks MCP | ✅ | ✅ | ✅ | ✅ | ❌ |
| Windows / Linux | ✅⁵ | ✅ | ✅ | ✅ | ❌ |
| Firefox / WebKit | ❌ | ✅ | ❌ | ❌ | ❌ |
| Raw network headers + request/response bodies | ✅ | ✅ | ✅ | ❌ | ❌ |
| WebSocket frames / initiator stack / export as curl | ✅ | ❌ | ❌ | ❌ | ❌ |
| Request mocking / throttling / performance traces | ❌ | ✅ | ✅ | ❌ | ❌ |
| Credentials redacted by default (cookies and passwords never enter model context) | ✅ | ❌⁶ | ❌⁶ | ✅⁷ | ❌ |
| No server-side arbitrary code execution enabled by default | ✅ | ❌⁸ | ✅ | ❌ | ❌ |
| Zero runtime third-party dependencies | ✅ | ❌ | ❌ | ❌ | ❌ |
| Modal overlay detection (including login walls with no ARIA role) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Element pixel coordinates + top-level coordinates across frames | ✅ | ❌ | ❌ | ❌ | ❌ |

<sup>1</sup> `--extension` mode only (Chrome/Edge, requires installing their extension); the default mode is an isolated profile. <sup>2</sup> `--autoConnect` only (Chrome 144+, requires manually opening the gate in `chrome://inspect`, which exposes every window in that profile). <sup>3</sup> Either connect to a Chrome already started with a debug port, or close Chrome and let it copy the entire profile. <sup>4</sup> A separate Chromium fork; migrates your Chrome data once on first launch. <sup>5</sup> Windows supports extension mode (CLI/headless mode planned); the Linux path is written but unverified. <sup>6</sup> Playwright's `--secrets` and DevTools MCP's `--redactNetworkHeaders` are both opt-in and off by default, and the latter doesn't cover bodies. <sup>7</sup> Solid placeholder mechanism on the input side; no redaction on network responses. <sup>8</sup> `browser_run_code_unsafe` describes itself as RCE-equivalent and is on by default.

**Speed** (same test page containing a cross-origin iframe, equivalent fresh profiles, medians; browser-use is omitted because it requires manual per-run authorization in `chrome://inspect` and can't complete the same flow unattended):

| | Cold start → first result | Warm navigation | Warm page read | Page-read response bytes |
|---|---|---|---|---|
| Agent in Chrome | **1247ms** | 250ms | 27ms¹ | **4146** |
| Playwright MCP | 1819ms | 225ms | 10ms | 8235 |
| Chrome DevTools MCP | 1252ms | 288ms | 13ms | 6954 |

<sup>1</sup> Our page read returns an interactive-element table + pixel coordinates + cross-origin frame geometry + isolated body text + credential redaction + overlay adjudication; the others return an accessibility tree with no coordinates. Strictly more content, in fewer bytes.

---

## Core features

- **Attaches to the Chrome you already use.** No new browser, no data migration. Wherever you're logged in is where the agent works.
- **Runs in the background.** Page reads and input happen in background tabs; you keep using the foreground for something else. Pages that pop their own new tab (`target=_blank`, `window.open`, middle-click) get raised by Chrome itself — that line is hard-coded in the browser process and nothing can intercept it — so on macOS a local causal guard hands the foreground back to the app you were in, within tens of milliseconds (measured: 11–100ms).
- **Visible, and revocable.** Tabs the agent opens land in a per-session colored, named tab group; the extension popup lists in real time which tabs each session holds, with one click to 「解除全部托管」(drop every session's hold) or to close everything the agent opened. To step in on a single page, hit 「手动接管」(take over) on its card: the debug banner disappears and the agent is told you have it; 「交给AI接管」(hand back to the AI) returns it. Tabs *you* dragged into the group are **handed back** at the end, never closed.
- **Page understanding that pierces Shadow DOM and cross-origin iframes.** Interactive elements carry stable `ref`s, and modal overlays inside out-of-process iframes are still detected.
- **A genuinely complete network layer**: request lists, raw headers (including `Set-Cookie` and rejection reasons), request/response bodies, initiator stacks, WebSocket messages sent and received, and export-as-curl for replay. **Captured credentials are redacted by default** — you get "Cookie, 1258 chars, starts with `_octo=…`", and the plaintext only if you ask for it explicitly. For a tool whose output flows straight into a model's context, this is a requirement, not fastidiousness. Comparable tools either can't see raw headers at all, or hand the model plaintext cookies.
- **Two modes, one toolset.** If there's a Chrome on your desktop, use extension mode. For terminal agents, cron, CI, and remote machines with no desktop Chrome, CLI mode launches a real Chrome and drives it over CDP directly — identical tool behavior.
- **An audit trail** (`browser_trace`). Every step records a sequence number, the tool, redacted arguments, success or failure, and which page it happened on. Survives context compaction and session restarts. Credential fields are always redacted.
- **Safe defaults**: never takes over a tab on its own; irreversible actions (sending messages, placing orders, deleting, changing settings) require your confirmation first; page content is always treated as data, never as instructions (prompt-injection defense); the values of passwords, CVVs, and one-time codes never appear in any result.
- **Zero runtime dependencies.** The MCP server, native host, and CDP client are all hand-written dependency-free Node. `npm install` pulls in nothing.

---

## Quick start

> Requires Node.js 18+ and Chrome 125+ (or Edge / Brave / Vivaldi / any Chromium-based browser). macOS is fully tested; Windows extension mode is supported (named pipes + registry + `.bat` launcher, with CLI/headless mode planned); the Linux path is written but unverified — see [Known limitations](#known-limitations).
>
> 18 really is enough, and that's measured: on Node 18.20.8 `check` passes end to end, the MCP server
> boots and lists all 37 tools. The one exception is CLI mode's `AGENT_IN_CHROME_KEEP=1`, which needs
> Node's global `WebSocket` — **Node 22+ only**; the default pipe transport works fine on older Node.
> See [docs/CLI.md](docs/CLI.md).

### Step one: run the installer

The fastest route is to **paste this at your agent and let it install for you**:

```
Install agent-in-chrome for me: npx @liang-hz/agent-in-chrome@latest install
Then tell me which steps I still have to do by hand.
```

Or run it yourself:

```bash
npx @liang-hz/agent-in-chrome@latest install     # install (from a git clone: node scripts/install.mjs, equivalent)
npx @liang-hz/agent-in-chrome check              # self-check, changes nothing (non-zero exit if anything failed)
npx @liang-hz/agent-in-chrome uninstall          # uninstall, fully reversible
```

All three subcommands exit on whether anything failed: 0 when everything passed, non-zero when any
check did not; a mistyped flag prints the help and also exits non-zero. So
`npx @liang-hz/agent-in-chrome check && your-command` works.

**Installing into a client the installer doesn't cover yet, or it installed but nothing connects?**
Have your agent run `/install-agent-in-chrome` (or just say "install agent-in-chrome for me"). It
starts from `npx @liang-hz/agent-in-chrome check --print-config`, which prints this machine's exact
configuration — runtime absolute paths, native host name, extension ID, launcher command — and only
then goes looking for where that client keeps its MCP config, writing the entry in that client's own
schema. Guessing the paths is how this usually fails: a wrong path gets you a bare
`Connection closed` and nothing else.

The installer will (every step reversible, and every file it's about to touch is listed before it touches it):

1. Sync the runtime into `~/.agent-in-chrome/agent-in-chrome/` and write the native host manifest into each Chromium browser's `NativeMessagingHosts/` directory.
2. Detect the agents on your machine (Claude Code, Claude Desktop, WorkBuddy, ZCode, opencode, Kimi CLI, Gemini CLI, Antigravity, Qoder CLI, Qoder IDE, Trae, Codex CLI, DeepSeek Harness, plus the China builds Qoder CN CLI / Qoder CN IDE / Trae CN — 16 in total), show you the exact file and content it would write for each, and register the MCP server after you confirm (originals backed up automatically; `--yes` skips the per-agent prompts, `--agents=claude-code,trae` narrows the set, `--no-agents` skips this entirely).
3. Generate a **connection token unique to this machine** (mode `0600`, never committed, never uploaded) — see [Security and transparency](#security-and-transparency).
4. Install **two skills and two commands**: `skills/agent-in-chrome/` (including the reference handbooks under `references/`, which teach the agent how to use the browser tools) and `skills/install-agent-in-chrome/` (which teaches it how to install this into another client) are copied to `~/.agent-in-chrome/skills/`, and the `/agent-in-chrome` and `/install-agent-in-chrome` commands to `~/.agent-in-chrome/commands/`.

### Step two: install the Chrome extension (the only manual step)

> **Load unpacked is currently the only route.** The Chrome Web Store listing is still going through
> review, so you won't find it by searching the store. Browsers don't allow silent extension installs
> from the command line either — so these few clicks can't be automated away. You only do them once.
> The cost is that **an unpacked extension does not auto-update** (see [Updates and versioning](#updates-and-versioning)
> for how to upgrade it); the store build, once live, updates itself and becomes the recommended entry point.

1. Type `chrome://extensions` in the address bar and hit Enter.
2. Turn on **Developer mode** (top right) — **without it, the button in step 3 does not appear**.
3. Click **Load unpacked** (top left) and pick **the extension directory the installer printed at the end**:
   - npx / npm install: `~/.agent-in-chrome/extension`
     (macOS file pickers hide dot-directories by default: press `⇧⌘.` to show hidden files, or `⇧⌘G` to paste the path)
   - git clone: `extension/` in the repo
4. An "Agent in Chrome" card appears — that's it installed. The ID on that card must read
   `eknmigackgheebnojadpjepdoebpfnil`; **if it doesn't, you picked the wrong directory** (the native
   host only accepts that ID).
5. **Pin it to the toolbar**: click the puzzle-piece icon 🧩 next to the address bar, find Agent in
   Chrome, click the pin. Every "click the extension icon" below means that one.

**The two steps work in either order.** The native host manifest names a fixed extension ID and doesn't care whether the extension exists yet; once installed, the extension dials in on its own (every 30 seconds, backing off to 60s and at most 2 minutes while no agent is connected, and resetting the moment a call arrives — the popup's 「立即重连」(reconnect now) button is the instant fallback). **You don't need to restart Chrome or your agent**: Chrome re-reads the host config on every `connectNative`, and on the agent side `/mcp` reconnects (supported by Claude Code and WorkBuddy).

### Step three: check that it connected

Click the extension icon and read the status line at the top of the popup: **connected** means you're
done. If it says not connected, the popup translates Chrome's disconnect reason into one concrete next
action — do that first (most often: the native half isn't installed yet, so go back to step one).

Then ask your agent to "list my open tabs" or run `/agent-in-chrome`. If it comes back with your real
tabs, the whole chain works. If the `browser_*` tools aren't in the agent's tool list at all, that
client simply hasn't reconnected its MCP servers — it isn't an install failure.

Still stuck? Run the per-item self check (**quit your agent first**: the bridge socket is
single-owner, so the check can't get in while an agent holds it):

```bash
npx @liang-hz/agent-in-chrome check
```

Every ✗ line tells you the exact command to run next. The full troubleshooting tree lives in the
`/install-agent-in-chrome` skill.

<details>
<summary>Per-agent MCP configuration details live in <a href="docs/AGENTS.md">docs/AGENTS.md</a> (the installer writes these for you; you rarely need them)</summary>
</details>

---

## Two modes

One toolset, two transports. You almost never have to care which one is running — tool behavior is identical.

### Extension mode (default; you have Chrome in front of you)

agent → MCP server → local socket → native host (spawned by Chrome) → extension → your open tabs.

This is the Chrome on your screen. It's the day-to-day mode: you're logged into everything, and the agent works inside that.

### CLI / headless mode (no desktop Chrome)

Terminal agents, cron jobs, CI, and remote SSH boxes don't have "an open Chrome with an extension installed" available. Set `AGENT_IN_CHROME_LAUNCH=1` on the MCP server and it **launches a real Chrome itself** and drives it over a direct CDP connection — no extension, no native host, running the same tool code.

- Uses the **stable Chrome** already on the machine (not Chrome for Testing), so the fingerprint is what it always was.
- The profile is dedicated and starts fresh (log into whatever sites you need once; it persists from then on). You can also **borrow login state from your own Chrome, per domain**, and hand it back precisely when you're done: `npx @liang-hz/agent-in-chrome borrow-login --domains github.com` (from a git checkout: `node scripts/borrow-login.mjs --domains github.com` — same flags; boundaries are documented in [docs/CLI.md](docs/CLI.md): session cookies don't survive a restart, and localStorage-based sites can't be moved).
- Common switches: `AGENT_IN_CHROME_HEADLESS=0` to watch it work; `AGENT_IN_CHROME_KEEP=1` to leave the browser running between sessions and skip the cold start. Full environment variable reference in [docs/CLI.md](docs/CLI.md).

| Situation | Mode |
|---|---|
| Chrome is open locally, logged into everything, and I want the agent to work in it | **Extension** |
| Terminal agent / cron / CI / remote machine with no desktop | **CLI** |
| I want the agent in a clean environment isolated from my daily browser | **CLI** |
| I need to get past bot detection with a real Chrome fingerprint | Either (both are real Chrome) |

---

## Tool reference

<details>
<summary>Expand 30+ browser tools</summary>

**Tabs and sessions**

| Tool | What it does |
|---|---|
| `browser_status` | Bridge status, which tabs this session holds, `sessionOrigin` |
| `browser_tabs_list` | List every tab the user has open |
| `browser_new_tab` | Open a new tab and take it over, filed into the tab group (the default choice) |
| `browser_tab_use` | Take over a tab the user already had open |
| `browser_set_label` | Name this session's tab group after the current task |
| `browser_tab_group` | File held tabs into the tab group |
| `browser_close_tab` / `browser_close_all` | Close one tab / clean up the tabs this task opened (`scope:"session"` clears the whole session ledger, `scope:"all"` is a cross-session sweep) |
| `browser_tab_release` | Let go: detach the debugger and hand the tab back to the user (without closing it) |
| `browser_set_task_state` | Set the task state shown on the tab group (running / attention / failed) — the agent's only non-interrupting channel to the user |
| `browser_cookies_export` / `_import` | Move login state to another instance; by default no plaintext is returned — it writes a `0600` file and returns only the path, and the importing side reads it via `inFile`, so plaintext enters neither context. Exporting real values is gated **per domain**: ungranted domains are refused on the spot, and you allow them in the extension popup under Preferences → credential loans, after which the agent simply retries (a standing grant expires after 30 days) |

**Page understanding**

| Tool | What it does |
|---|---|
| `browser_navigate` | Navigate / back / forward / reload, waiting for load |
| `browser_read_page` | Interactive element table (with `ref_N`) + body text, through Shadow DOM and iframes; `activeDialog` reports any modal overlay in the way |
| `browser_refresh_refs` | Refresh just the element table and ref mapping, without body text (much cheaper) |
| `browser_find` | Find elements via Chrome's whole-page search (text / CSS / XPath, through iframes and shadow DOM, no element-count ceiling) |
| `browser_screenshot` | Viewport / full page / single element; writes to disk and returns metadata by default |

**Actions**

| Tool | What it does |
|---|---|
| `browser_click` / `browser_hover` | Click / hover; verifies the target is hittable before, and that it was hit after |
| `browser_set` | Set a form control's value (select / checkbox / radio / date / range) and read it back to confirm. It only takes the `ref_b…` handles from `browser_find`; `read_page`'s `ref_N` goes to `browser_click` / `browser_type` |
| `browser_type` / `browser_press_key` | Type text / press keys |
| `browser_scroll` | Scroll |
| `browser_emulate` | Viewport / dark mode / throttling / geolocation emulation: reads back whether the viewport really took (mobile on a page without a viewport meta falls back to 980), geolocation also grants the origin's permission, `reset:true` undoes it all |
| `browser_batch` | Run a sequence of actions, stopping at the first failure and reporting which step broke |
| `browser_upload_file` | Put a local file into an `<input type=file>` (hidden, shadow, and in-iframe inputs all work) |

**Data and network**

| Tool | What it does |
|---|---|
| `browser_eval` | Evaluate in-page to extract data; results aren't truncated and can go to `outFile` |
| `browser_cdp` | Raw CDP passthrough (escape hatch) |
| `browser_console` | Console output and page exceptions |
| `browser_network` | Request list (`type:"api"` filter, `bodyContains` searches response bodies directly) |
| `browser_request_detail` | Raw headers (including `Set-Cookie` and rejection reasons) / request body / response body / timing / initiator stack |
| `browser_network_wait` | Wait for this particular call to a given endpoint and return its result |
| `browser_websocket` | WebSocket connections and the messages over them |
| `browser_as_curl` | Export as curl for replay (using the raw request headers from the network layer, including the cookies actually sent) |
| `browser_wait_for` / `browser_handle_dialog` / `browser_trace` | Wait for a condition / pre-decide how to handle the next dialog / review the audit trail |

</details>

---

## Configuration: trimming tools you don't need

**Switch profiles straight from the extension popup** (click the extension icon → tool profile). Finer control lives in `~/.agent-in-chrome/config.json` (create it if it doesn't exist):

```json
{
  "tools": {
    "profile": "observe",
    "disable": ["browser_batch"]
  }
}
```

- **`profile` has two settings**, controlling which tools appear in the agent's tool list at all. A tool that's off isn't "disabled" — it **doesn't exist**, so the model never sees it and never reaches for it:
  - `observe` — read pages, screenshot, inspect network, open its own tabs and navigate them. No clicking, no typing, no credential access — any **parameter** that crosses into the credential or execution surface is refused outright at this level: `revealSecrets`, and `browser_wait_for`'s `js` (which is arbitrary evaluation in the page's main world). **An honest caveat**: navigation itself issues GET requests as you, and on some sites unsubscribe or deactivate links *are* GETs. The whole `tools/list` is about 20 KB at this level (about 36 KB at `full`), which saves tokens on every single request.
  - `full` (default) — everything: click/type, `eval` / `cdp` (arbitrary code), cookie import/export (your entire login state), `websocket`, `upload_file`.
  - Older configs using `readonly` / `standard` still work, mapping to `observe` / `full` respectively (`standard` migrates toward the permissive side, so we never silently take away capability you already had).
- **`disable` / `enable`** turn individual tools off or on on top of the profile (full names, `browser_` prefix). If a tool appears in both, `disable` wins.
- A broken config is safe: if the JSON is invalid, the last known-good config stays in effect — it **never silently falls back to everything-on**.

**When changes take effect**: saving the file is enough; nothing on our side needs restarting. On the agent client side, Claude Code picks up the new tool list on the next turn; **for other clients, if a change doesn't take, restart that client** (reopening a session isn't always enough — some GUI clients reuse one MCP connection across sessions, and restarting the client is the action that always works).

---

## Updates and versioning

Nothing updates automatically, and nothing updates silently — **when to upgrade is your call**.
There are four ways to find out a new version exists, and two ways to install it.

### Finding out there's a new version

| Channel | When it shows up | What you see |
|---|---|---|
| **Tail of a tool result** | While the agent is working; once per MCP process | A one-line notice appended to some tool result; the agent reads it and passes it along |
| **Extension popup** | When you click the toolbar icon (result cached 6 hours) | An extra line in the popup with a link |
| **`check` subcommand** | When you run it | A line at the end of the self-check: local vX, npm latest vY, update available or not |
| **`browser_status` tool** | When the agent asks | `update: { current, latest, hasUpdate }` in the result |

The first two are **passive** — they come to you, but each is a one-shot (the tool-result line is
consumed once it's read; the popup needs a click). The last two are **the ways to ask**: to confirm
whether you're current, run `check`, or have the agent look at `browser_status`.

In `browser_status`, `latest: null` means **not known** (offline, checking disabled, or the query
hasn't returned yet), and `hasUpdate` is then always `false` — "don't know" and "confirmed current"
are told apart by whether `latest` is `null`.

The check itself is **lightweight, disableable, and non-blocking**: it asks the npm registry for one
number and sends nothing about your machine, and it never makes a tool call wait. It's skipped
entirely with `AGENT_IN_CHROME_NO_UPDATE_NOTIFIER=1` or in any CI environment.

### Upgrading

**Local components (MCP server + native host):**

```bash
npx @liang-hz/agent-in-chrome@latest update
```

It queries npm for the latest version; if you're already current it does nothing. Otherwise it
fetches and runs that version's installer **pinned to the exact version number**, then verifies what
actually landed. It passes through `--yes`, `--agents=claude-code,codex`, and `--no-agents`, same as
`install`. Offline, it just says it couldn't check — it does not fail.

**The Chrome extension** ships through a separate channel and `update` does not touch it:

- **Loaded unpacked (everyone, today)**: after upgrading the local components, go to
  `chrome://extensions` and hit the reload button on the card — `install` / `update` has already
  replaced the copy in `~/.agent-in-chrome/extension`, and reload is what makes Chrome re-read it.
  No Chrome restart, and no need to "Load unpacked" a second time.
- **Installed from the Web Store** (once the listing is live): the store updates it for you; nothing
  to do. (npm running one or two minors ahead of the store is normal review lag and the extension
  won't nag about it; it only speaks up when the gap is large enough that the update has probably stalled.)

When the two sides disagree, `browser_status`'s `versions` field reports it honestly and the agent
gets a one-time version-mismatch notice — that's not a fault; npm and the store release
independently.

Releases are cut as git tags (`vX.Y.Z`) plus GitHub Releases, which serve as the changelog. To hear
about updates first, [watch this repo](https://github.com/Liang-HZ/agent-in-chrome)'s releases, or
follow the npm package.

---

## Known limitations

- **`chrome://` URLs, extension pages, and the Web Store can't be touched** — Chrome forbids attaching a debugger to them.
- **A debug notification bar sits at the top of a held page** and can't be hidden (Chrome's security design). It disappears after `browser_tab_release`.
- **Cross-origin iframes under a CSS transform** (rotate/scale/skew) can't have their coordinates computed, so elements inside them can't be clicked; `read_page` marks them `coords: "未知"` ("unknown" — the field is emitted in Chinese). Work around it by opening that URL directly with `browser_new_tab`.
- **No performance / a11y / SEO audit scores** — `npx lighthouse <url> --view` is one command away and carries Chrome's own scoring; in extension mode we drive your everyday Chrome, which has no debugging port, so building our own would only produce a worse Lighthouse. **Division of labour**: scores come from `npx lighthouse`; we cover what it can't reach — pages behind a login, the screen that only appears after you open some panel, and the headers and bodies of one specific request.
- **There is no dedicated drag tool** — drag sliders, drag-and-drop reordering, and canvas gestures are done with `browser_batch` chaining a series of `browser_cdp` `Input.dispatchMouseEvent` calls (recipe in [skills/agent-in-chrome/references/actions-and-waits.md](skills/agent-in-chrome/references/actions-and-waits.md#拖拽--滑块没有-drag-工具), under "拖拽 / 滑块"). Synthesizing events via `eval` dispatches `isTrusted: false`, which real captchas reject.
- **Platforms**: macOS is fully tested. **Windows extension mode is supported** (registry + named pipes + a `.bat` launcher; the bridge's first line of defense becomes the token rather than directory permissions — see the `bridgeEndpoint` comment in `mcp/token.mjs`). Windows CLI/headless mode (`AGENT_IN_CHROME_LAUNCH=1`) is not yet supported. The Linux path is written but unverified. PRs welcome.

---

## Security and transparency

This tool holds **complete control of your logged-in browser**, so transparency is a design goal, not an afterthought.

**What it does to protect you:**

- **It takes over no tab by default** — that requires an explicit `browser_tab_use`, which itself refuses to commandeer tabs you already had open.
- **Connection token**: install generates a random token on your machine (`~/.agent-in-chrome/`, mode `0600`), and the control socket verifies it. Together with directory permissions (`0700`) it keeps out **other users** and **stray connections**; the token is never committed, never uploaded, and unique per machine. **An honest caveat**: any process running as you — a malicious npm package you installed, say — can read that token file, and no token stops it. Nothing running locally can; that's the operating system's user-isolation boundary, not ours.
- **Irreversible actions ask first**: sending a message, placing an order, deleting something, changing account settings — the skill requires the agent to spell out what it's about to do and wait for your consent.
- **Page content is data, never instructions** (prompt-injection defense). If a page says "ignore your previous instructions", the agent quotes it back to you instead of complying.
- **Credentials never leak**: the values in password fields, credit card numbers, CVVs, and SMS codes never appear in `browser_read_page` or `browser_find` results — only "filled (N chars)". The audit trail records only the length of typed text. `Cookie`, `Authorization`, and token headers are always redacted.
- **You can see it happening**: Chrome's own "is being debugged" banner can't be suppressed (that's Chrome's design, and we like it); agent tabs sit in a colored, named tab group; the extension popup refreshes every 1.5 s with every tab every session holds.

**Where it reads and writes on your machine** (the installer and the extension's "properties" page both print exact paths):

- The install directory `~/.agent-in-chrome/`: a copy of the runtime, the connection token, logs, audit traces (`traces/`), screenshots (`screenshots/`, most recent 100 kept), exported cookies (`cookies/`, mode `0700`), both skill directories (`skills/`; the `agent-in-chrome` one includes `references/`) and both commands (`commands/`).
- One host manifest in each browser's `NativeMessagingHosts/` directory.
- Read-only access to each Chrome profile's `Preferences`, to detect whether the extension is installed.
- A dedicated Chrome profile in CLI mode.
- **Outbound network: none.** Apart from localhost, the product itself sends data to no server. What the agent visits is entirely determined by your instructions.

**On bot detection**: CLI mode uses your real Chrome, clears headless markers, and doesn't set `navigator.webdriver` — the goal is **fidelity** (it *is* your browser, acting for you), not impersonating someone else. Please stay within the terms of service of the sites you visit.

Full privacy details in [PRIVACY.md](PRIVACY.md).

---

## About this repository

This is the **release mirror**. Day-to-day development happens in a private repository; the public
tree carries the product, the docs, and the tests. The website (`site/` and its Cloudflare
Functions) is not here — it deploys from the private repository.

- **Comments**: the code keeps its explanatory comments — what a piece does, what the parameters
  mean, where the boundaries are. What is not published is the other half: why this choice over
  that one, how a particular trap was discovered, what the measurements were.
- **Tests**: two layers. **The layer that needs no browser ships with the repository** — `npm test`
  runs on a clean clone, and that is what CI runs (the badge above). The layer that drives a real
  Chrome stays on the maintainer's side: end-to-end runs against the real extension, the concurrency
  suites, and the interop checks against the various MCP SDKs all depend on a locally installed
  extension and a signed-in browser, so they would not reproduce the same conclusions elsewhere.

So every commit you see here is a complete, working product you can verify yourself — you just
don't see how it was arrived at.

The dead ends and the trade-offs get written up as articles on
[liangai.org](https://liangai.org) instead. Turning the process into something readable is worth
more than checking half-finished notes into a repo.

---

## Contributing

Architecture, engineering conventions, and the test layering are documented in [CONTRIBUTING.md](CONTRIBUTING.md). The core invariant: **one tool layer (`extension/sw.js`), two transports (native messaging / direct CDP), and exactly one place in the whole project that branches on which.**

```bash
npm test   # every unit and integration test that doesn't need a browser; runs on a clean clone
```

Issues are welcome any time: bugs, platform differences, a client it won't install into — those are
exactly what I want to hear about. For a PR, please open an issue first and say what you intend to
change. The public and private trees have to be kept in sync, and a large unannounced PR is one I
probably can't merge.

---

## License

[Apache License 2.0](./LICENSE) © 2026 Liang · [liangai.org](https://liangai.org)

---

**中文：** 完整文档见 **[README.md](./README.md)**。
