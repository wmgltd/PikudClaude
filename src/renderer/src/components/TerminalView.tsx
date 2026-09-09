import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { SessionMeta, ThemeColors, CursorStyle } from '../types'
import {
  encodeX10Wheel,
  isAllMouseModes,
  stripMouseTracking,
  WHEEL_DOWN,
  WHEEL_UP
} from '../../../shared/mouse'
import { rowNeedsRtl, type RowSpan } from '../../../shared/bidi'

interface Props {
  session: SessionMeta
  active: boolean
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
  cursorStyle?: CursorStyle
  cursorBlink?: boolean
  theme?: ThemeColors
  preferredIDE?: 'cursor' | 'vscode' | 'finder'
  onOpenScrollback?: () => void
  onPromptSubmit?: (prompt: string) => void
}

const DEFAULT_FONT_FAMILY =
  'Menlo, "SF Mono", Monaco, "Courier New", "Arial Hebrew", "Lucida Sans Unicode", monospace'

const DEFAULT_THEME: ThemeColors = {
  background: '#000000',
  foreground: '#e4e4ec',
  cursor: '#7c3aed',
  selectionBackground: '#7c3aed55'
}

export function TerminalView({
  session,
  active,
  fontSize = 13,
  fontFamily = DEFAULT_FONT_FAMILY,
  lineHeight = 1.15,
  cursorStyle = 'block',
  cursorBlink = true,
  theme = DEFAULT_THEME,
  preferredIDE = 'cursor',
  onOpenScrollback,
  onPromptSubmit
}: Props): JSX.Element {
  const onOpenScrollbackRef = useRef(onOpenScrollback)
  const onPromptSubmitRef = useRef(onPromptSubmit)
  useEffect(() => {
    onOpenScrollbackRef.current = onOpenScrollback
    onPromptSubmitRef.current = onPromptSubmit
  }, [onOpenScrollback, onPromptSubmit])
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const savedScrollLineRef = useRef<number | null>(null)
  const bidiObserverRef = useRef<BidiObserver | null>(null)
  const activeRef = useRef(active)
  const preferredIDERef = useRef(preferredIDE)
  const inCopyModeRef = useRef(false)
  const scrollDepthRef = useRef(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatch, setSearchMatch] = useState<{ index: number; count: number } | null>(null)

  useEffect(() => {
    preferredIDERef.current = preferredIDE
  }, [preferredIDE])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink,
      cursorStyle,
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        selectionBackground: theme.selectionBackground
      },
      allowProposedApi: true,
      scrollback: 10000,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      // OSC 8 hyperlinks (Claude Code emits these for clickable URLs in its
      // TUI). Without a linkHandler the URL underlines on hover but click is
      // a no-op. Route activate through openExternal so it opens in the
      // system browser. WebLinksAddon below covers raw-text URL detection.
      linkHandler: {
        activate: (_ev, uri) => {
          window.api.openExternal(uri).catch(() => undefined)
        },
        allowNonHttpProtocols: false
      }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((_ev, uri) => {
        window.api.openExternal(uri).catch(() => undefined)
      })
    )
    term.loadAddon(new ClipboardAddon())
    term.loadAddon(search)
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchMatch(resultCount > 0 ? { index: resultIndex + 1, count: resultCount } : null)
    })
    term.open(host)

    // Keep xterm out of mouse-reporting mode, so a drag is xterm-native text
    // selection (purple, sticky, ⌘C copies) instead of being forwarded to the
    // pty as a mouse event.
    //
    // We used to do this by regex-stripping the DECSETs out of each PTY chunk
    // (see stripMouseTracking, still there as a cheap first pass). That is not
    // reliable on its own: PTY data arrives in arbitrary chunks, so a chunk
    // boundary landing inside `\x1b[?1000h` makes the regex miss it, xterm
    // enters mouse mode, and selection — and therefore copy — is dead until a
    // matching reset happens to arrive un-split. That is the intermittent
    // "sometimes I can't copy at all".
    //
    // Registering with the parser fixes it properly: xterm reassembles split
    // sequences internally before dispatching, and a handler returning `true`
    // consumes the sequence before xterm's own DECSET handler runs.
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, isAllMouseModes)
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, isAllMouseModes)

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true

      // Shift+Enter — multiline submit marker into Claude's TUI
      if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        window.api.writeSession(session.id, '\x1b\r')
        return false
      }

      // ⌘⇧C — open the scrollback overlay. xterm's custom-key handler
      // wraps `return false` with `cancel(event)` which stops propagation,
      // so the window-level App.tsx handler never sees it. Trigger it from
      // here directly instead.
      if (
        ev.metaKey &&
        ev.shiftKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        ev.key.toLowerCase() === 'c'
      ) {
        onOpenScrollbackRef.current?.()
        return false
      }

      // ⌘C — copy current selection. We don't intercept plain Ctrl+C:
      // that has to stay reserved for SIGINT, otherwise users can't interrupt
      // a running Claude when they happen to have something selected.
      const isCmdC =
        ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'c'
      if (isCmdC) {
        const sel = term.getSelection()
        if (sel) copyToClipboard(sel)
        return false
      }

      return true
    })

    // Note: we deliberately do NOT auto-copy on mouseup. Selecting text just
    // selects it; the user explicitly presses ⌘C when they want it on the
    // clipboard. This matches macOS Terminal / Cursor / VSCode behavior and
    // avoids surprise clipboard overwrites.

    // Track left-button state so the wheel handler can suppress scroll
    // during an active drag — otherwise tmux scrolls fresh content under
    // xterm's visual selection (which is anchored to buffer rows), and the
    // selection appears to slide with the viewport.
    // All host listeners added in this effect are registered with this
    // AbortController's signal and removed in one shot by the cleanup —
    // without it they piled up across effect re-runs (StrictMode double-mount,
    // session.id changes) and kept firing on stale closures.
    const listenerAborter = new AbortController()
    const hostSignal = { signal: listenerAborter.signal }

    let dragInProgress = false
    host.addEventListener(
      'mousedown',
      (e) => {
        if (e.button === 0) {
          dragInProgress = true
          host.classList.add('dragging')
        }
      },
      hostSignal
    )
    const endDragTrack = (e: MouseEvent): void => {
      if (e.button === 0) {
        dragInProgress = false
        host.classList.remove('dragging')
      }
    }
    host.addEventListener('mouseup', endDragTrack, hostSignal)
    host.addEventListener('mouseleave', endDragTrack, hostSignal)

    // Drag-and-drop of image files from Finder: the browser default is to
    // type the file path as text. Override so dropped images are attached
    // to Claude Code via the clipboard-paste flow (write each image to the
    // system clipboard, then send a bracketed-paste sequence so Claude
    // notices and reads the clipboard image as `[Image #N]`).
    host.addEventListener(
      'dragover',
      (e) => {
        const items = e.dataTransfer?.items
        if (items && Array.from(items).some((it) => it.kind === 'file')) {
          e.preventDefault()
        }
      },
      hostSignal
    )
    host.addEventListener(
      'drop',
      async (e) => {
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          if (!file.type.startsWith('image/')) continue
          const path = window.api.getPathForFile(file)
          if (!path) continue
          try {
            await window.api.attachImage(path)
            window.api.writeSession(session.id, '\x1b[200~\x1b[201~')
            if (i < files.length - 1) {
              await new Promise((r) => setTimeout(r, 300))
            }
          } catch {
            /* skip non-image / unreadable */
          }
        }
      },
      hostSignal
    )

    let wheelAccum = 0
    // After a scroll burst settles, reconcile inCopyModeRef with tmux's actual
    // pane_in_mode. With the smart-wheel binding, scrolling a plain shell
    // enters copy-mode (auto-`q`-on-type needed) but scrolling a mouse-mode app
    // (Claude) forwards the wheel — the pane never enters copy-mode, so a
    // leading `q` must NOT be sent. The optimistic flip below keeps the common
    // plain-shell case responsive for the brief window before this resolves.
    let copyModeSyncTimer: ReturnType<typeof setTimeout> | null = null
    const syncCopyModeFromTmux = (): void => {
      if (copyModeSyncTimer) clearTimeout(copyModeSyncTimer)
      copyModeSyncTimer = setTimeout(() => {
        window.api
          .isInCopyMode(session.id)
          .then((on) => {
            inCopyModeRef.current = on
            if (!on) scrollDepthRef.current = 0
          })
          .catch(() => undefined)
      }, 90)
    }
    // Cell under the pointer, 1-based, in X10's 1..223 range. We used to hard-
    // code (1,1): harmless for a plain shell (tmux only needs to know which
    // pane), but wrong for an app that owns the mouse — the smart WheelUpPane
    // binding forwards the event with `send-keys -M`, so Claude Code received
    // every scroll as happening in the top-left corner and ignored it. One
    // tmux client per session means pane coordinates are client coordinates.
    const cellUnderPointer = (ev: WheelEvent): { x: number; y: number } => {
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      const rect = (screen ?? term.element)?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 1, y: 1 }
      const col = Math.floor((ev.clientX - rect.left) / (rect.width / term.cols)) + 1
      const row = Math.floor((ev.clientY - rect.top) / (rect.height / term.rows)) + 1
      return {
        x: Math.min(223, Math.max(1, col)),
        y: Math.min(223, Math.max(1, row))
      }
    }

    term.attachCustomWheelEventHandler((ev) => {
      if (dragInProgress) return false
      if (ev.deltaY === 0) return false
      wheelAccum += ev.deltaY
      const threshold = 30
      const cell = cellUnderPointer(ev)
      let seq = ''
      while (Math.abs(wheelAccum) >= threshold) {
        const dir = wheelAccum < 0 ? -1 : 1
        seq += encodeX10Wheel(dir < 0 ? WHEEL_UP : WHEEL_DOWN, cell.x, cell.y)
        if (dir < 0) {
          scrollDepthRef.current += 1
          inCopyModeRef.current = true
        } else {
          scrollDepthRef.current = Math.max(0, scrollDepthRef.current - 1)
          if (scrollDepthRef.current === 0) inCopyModeRef.current = false
        }
        wheelAccum -= dir * threshold
      }
      if (seq) {
        // writeSessionBytes, NOT writeSession: an X10 report encodes each
        // coordinate as `cell + 32`, so from column 96 onward the byte goes
        // above 0x7F. Sent as a string it would be UTF-8 encoded into two
        // bytes, tmux would fail to parse the report, and the stray byte would
        // be typed into the pane as a literal character — one per wheel notch,
        // always the same character for a given pointer column.
        window.api.writeSessionBytes(session.id, seq)
        syncCopyModeFromTmux()
      }
      return false
    })

