# PikudClaude

Multi-session terminal hub for Claude Code, backed by tmux.

PikudClaude is a macOS desktop app that lets you orchestrate many Claude Code sessions side-by-side — switch between them with `⌘1`–`⌘9` or a fuzzy palette, get notified when Claude needs your input, and (uniquely) **type and read Hebrew, Arabic, and other right-to-left scripts correctly** — a feature missing from VSCode, Cursor, Hyper, Tabby, and other xterm.js-based Electron terminals.

<p align="center">
  <img src="https://pikud.io/assets/terminal-demo.svg" alt="Animated PikudClaude demo: type in one project, switch to another, ask in Hebrew, read a Hebrew + English answer, open Settings" width="100%" />
</p>

## Latest release — v0.2.7

[Download `PikudClaude-0.2.7-arm64.dmg`](https://github.com/wmgltd/PikudClaude/releases/tag/v0.2.7) (macOS Apple Silicon, signed + notarized) · landing page at [pikud.io](https://pikud.io).

**What's new — full-scrollback selection + usage strip fix**
- **`⌘⇧C` opens a scrollback overlay** with the entire tmux history rendered as plain text — drag to select across many pages, double/triple-click, `⌘C` to copy. Works around xterm.js's viewport-only selection so you can finally grab text that scrolled past one screen.
- **Usage strip now works in packaged builds.** macOS GUI apps get a minimal `PATH` (`/usr/bin:/bin:…`) that doesn't include `npx`, so `ccusage` never ran and the bottom-left strip always said "no active usage". The app now resolves the real interactive-login-shell `PATH` on first call and reuses it.

## Earlier — v0.2.6

[Download `PikudClaude-0.2.6-arm64.dmg`](https://github.com/wmgltd/PikudClaude/releases/tag/v0.2.6).

- **No more auto-copy on mouse select.** Selecting text in the terminal used to silently overwrite the clipboard on `mouseup`. Now selection stays as just selection — press `⌘C` when you actually want it copied. Matches the convention of every other macOS terminal.
- **`Ctrl+C` always sends SIGINT.** Previously the copy handler intercepted both `⌘C` and `Ctrl+C`, which meant Ctrl+C silently stopped interrupting Claude whenever you had text highlighted. Now only `⌘C` is intercepted for copy; `Ctrl+C` is always passed through.

## Earlier — v0.2.5

[Download `PikudClaude-0.2.5-arm64.dmg`](https://github.com/wmgltd/PikudClaude/releases/tag/v0.2.5).

- **In-app update prompt.** When the auto-updater finds a new release on launch, an "Update available" dialog pops up — shows download progress, then offers **Update now** or **Skip**.
- **Settings dialog tab fix.** The six-tab row was overflowing horizontally and rendering the "About" tab outside the modal box. Tabs now wrap on overflow.

## Earlier — v0.2.4

[Download `PikudClaude-0.2.4-arm64.dmg`](https://github.com/wmgltd/PikudClaude/releases/tag/v0.2.4).

- **Atomic writes + rotating backups** for `sessions.json`, `settings.json`, `bookmarks.json`. A crash mid-write can no longer corrupt the file; if the canonical file is unreadable we walk three rotating `.bak.N` snapshots and recover.
- **Crash + error logging.** Native crashes land in `userData/crashes` (local-only, never uploaded). Uncaught main and renderer errors append to a rotating `userData/error-log.txt`. New "Show crash logs" button in Settings → About reveals the folder.
- **Awaiting alerts now debounced 400ms.** Sound + notification + dock badge only fire if the session stays awaiting through the window, preventing duplicate alerts when Claude's TUI flickers awaiting→working→awaiting on a single round-trip.
- **Lazy-mount terminals.** Sessions you haven't opened yet no longer spin up a hidden xterm.js instance at launch — opening the app with 10 saved sessions is noticeably lighter on RAM until you actually click into them.

## Earlier — v0.2.3

[Download `PikudClaude-0.2.3-arm64.dmg`](https://github.com/wmgltd/PikudClaude/releases/tag/v0.2.3).

- **Display fixes.** Blank pane after re-opening onboarding is gone; `location.reload()` was replaced with a state-driven dialog re-mount, and the main→renderer IPC path now drops messages while a frame is mid-reload instead of crashing.
- **Tmux client leak fixed.** TerminalView's async attach was racing the effect cleanup under React StrictMode, leaving orphan 80×24 tmux clients that shrank visible panes.
- **Fresh PikudClaude icon** rendered from SVG at every size.
- **Internal rebrand.** `easyclaude` → `pikudclaude` across npm name, appId, userData path, tmux session prefix, and localStorage keys.

> ⚠️ **Upgrading from v0.2.2 (or earlier `easyclaude` install):** the appId changed in v0.2.3 (`com.kobi.easyclaude` → `com.kobi.pikudclaude`), so macOS treats this as a separate app. No auto-update across that boundary — download the DMG manually. Old data still lives at `~/Library/Application Support/easyclaude/` if you want to reference it before deleting.

## Why

Claude Code is great. Running half a dozen of them in different tmux windows is not. PikudClaude makes that workflow sane:

- **All your sessions in one window.** Sidebar, ⌘+number to switch, drag-drop to reorder.
- **Survives app restarts.** tmux keeps the sessions alive in the background; PikudClaude re-attaches on launch and triggers a clean redraw so Claude's TUI doesn't double-render.
- **Awaiting alerts.** Detects when Claude is asking you a numbered-options question and chimes / fires a macOS notification / bumps the dock badge — only when the session is *not* the one you're focused on.
- **Hebrew/RTL support.** Words and sentences in Hebrew flow right-to-left as they should, mixed with English on the same line. This is implemented via a `MutationObserver` on xterm rows + targeted CSS — same architectural defect as every other xterm.js terminal, but actually solved.

## Features

- Create or import any existing tmux session
- Bookmark current point in any session (`⌘B`)
- Search inside the active terminal scrollback (`⌘F`)
- Command palette (`⌘K`) and session-only switcher (`⌘P`)
- Click a `path/to/file.ts:42` in the output → opens in Cursor / VSCode
- Click the colored dot next to a session name to recolor it
- Drag a session row to reorder
- Settings: themes (Default, Solarized Dark, Dracula, Nord, Light, Custom), font picker with Hebrew-friendly options, cursor style, notification sound + quiet hours, auto-bookmark on awaiting, default initial command and cwd

## Hebrew / RTL — the differentiator

xterm.js [issue #701](https://github.com/xtermjs/xterm.js/issues/701) ("Support RTL languages") has been open since 2017. Every Electron terminal that uses xterm.js inherits the gap: VSCode, Cursor, Hyper, Tabby, Wave Terminal, Mux. iTerm2 and WezTerm have their own open RTL bugs. Only macOS Terminal.app handles bidi properly out of the box — but it has no multi-session UX, no integration with Claude Code's TUI workflow.

PikudClaude solves this via:
- DOM renderer (no canvas pre-rasterization — lets the browser fall back through the font stack so Hebrew glyphs render)
- A `MutationObserver` that flags rows containing Hebrew/Arabic chars
- CSS `direction: rtl; unicode-bidi: isolate` on the spans inside flagged rows, so Hebrew flows right-to-left and English embedded inside isolates back to LTR

It's not a full UAX#9 implementation, but it covers the common cases (typing in the input field, reading Claude's Hebrew responses) cleanly enough that Israeli/Arabic-speaking developers can actually use Claude Code without giving up on their first language.

## Stack

- Electron 33 + Vite (electron-vite)
- React 18 + TypeScript
- xterm.js 5.5 (DOM renderer) with `addon-fit`, `addon-search`, `addon-clipboard`, `addon-web-links`
- node-pty for the actual PTY
- tmux (system-installed) as the session-persistence layer

## Building

Requires Node 20+ and tmux installed (`brew install tmux`).

```bash
npm install
npm run dev      # electron-vite dev with HMR
npm run pack     # local packaged .app at dist/mac-arm64/PikudClaude.app
npm run dist     # signed dmg + zip (needs Apple Developer ID)
```

## Author

Kobi Sela ([WMG](https://wmg.co.il)) — kobi@wmg.co.il

## License

UNLICENSED (private). Open-sourcing is on the table — open an issue if you want to use it.