const LINK_RE = /([\w./~-]*[\w-][\w/-]*\.[a-zA-Z][a-zA-Z0-9]{0,7}):(\d+)(?::(\d+))?/g

    term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const buffer = term.buffer.active
        const line = buffer.getLine(lineNumber - 1)
        if (!line) {
          callback(undefined)
          return
        }
        const text = line.translateToString(true)
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } }
          text: string
          activate: () => void
        }> = []
        LINK_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = LINK_RE.exec(text)) !== null) {
          const [match, path, lineStr, colStr] = m
          const startCol = m.index + 1
          const endCol = m.index + match.length
          links.push({
            range: { start: { x: startCol, y: lineNumber }, end: { x: endCol, y: lineNumber } },
            text: match,
            activate: () => {
              window.api
                .openFile({
                  path,
                  line: Number(lineStr) || undefined,
                  col: colStr ? Number(colStr) : undefined,
                  cwd: session.cwd,
                  ide: preferredIDERef.current
                })
                .catch(() => undefined)
            }
          })
        }
        callback(links.length ? (links as never) : undefined)
      }
    })

    // With xterm in native mouse mode, click events are forwarded to tmux
    // instead of triggering xterm's link-provider activate callback. Restore
    // the click-to-open by running the same path-matching logic ourselves on
    // a captured click event; tmux still receives the mouse press/release as
    // a no-op (MouseDown1Pane = select-pane, MouseUp1Pane unbound).
    host.addEventListener(
      'click',
      (e) => {
        if (e.button !== 0) return
        const term = termRef.current
        if (!term) return
        const screen =
          (host.querySelector('.xterm-screen') as HTMLElement | null) ?? host
        const rect = screen.getBoundingClientRect()
        const cellW = rect.width / term.cols
        const cellH = rect.height / term.rows
        if (!cellW || !cellH) return
        const col = Math.floor((e.clientX - rect.left) / cellW) + 1
        const visualRow = Math.floor((e.clientY - rect.top) / cellH)
        if (visualRow < 0 || visualRow >= term.rows) return
        const buf = term.buffer.active
        const line = buf.getLine(buf.viewportY + visualRow)
        if (!line) return
        const text = line.translateToString(true)
        LINK_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = LINK_RE.exec(text)) !== null) {
          const startCol = m.index + 1
          const endCol = m.index + m[0].length
          if (col >= startCol && col <= endCol) {
            const [, path, lineStr, colStr] = m
            window.api
              .openFile({
                path,
                line: Number(lineStr) || undefined,
                col: colStr ? Number(colStr) : undefined,
                cwd: session.cwd,
                ide: preferredIDERef.current
              })
              .catch(() => undefined)
            return
          }
        }
      },
      { capture: true, signal: listenerAborter.signal }
    )

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    // RTL direction: a JS observer tags any row containing Hebrew with
    // `.rtl-row` (→ direction: rtl, English runs isolated). This beats the
    // CSS-only `unicode-bidi: plaintext` approach, which keys off each row's
    // FIRST strong character — so a mostly-Hebrew line that starts with an
    // LTR bullet/prompt/tool-name (⏺, ●, >, etc.) wrongly renders LTR. The
    // observer's asymmetric debounce keeps the spinner from flicker-toggling.
    bidiObserverRef.current = setupBidiObserver(host, () => activeRef.current)


    let cancelled = false
    const init = async () => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* noop */
        }
      })
      const dims = fit.proposeDimensions() ?? { cols: 100, rows: 30 }
      await window.api.attachSession(session.id, dims.cols, dims.rows)
      if (cancelled) return
      // Reconcile copy-mode once on (re)attach: the pane's tmux copy-mode
      // survives a client detach, so a session evicted from the LRU while
      // scrolled up can remount with the pane still in copy-mode — without
      // this, inCopyModeRef would be a stale false and the first keystroke
      // wouldn't send the leading `q` to exit it.
      window.api
        .isInCopyMode(session.id)
        .then((on) => {
          if (!cancelled) inCopyModeRef.current = on
        })
        .catch(() => undefined)
      unsubRef.current = window.api.onSessionData((id, data) => {
        // Strip mouse-tracking DECSETs (1000/1002/1006 etc.) so xterm stays
        // out of mouse mode. That way drag = xterm-native text selection
        // (purple, sticky, ⌘C copies) — like macOS Terminal / iTerm. For
        // selecting content that scrolled off-screen, use the ⌘⇧C overlay.
        // The wheel handler below still passes wheel events to tmux as X10
        // codes manually so scrolling still enters tmux's copy-mode.
        if (id === session.id) term.write(stripMouseTracking(data))
      })
      // Mirror what the user is currently typing into the input line. We
      // tap term.onData (the same channel that writes to the pty) so the
      // buffer is independent of how Claude's TUI renders — works in any
      // shell or app. Submitted prompts (plain CR) bubble up via
      // onPromptSubmit; Shift+Enter is rewritten as `\x1b\r` upstream so it
      // doesn't trigger a submit here.
      let inputBuf = ''
      let inEsc = false
      let inCsi = false
      let inOsc = false
      // Filter just enough to skip the "I'm setting up my shell" inputs that
      // happen before Claude even starts: cd / ls / clear / claude / etc.
      // Anything longer than 30 chars is treated as a real prompt — picking
      // a tighter cap stops English prompts like "find the bug in X" or
      // "open the README" from being misclassified as shell commands just
      // because they start with `find` or `open`.
      const SHELL_CMD_RE =
        /^\s*(?:claude|exit|clear|reset|cd|ls|pwd|tmux|history)(?:\s|$)/i
      const looksLikeShellCmd = (s: string): boolean =>
        s.length < 30 && SHELL_CMD_RE.test(s)
      const onTypedChunk = (data: string): void => {
        for (const ch of data) {
          const code = ch.charCodeAt(0)
          if (inEsc) {
            if (ch === '[') {
              inEsc = false
              inCsi = true
            } else if (ch === ']') {
              // OSC start (ESC ]) — xterm answers OSC color queries on this
              // same data channel, so we have to skip the response body or
              // it gets dumped into the input buffer.
              inEsc = false
              inOsc = true
            } else if (ch === '\r' || ch === '\n') {
              // Shift+Enter (the TerminalView keyhandler rewrites it as
              // `\x1b\r`) — treat as a soft line break inside the prompt so
              // multi-line prompts render as "line1 line2" not "line1line2".
              inEsc = false
              if (inputBuf && !inputBuf.endsWith(' ')) inputBuf += ' '
            } else {
              inEsc = false
            }
            continue
          }
          if (inCsi) {
            if (code >= 0x40 && code <= 0x7e) inCsi = false
            continue
          }
          if (inOsc) {
            // OSC ends on BEL (\x07) or ST (\x1b \\). Treat any ESC as the
            // start of ST and exit OSC; the trailing `\` will be eaten by the
            // post-ESC branch on the next iteration.
            if (code === 0x07) inOsc = false
            else if (code === 0x1b) {
              inOsc = false
              inEsc = true
            }
            continue
          }
          if (code === 0x1b) {
            inEsc = true
            continue
          }
          if (code === 0x7f || code === 0x08) {
            inputBuf = inputBuf.slice(0, -1)
            continue
          }
          if (ch === '\r' || ch === '\n') {
            const prompt = inputBuf.trim()
            inputBuf = ''
            if (prompt && !looksLikeShellCmd(prompt)) onPromptSubmitRef.current?.(prompt)
            continue
          }
          if (code >= 32) inputBuf += ch
        }
      }
      term.onData((data) => {
        onTypedChunk(data)
        if (inCopyModeRef.current) {
          inCopyModeRef.current = false
          scrollDepthRef.current = 0
          window.api.writeSession(session.id, 'q' + data)
          return
        }
        window.api.writeSession(session.id, data)
      })
      term.onResize(({ cols, rows }) => {
        window.api.resizeSession(session.id, cols, rows)
      })
    }
    init()

    return () => {
      cancelled = true
      listenerAborter.abort()
      if (copyModeSyncTimer) clearTimeout(copyModeSyncTimer)
      unsubRef.current?.()
      unsubRef.current = null
      bidiObserverRef.current?.disconnect()
      bidiObserverRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [session.id])

  // Keep the bidi observer's active-gate in sync, and when this terminal
  // becomes visible again, retag its rows in one pass (they weren't tracked
  // while it was in the background).
  useEffect(() => {
    activeRef.current = active
    if (active) bidiObserverRef.current?.forceRetagNow()
  }, [active])

  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])

  useEffect(() => {
    if (!active) return
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail
      if (!detail) return
      setSearchOpen(true)
      setSearchQuery(detail)
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        searchRef.current?.findPrevious(detail, {
          decorations: {
            matchBackground: '#7c3aed55',
            matchBorder: '#7c3aed',
            matchOverviewRuler: '#7c3aed',
            activeMatchBackground: '#7c3aedaa',
            activeMatchBorder: '#a78bfa',
            activeMatchColorOverviewRuler: '#a78bfa'
          }
        })
      })
    }
    window.addEventListener('pk:search', handler as EventListener)
    return () => window.removeEventListener('pk:search', handler as EventListener)
  }, [active])

  // Sidebar click → focus the terminal. The active-prop effect already
  // focuses on activation, but it doesn't re-fire when clicking the already
  // active session (active stays true). This event covers that case and
  // also handles cases where focus drifted to a dialog/overlay/sidebar
  // button. We defer to two RAFs so the click's own focus-stealing settles
  // first, then we steal it back.
  useEffect(() => {
    const handler = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (id && id !== session.id) return
      if (!active) return
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Don't steal focus from a real text input — sidebar rename,
          // search bar, settings field, etc. Single-click into a session
          // races with double-click-to-rename; if the user landed on the
          // rename input, leave it alone.
          if (isTextEntryFocused()) return
          termRef.current?.focus()
        })
      })
    }
    window.addEventListener('pk:focus-terminal', handler as EventListener)
    return () => window.removeEventListener('pk:focus-terminal', handler as EventListener)
  }, [active, session.id])

  // Bringing the app back to the front (⌘-Tab, dock click, clicking the
  // window) used to leave the terminal unfocused — the first thing you typed
  // went nowhere and you had to click into the pane first. Re-focus the
  // active session's terminal on window focus, unless a real form field owns
  // it (a half-typed rename or search must survive the app switch).
  useEffect(() => {
    if (!active) return
    const onWindowFocus = (): void => {
      requestAnimationFrame(() => {
        if (isTextEntryFocused()) return
        termRef.current?.focus()
      })
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [active])

  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontFamily
    term.options.lineHeight = lineHeight
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
    term.options.theme = {
      background: theme.background,
      foreground: theme.foreground,
      cursor: theme.cursor,
      selectionBackground: theme.selectionBackground
    }
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* noop */
      }
    })
  }, [
    fontSize,
    fontFamily,
    lineHeight,
    cursorStyle,
    cursorBlink,
    theme.background,
    theme.foreground,
    theme.cursor,
    theme.selectionBackground
  ])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (active) {
      const fit = fitRef.current
      const onResize = (): void => {
        try {
          fit?.fit()
        } catch {
          /* noop */
        }
      }
      requestAnimationFrame(() => {
        onResize()
        if (savedScrollLineRef.current !== null) {
          try {
            term.scrollToLine(savedScrollLineRef.current)
          } catch {
            /* noop */
          }
          savedScrollLineRef.current = null
        }
      })
      window.addEventListener('resize', onResize)
      // Also watch the terminal host element directly so layout changes
      // outside the window (e.g., the conversation panel opening to the
      // right shrinks our column) refit the canvas immediately. Without
      // this, the xterm canvas briefly appears to extend under the new
      // panel until the next window resize.
      const host = hostRef.current
      let ro: ResizeObserver | null = null
      if (host && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => onResize())
        ro.observe(host)
      }
      term.focus()
      return () => {
        window.removeEventListener('resize', onResize)
        ro?.disconnect()
      }
    }
    try {
      const buffer = term.buffer.active
      const total = buffer.length
      const viewportY = buffer.viewportY
      const atBottom = viewportY >= Math.max(0, total - term.rows)
      savedScrollLineRef.current = atBottom ? null : viewportY
    } catch {
      savedScrollLineRef.current = null
    }
    return undefined
  }, [active])

  useEffect(() => {
    if (!active) return

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      e.preventDefault()
      const paths: string[] = []
      for (const f of Array.from(files)) {
        const p = window.api.getPathForFile(f)
        if (p) paths.push(quotePath(p))
      }
      if (paths.length === 0) return
      window.api.writeSession(session.id, paths.join(' '))
      termRef.current?.focus()
    }

    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [active, session.id])

  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatch(null)
    searchRef.current?.clearDecorations()
    requestAnimationFrame(() => termRef.current?.focus())
  }

  const runSearch = (forward: boolean): void => {
    const q = searchQuery
    if (!q || !searchRef.current) return
    const opts = {
      decorations: {
        matchBackground: '#7c3aed55',
        matchBorder: '#7c3aed',
        matchOverviewRuler: '#7c3aed',
        activeMatchBackground: '#7c3aedaa',
        activeMatchBorder: '#a78bfa',
        activeMatchColorOverviewRuler: '#a78bfa'
      }
    }
    if (forward) searchRef.current.findNext(q, opts)
    else searchRef.current.findPrevious(q, opts)
  }

  return (
    <div className={`terminal-wrap ${active ? '' : 'hidden'}`}>
      <div ref={hostRef} className="terminal-host" />
      {searchOpen && (
        <div className="terminal-search">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              if (e.target.value) {
                requestAnimationFrame(() => {
                  searchRef.current?.findNext(e.target.value)
                })
              } else {
                searchRef.current?.clearDecorations()
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runSearch(!e.shiftKey)
              }
            }}
          />
          {searchMatch && (
            <span className="terminal-search-count">
              {searchMatch.index}/{searchMatch.count}
            </span>
          )}
          {!searchMatch && searchQuery && (
            <span className="terminal-search-count empty">0/0</span>
          )}
          <button
            type="button"
            className="terminal-search-btn"
            title="Previous (⇧⏎)"
            onClick={() => runSearch(false)}
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-search-btn"
            title="Next (⏎)"
            onClick={() => runSearch(true)}
          >
            ↓
          </button>
          <button
            type="button"
            className="terminal-search-btn"
            title="Close (Esc)"
            onClick={closeSearch}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Put text on the clipboard, preferring the async DOM API and falling back to
 * Electron's clipboard when it rejects (it requires the document to be the
 * focused context, which isn't guaranteed — that rejection was swallowed and
 * showed up as "⌘C did nothing").
 */
function copyToClipboard(text: string): void {
  navigator.clipboard
    .writeText(text)
    .catch(() => window.api.writeClipboard(text).catch(() => undefined))
}

/**
 * True when the user is typing into a real form field (sidebar rename, search
 * box, a settings input) and we must not yank focus away.
 *
 * xterm's own hidden input is deliberately excluded: it's a `<textarea>`, but
 * it IS the terminal, not a field the user is editing. Counting it here made
 * every re-focus a no-op whenever another (LRU-mounted) terminal still held
 * focus — switching sessions left the new pane unfocused.
 */
function isTextEntryFocused(): boolean {
  const ae = document.activeElement as HTMLElement | null
  if (!ae) return false
  if (ae.classList.contains('xterm-helper-textarea') || ae.closest('.xterm')) return false
  const tag = ae.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable === true
}

function quotePath(p: string): string {
  if (!/[\s"'\\$`!*?(){}[\]<>|&;#]/.test(p)) return p
  return `'${p.replace(/'/g, `'\\''`)}'`
}

interface BidiObserver {
  disconnect(): void
  forceRetagNow(): void
}

function setupBidiObserver(host: HTMLElement, isActive: () => boolean): BidiObserver | null {
  // Compute the desired class for a row right now, without applying it.
  // Use textContent (NOT innerText): innerText forces a synchronous reflow on
  // every read, and this runs over every row on each tick + mutation. Reading
  // className / style.backgroundColor is likewise layout-free. The spans feed
  // rowNeedsRtl, which refuses to flip positional layouts (frames, split
  // panes) — see shared/bidi.ts.
  const XTERM_BG_CLASS_RE = /(?:^|\s)xterm-bg-(\d+)(?:\s|$)/
  const desiredRtl = (row: Element): boolean => {
    const spans: RowSpan[] = []
    row.childNodes.forEach((n) => {
      const text = n.textContent || ''
      if (!(n instanceof HTMLElement)) {
        spans.push({ text, bg: '' })
        return
      }
      const cls = XTERM_BG_CLASS_RE.exec(n.className)
      spans.push({ text, bg: cls ? `p${cls[1]}` : n.style.backgroundColor || '' })
    })
    return rowNeedsRtl(spans)
  }

  // Two-phase debounce: each mutation updates a "pending" desired state. We
  // only flush pending states to actual `.rtl-row` class after the row has
  // been STABLE for QUIET_MS. This prevents Claude Code's spinner (which
  // flips a row's content 10+ times per second) from flicker-toggling the
  // direction on every frame. Normal Hebrew typing is well under 5 chars
  // per second so the lag is imperceptible to humans, but the spinner's
  // continuous churn never gets a chance to settle and thus never flips.
  const QUIET_MS = 250

  type RowState = { desired: boolean; lastChangeTs: number }
  const rowStates = new WeakMap<Element, RowState>()

  // Asymmetric strategy: ADD `.rtl-row` immediately, REMOVE it with debounce.
  //   • Adding Hebrew direction is always safe — if the row has Hebrew, we
  //     should flip RTL. A spinner that briefly shows Hebrew → keeps RTL,
  //     which matches the visible majority content. Scroll into Hebrew →
  //     tagged on the first frame, no "wrong direction" flash.
  //   • Removing requires QUIET_MS of stability — prevents flicker when a
  //     row's Hebrew content transiently disappears (spinner blank frame,
  //     scroll-induced cell churn, screen-clear repaint, etc).
  const tickAllRows = (): void => {
    // Only the visible (active) terminal needs live RTL tagging. Every visited
    // session stays mounted (App keeps them for fast switching), so without
    // this guard N background terminals would each retag on a 120ms timer and
    // on every streamed mutation. Inactive ones are re-tagged in full when
    // they become active again (forceRetagNow from the active effect).
    if (!isActive()) return
    const rowsEl = host.querySelector('.xterm-rows')
    if (!rowsEl) return
    const now = Date.now()
    rowsEl.childNodes.forEach((n) => {
      if (!(n instanceof Element)) return
      const want = desiredRtl(n)
      const cur = n.classList.contains('rtl-row')
      let state = rowStates.get(n)
      if (!state) {
        state = { desired: want, lastChangeTs: now }
        rowStates.set(n, state)
      }
      if (want !== state.desired) {
        state.desired = want
        state.lastChangeTs = now
      }
      if (want && !cur) {
        n.classList.add('rtl-row')
      } else if (!want && cur && now - state.lastChangeTs >= QUIET_MS) {
        n.classList.remove('rtl-row')
      }
    })
  }

  // Run on mutation (to record new pending states) AND on a steady tick (so
  // we eventually flush after the quiet period even if no further mutations
  // happen).
  let scheduled = false
  const schedule = (): void => {
    if (scheduled || !isActive()) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      tickAllRows()
    })
  }
  const interval = window.setInterval(tickAllRows, 120)
  const observer = new MutationObserver(schedule)
  const start = (): void => {
    const rowsEl = host.querySelector('.xterm-rows')
    if (!rowsEl) {
      requestAnimationFrame(start)
      return
    }
    observer.observe(rowsEl, { childList: true, subtree: true, characterData: true })
    tickAllRows()
  }
  start()
  return {
    disconnect(): void {
      window.clearInterval(interval)
      observer.disconnect()
    },
    forceRetagNow(): void {
      tickAllRows()
    }
  }
}

