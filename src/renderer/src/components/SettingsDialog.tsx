import { useEffect, useState } from 'react'
import type { Settings, ThemeName, CursorStyle, SoundType } from '../types'
import { THEME_PRESETS } from '../types'

interface Props {
  initial: Settings
  onSave: (next: Settings) => void
  onCancel: () => void
  onTestSound: (volume: number, soundType: SoundType) => void
  onShowOnboarding?: () => void
  initialTab?: SettingsTab
}

const SESSION_COLORS = ['#7c3aed', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

const THEME_LABELS: Record<ThemeName, string> = {
  default: 'Default (purple on black)',
  'solarized-dark': 'Solarized Dark',
  dracula: 'Dracula',
  nord: 'Nord',
  light: 'Light',
  custom: 'Custom'
}

const FONT_OPTIONS: Array<{ label: string; value: string; note?: string }> = [
  { label: 'Menlo', value: 'Menlo, "Arial Hebrew", monospace', note: 'Hebrew-friendly' },
  { label: 'SF Mono', value: '"SF Mono", Menlo, "Arial Hebrew", monospace' },
  { label: 'Monaco', value: 'Monaco, Menlo, "Arial Hebrew", monospace' },
  { label: 'Courier New', value: '"Courier New", monospace', note: 'classic' },
  { label: 'Inconsolata', value: 'Inconsolata, Menlo, monospace' }
]

type SettingsTab =
  | 'notifications'
  | 'sessions'
  | 'appearance'
  | 'shortcuts'
  | 'updates'
  | 'privacy'
  | 'about'

function Hint({ text }: { text: string }): JSX.Element {
  return (
    <span className="settings-hint-icon" title={text} aria-label={text}>
      ⓘ
    </span>
  )
}

export function SettingsDialog({ initial, onSave, onCancel, onTestSound, onShowOnboarding, initialTab = 'notifications' }: Props): JSX.Element {
  const [draft, setDraft] = useState<Settings>(initial)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [appVersion, setAppVersion] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<string>('idle')
  const [updateMsg, setUpdateMsg] = useState<string>('')

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => undefined)
  }, [])

  useEffect(() => {
    return window.api.onUpdateStatus((status, payload) => {
      setUpdateStatus(status)
      if (status === 'available' && payload && typeof payload === 'object' && 'version' in payload) {
        setUpdateMsg(`v${(payload as { version: string }).version} available — downloading…`)
      } else if (status === 'downloaded') {
        setUpdateMsg('Update downloaded — will install on next restart')
      } else if (status === 'error') {
        setUpdateMsg(typeof payload === 'string' ? payload : 'Update error')
      } else if (status === 'up-to-date') {
        setUpdateMsg('You are on the latest version')
      } else if (status === 'checking') {
        setUpdateMsg('Checking for updates…')
      } else if (status === 'downloading' && payload && typeof payload === 'object' && 'percent' in payload) {
        setUpdateMsg(`Downloading… ${Math.round((payload as { percent: number }).percent)}%`)
      }
    })
  }, [])

  const checkForUpdatesNow = async (): Promise<void> => {
    setUpdateStatus('checking')
    setUpdateMsg('Checking for updates…')
    const r = await window.api.checkForUpdatesNow()
    if (!r.ok) {
      setUpdateStatus('error')
      setUpdateMsg(r.reason ?? 'Could not check for updates')
    } else if (!r.hasUpdate) {
      setUpdateStatus('up-to-date')
      setUpdateMsg(`You are on the latest version (${appVersion || '—'})`)
    }
  }

  const update = <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>): void => {
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }))
  }

  const updateCustomTheme = (patch: Partial<Settings['appearance']['customTheme']>): void => {
    setDraft((d) => ({
      ...d,
      appearance: { ...d.appearance, customTheme: { ...d.appearance.customTheme, ...patch } }
    }))
  }

  const browseCwd = async (): Promise<void> => {
    const picked = await window.api.pickDirectory()
    if (picked) update('sessions', { defaultCwd: picked })
  }

  const browseProjectsRoot = async (): Promise<void> => {
    const picked = await window.api.pickDirectory()
    if (picked) update('sessions', { projectsRoot: picked })
  }

  const onPickTheme = (t: ThemeName): void => {
    setDraft((d) => {
      if (t === 'custom') return { ...d, appearance: { ...d.appearance, theme: t } }
      return {
        ...d,
        appearance: { ...d.appearance, theme: t, customTheme: { ...THEME_PRESETS[t] } }
      }
    })
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="dialog-tabs">
          <button
            className={`dialog-tab ${tab === 'notifications' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('notifications')}
          >
            Notifications
          </button>
          <button
            className={`dialog-tab ${tab === 'sessions' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('sessions')}
          >
            Sessions
          </button>
          <button
            className={`dialog-tab ${tab === 'appearance' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('appearance')}
          >
            Appearance
          </button>
          <button
            className={`dialog-tab ${tab === 'shortcuts' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('shortcuts')}
          >
            Shortcuts
          </button>
          <button
            className={`dialog-tab ${tab === 'updates' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('updates')}
          >
            Updates
          </button>
          <button
            className={`dialog-tab ${tab === 'privacy' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('privacy')}
          >
            Privacy
          </button>
          <button
            className={`dialog-tab ${tab === 'about' ? 'active' : ''}`}
            type="button"
            onClick={() => setTab('about')}
          >
            About
          </button>
        </div>

        <div className="settings-scroll">
          {tab === 'notifications' && (
          <section className="settings-section">
            <h3>Notifications</h3>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.notifications.soundEnabled}
                onChange={(e) => update('notifications', { soundEnabled: e.target.checked })}
              />
              <span>Sound on awaiting</span>
              <Hint text="Plays a chime/beep whenever Claude is waiting for your input on a session that isn't currently active." />
              <select
                className="settings-input settings-input-narrow"
                value={draft.notifications.soundType}
                onChange={(e) => update('notifications', { soundType: e.target.value as SoundType })}
                disabled={!draft.notifications.soundEnabled}
              >
                <option value="chime">Chime</option>
                <option value="beep">Beep</option>
              </select>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() => onTestSound(draft.notifications.volume, draft.notifications.soundType)}
                disabled={!draft.notifications.soundEnabled}
              >
                test
              </button>
            </label>
            <label className="settings-row">
              <span className="settings-label">Volume</span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={draft.notifications.volume}
                onChange={(e) => update('notifications', { volume: Number(e.target.value) })}
                disabled={!draft.notifications.soundEnabled}
              />
              <span className="settings-value">{Math.round(draft.notifications.volume * 100)}%</span>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() => onTestSound(draft.notifications.volume, draft.notifications.soundType)}
                disabled={!draft.notifications.soundEnabled}
                title="Play preview"
              >
                ▶ preview
              </button>
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.notifications.systemNotifications}
                onChange={(e) => update('notifications', { systemNotifications: e.target.checked })}
              />
              <span>System notifications + dock bounce</span>
              <Hint text="macOS notification banner + the dock icon bounces when Claude is awaiting. Click the notification to focus that session." />
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.notifications.onlyWhenUnfocused}
                onChange={(e) => update('notifications', { onlyWhenUnfocused: e.target.checked })}
              />
              <span>Only when window is unfocused</span>
              <Hint text="Suppress alerts while PikudClaude is the active application — useful so you don't get notified for sessions you're already watching." />
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.notifications.quietHoursEnabled}
                onChange={(e) => update('notifications', { quietHoursEnabled: e.target.checked })}
              />
              <span>Quiet hours</span>
              <Hint text="Suppress all sound and system notifications during the configured time window (e.g., overnight)." />
              <input
                type="time"
                className="settings-input settings-input-narrow"
                value={draft.notifications.quietHoursStart}
                onChange={(e) => update('notifications', { quietHoursStart: e.target.value })}
                disabled={!draft.notifications.quietHoursEnabled}
              />
              <span className="settings-value">→</span>
              <input
                type="time"
                className="settings-input settings-input-narrow"
                value={draft.notifications.quietHoursEnd}
                onChange={(e) => update('notifications', { quietHoursEnd: e.target.value })}
                disabled={!draft.notifications.quietHoursEnabled}
              />
            </label>
          </section>
          )}

          {tab === 'sessions' && (
          <section className="settings-section">
            <h3>Sessions</h3>
            <label className="settings-row">
              <span className="settings-label">
                Default command
                <Hint text="Auto-runs in every new session right after the shell starts (e.g. 'claude' or 'claude --resume'). Leave empty to start with a plain shell." />
              </span>
              <input
                type="text"
                className="settings-input"
                value={draft.sessions.defaultInitialCommand}
                onChange={(e) => update('sessions', { defaultInitialCommand: e.target.value })}
                placeholder="claude"
              />
            </label>
            <div className="settings-row settings-row-stack">
              <span className="settings-label">
                Commands library
                <Hint text="Quick-pick presets shown when creating a new session. Common entries: 'claude', 'claude --resume', 'claude --continue'." />
              </span>
              <div className="cmd-library">
                {draft.sessions.initialCommandsLibrary.map((cmd, i) => (
                  <div className="cmd-library-row" key={i}>
                    <input
                      type="text"
                      className="settings-input"
                      value={cmd}
                      onChange={(e) => {
                        const next = [...draft.sessions.initialCommandsLibrary]
                        next[i] = e.target.value
                        update('sessions', { initialCommandsLibrary: next })
                      }}
                      placeholder="claude --resume"
                    />
                    <button
                      type="button"
                      className="cmd-library-remove"
                      title="Remove"
                      onClick={() => {
                        const next = draft.sessions.initialCommandsLibrary.filter((_, j) => j !== i)
                        update('sessions', { initialCommandsLibrary: next })
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="settings-test-btn cmd-library-add"
                  onClick={() =>
                    update('sessions', {
                      initialCommandsLibrary: [...draft.sessions.initialCommandsLibrary, '']
                    })
                  }
                >
                  + Add command
                </button>
                <p className="settings-hint">Quick-pick when creating a new session.</p>
              </div>
            </div>
            <label className="settings-row">
              <span className="settings-label">
                Projects folder
                <Hint text="Parent folder where you keep your code projects. Used to populate the New Session picker with your projects, and as the default cwd if none is set." />
              </span>
              <input
                type="text"
                className="settings-input"
                value={draft.sessions.projectsRoot}
                onChange={(e) => update('sessions', { projectsRoot: e.target.value })}
                placeholder="(parent folder of your projects)"
              />
              <button type="button" className="settings-test-btn" onClick={browseProjectsRoot}>
                browse
              </button>
            </label>
            <label className="settings-row">
              <span className="settings-label">
                Default cwd
                <Hint text="Starting directory for new sessions when you don't pick one. Falls back to the projects folder if empty." />
              </span>
              <input
                type="text"
                className="settings-input"
                value={draft.sessions.defaultCwd}
                onChange={(e) => update('sessions', { defaultCwd: e.target.value })}
                placeholder="(uses projects folder)"
              />
              <button type="button" className="settings-test-btn" onClick={browseCwd}>
                browse
              </button>
            </label>
            <label className="settings-row">
              <span className="settings-label">Default color</span>
              <div className="color-pick">
                {SESSION_COLORS.map((c) => (
                  <div
                    key={c}
                    className={`color-swatch ${c === draft.sessions.defaultColor ? 'selected' : ''}`}
                    style={{ background: c }}
                    onClick={() => update('sessions', { defaultColor: c })}
                  />
                ))}
              </div>
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.sessions.autoBookmarkOnAwaiting}
                onChange={(e) => update('sessions', { autoBookmarkOnAwaiting: e.target.checked })}
              />
              <span>Auto-bookmark on awaiting</span>
              <Hint text="Automatically save a bookmark each time Claude pauses to ask you something — handy for jumping back to recent decision points." />
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.sessions.trackPrompts}
                onChange={(e) => update('sessions', { trackPrompts: e.target.checked })}
              />
              <span>Track prompts</span>
              <Hint text="Capture the last prompt you typed in each session and show it as a pill in the top bar + subtitle in the sidebar. Disable for privacy if you'd rather not have prompts saved to disk." />
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.sessions.autoBookmarkOnPrompt}
                onChange={(e) => update('sessions', { autoBookmarkOnPrompt: e.target.checked })}
                disabled={!draft.sessions.trackPrompts}
              />
              <span>Auto-bookmark on each prompt</span>
              <Hint text="Save a bookmark labelled with the prompt every time you submit one. Useful for getting back to a specific decision point — but quickly fills the bookmarks panel." />
            </label>
            <label className="settings-row">
              <span className="settings-label">
                Recent projects max
                <Hint text="How many recently-used project paths to remember and display in the New Session dialog." />
              </span>
              <input
                type="number"
                className="settings-input settings-input-narrow"
                min={1}
                max={50}
                value={draft.sessions.recentProjectsMax}
                onChange={(e) =>
                  update('sessions', {
                    recentProjectsMax: Math.max(1, Math.min(50, Number(e.target.value) || 6))
                  })
                }
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">
                Open file paths in
                <Hint text="Which app to launch when you click a 'path/file.ts:42' link in the terminal output." />
              </span>
              <select
                className="settings-input"
                value={draft.sessions.preferredIDE}
                onChange={(e) =>
                  update('sessions', { preferredIDE: e.target.value as 'cursor' | 'vscode' | 'finder' })
                }
              >
                <option value="cursor">Cursor</option>
                <option value="vscode">VSCode</option>
                <option value="finder">Finder (reveal in folder)</option>
              </select>
            </label>
          </section>
          )}

          {tab === 'appearance' && (
          <section className="settings-section">
            <h3>Appearance</h3>
            <label className="settings-row">
              <span className="settings-label">Theme</span>
              <select
                className="settings-input"
                value={draft.appearance.theme}
                onChange={(e) => onPickTheme(e.target.value as ThemeName)}
              >
                {(Object.keys(THEME_LABELS) as ThemeName[]).map((t) => (
                  <option key={t} value={t}>
                    {THEME_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Background</span>
              <input
                type="color"
                value={draft.appearance.customTheme.background}
                onChange={(e) => {
                  updateCustomTheme({ background: e.target.value })
                  if (draft.appearance.theme !== 'custom') update('appearance', { theme: 'custom' })
                }}
              />
              <input
                type="text"
                className="settings-input"
                value={draft.appearance.customTheme.background}
                onChange={(e) => updateCustomTheme({ background: e.target.value })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">Foreground</span>
              <input
                type="color"
                value={draft.appearance.customTheme.foreground}
                onChange={(e) => {
                  updateCustomTheme({ foreground: e.target.value })
                  if (draft.appearance.theme !== 'custom') update('appearance', { theme: 'custom' })
                }}
              />
              <input
                type="text"
                className="settings-input"
                value={draft.appearance.customTheme.foreground}
                onChange={(e) => updateCustomTheme({ foreground: e.target.value })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">Cursor color</span>
              <input
                type="color"
                value={draft.appearance.customTheme.cursor}
                onChange={(e) => {
                  updateCustomTheme({ cursor: e.target.value })
                  if (draft.appearance.theme !== 'custom') update('appearance', { theme: 'custom' })
                }}
              />
              <input
                type="text"
                className="settings-input"
                value={draft.appearance.customTheme.cursor}
                onChange={(e) => updateCustomTheme({ cursor: e.target.value })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">Font family</span>
              <select
                className="settings-input"
                value={
                  FONT_OPTIONS.find((f) => f.value === draft.appearance.fontFamily)?.value ?? '__custom__'
                }
                onChange={(e) => {
                  if (e.target.value !== '__custom__') {
                    update('appearance', { fontFamily: e.target.value })
                  }
                }}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f.label} value={f.value}>
                    {f.label}
                    {f.note ? ` — ${f.note}` : ''}
                  </option>
                ))}
                <option value="__custom__">Custom (edit below)</option>
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Custom font</span>
              <input
                type="text"
                className="settings-input"
                value={draft.appearance.fontFamily}
                onChange={(e) => update('appearance', { fontFamily: e.target.value })}
                placeholder="font-family CSS string"
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">Font size</span>
              <input
                type="number"
                className="settings-input settings-input-narrow"
                min={9}
                max={28}
                value={draft.appearance.fontSize}
                onChange={(e) =>
                  update('appearance', { fontSize: Math.max(9, Math.min(28, Number(e.target.value) || 13)) })
                }
              />
              <span className="settings-value">px</span>
            </label>
            <label className="settings-row">
              <span className="settings-label">Line height</span>
              <input
                type="number"
                className="settings-input settings-input-narrow"
                min={1.0}
                max={2.0}
                step={0.05}
                value={draft.appearance.lineHeight}
                onChange={(e) =>
                  update('appearance', {
                    lineHeight: Math.max(1.0, Math.min(2.0, Number(e.target.value) || 1.15))
                  })
                }
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">Cursor style</span>
              <select
                className="settings-input"
                value={draft.appearance.cursorStyle}
                onChange={(e) => update('appearance', { cursorStyle: e.target.value as CursorStyle })}
              >
                <option value="block">Block</option>
                <option value="underline">Underline</option>
                <option value="bar">Bar</option>
              </select>
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.appearance.cursorBlink}
                onChange={(e) => update('appearance', { cursorBlink: e.target.checked })}
              />
              <span>Cursor blink</span>
            </label>
          </section>
          )}

          {tab === 'shortcuts' && (
          <section className="settings-section">
            <h3>Keyboard shortcuts</h3>
            <div className="shortcuts-grid">
              <div className="shortcuts-group">Sessions</div>
              <div></div>
              <div className="shortcut-keys"><kbd>⌘N</kbd></div>
              <div>New session (or import)</div>
              <div className="shortcut-keys"><kbd>⌘1</kbd>…<kbd>⌘9</kbd></div>
              <div>Jump to session 1–9</div>
              <div className="shortcut-keys"><kbd>⌘P</kbd></div>
              <div>Switch session (palette)</div>

              <div className="shortcuts-group">Navigation</div>
              <div></div>
              <div className="shortcut-keys"><kbd>⌘K</kbd></div>
              <div>Command palette (sessions + actions)</div>
              <div className="shortcut-keys"><kbd>⌘F</kbd></div>
              <div>Find in active terminal</div>
              <div className="shortcut-keys"><kbd>⌘B</kbd></div>
              <div>Bookmark current point</div>
              <div className="shortcut-keys"><kbd>⌘⇧C</kbd></div>
              <div>View scrollback (selectable text)</div>
              <div className="shortcut-keys"><kbd>⌘,</kbd></div>
              <div>Settings</div>

              <div className="shortcuts-group">Terminal input</div>
              <div></div>
              <div className="shortcut-keys"><kbd>↵</kbd></div>
              <div>Submit</div>
              <div className="shortcut-keys"><kbd>⇧↵</kbd></div>
              <div>New line within input (multi-line prompt)</div>

              <div className="shortcuts-group">Sidebar gestures</div>
              <div></div>
              <div className="shortcut-keys">Double-click name</div>
              <div>Rename session</div>
              <div className="shortcut-keys">Click colored dot</div>
              <div>Change session color</div>
              <div className="shortcut-keys">Drag a row</div>
              <div>Reorder sessions</div>

              <div className="shortcuts-group">Prompt pill</div>
              <div></div>
              <div className="shortcut-keys">Click pill</div>
              <div>Find that prompt in the terminal scrollback</div>
              <div className="shortcut-keys">Double-click pill</div>
              <div>Copy prompt text to clipboard</div>
              <div className="shortcut-keys">Hover pill</div>
              <div>Full prompt + action hints</div>

              <div className="shortcuts-group">Terminal mouse</div>
              <div></div>
              <div className="shortcut-keys">Click + drag</div>
              <div>Select text — auto-scrolls at edges, copies on release</div>
              <div className="shortcut-keys">Click <code>file.ts:42</code></div>
              <div>Open file in your preferred IDE</div>
            </div>
          </section>
          )}

          {tab === 'updates' && (
          <section className="settings-section">
            <h3>Updates</h3>
            <div className="settings-row">
              <span>
                Update channel
                <Hint text="Stable: only signed, fully-tested releases. Beta: includes pre-release versions for early testing — may contain bugs." />
              </span>
              <div className="seg-control">
                <button
                  type="button"
                  className={`seg-btn ${draft.updates.channel === 'stable' ? 'on' : ''}`}
                  onClick={() => {
                    update('updates', { channel: 'stable' })
                    window.api.setUpdateChannel('stable').catch(() => undefined)
                  }}
                >
                  Stable
                </button>
                <button
                  type="button"
                  className={`seg-btn ${draft.updates.channel === 'beta' ? 'on' : ''}`}
                  onClick={() => {
                    update('updates', { channel: 'beta' })
                    window.api.setUpdateChannel('beta').catch(() => undefined)
                  }}
                >
                  Beta
                </button>
              </div>
            </div>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={draft.updates.autoCheck}
                onChange={(e) => update('updates', { autoCheck: e.target.checked })}
              />
              <span>Check for updates automatically on launch</span>
              <Hint text="When enabled, PikudClaude checks GitHub for a newer release on every launch. Updates download in the background and install on next quit." />
            </label>
            <div className="settings-row">
              <span>Current version</span>
              <span className="settings-value">{appVersion || '—'}</span>
            </div>
            <div className="settings-row">
              <button type="button" className="settings-test-btn" onClick={checkForUpdatesNow}>
                Check now
              </button>
              <span className={`update-status update-status-${updateStatus}`}>{updateMsg}</span>
            </div>
            <p className="settings-hint">
              Updates are signed and notarized by Apple. Beta releases include unstable changes —
              switch only if you want to test pre-release features.
            </p>
          </section>
          )}

          {tab === 'privacy' && <PrivacySection draft={draft} setDraft={setDraft} />}

          {tab === 'about' && (
          <section className="settings-section about-section">
            <h3>About PikudClaude</h3>
            <p className="about-tagline">Multi-session terminal hub for Claude Code, backed by tmux.</p>
            <div className="about-grid">
              <div className="about-label">Version</div>
              <div className="about-value">{appVersion || '—'}</div>
              <div className="about-label">Author</div>
              <div className="about-value">Kobi Sela (WMG)</div>
              <div className="about-label">Contact</div>
              <div className="about-value">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    window.api.openExternal(
                      `mailto:kobi@wmg.co.il?subject=PikudClaude%20feedback%20(v${appVersion || '?'})`
                    )
                  }}
                >
                  kobi@wmg.co.il
                </a>
              </div>
              <div className="about-label">Repository</div>
              <div className="about-value">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    window.api.openExternal('https://github.com/wmgltd/PikudClaude')
                  }}
                >
                  github.com/wmgltd/PikudClaude
                </a>
              </div>
              <div className="about-label">License</div>
              <div className="about-value">
                MIT — free for personal and commercial use{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    window.api.openExternal(
                      'https://github.com/wmgltd/PikudClaude/blob/main/LICENSE'
                    )
                  }}
                >
                  (read)
                </a>
              </div>
            </div>
            <div className="about-highlight">
              <strong>★ Hebrew/RTL bidi support</strong>
              <p>
                PikudClaude renders Hebrew, Arabic, and other RTL scripts correctly in mixed-direction
                lines — a feature missing from VSCode, Cursor, Hyper, Tabby, and other xterm.js-based
                Electron terminals.
              </p>
            </div>
            <div className="about-feedback">
              <strong>💌 Have ideas or found a bug?</strong>
              <p>
                Send suggestions or issues to{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    window.api.openExternal(
                      `mailto:kobi@wmg.co.il?subject=PikudClaude%20feedback%20(v${appVersion || '?'})&body=`
                    )
                  }}
                >
                  kobi@wmg.co.il
                </a>
                .
              </p>
            </div>
            <div className="about-actions">
              <button
                type="button"
                className="settings-test-btn"
                onClick={() =>
                  window.api.openExternal(
                    `mailto:kobi@wmg.co.il?subject=PikudClaude%20feedback%20(v${appVersion || '?'})`
                  )
                }
              >
                ✉ Send feedback
              </button>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() =>
                  window.api.openExternal('https://github.com/wmgltd/PikudClaude/issues/new')
                }
              >
                Report issue
              </button>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() =>
                  window.api.openExternal('https://github.com/wmgltd/PikudClaude/releases')
                }
              >
                Releases
              </button>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() => window.api.openExternal('https://github.com/anthropics/claude-code')}
              >
                Claude Code
              </button>
              <button
                type="button"
                className="settings-test-btn"
                onClick={() => window.api.revealErrorLog().catch(() => undefined)}
                title="Open the userData folder containing error-log.txt and any crash dumps"
              >
                Show crash logs
              </button>
              {onShowOnboarding && (
                <button
                  type="button"
                  className="settings-test-btn"
                  onClick={onShowOnboarding}
                  title="Re-show the welcome / onboarding dialog"
                >
                  Show onboarding
                </button>
              )}
            </div>
          </section>
          )}
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function PrivacySection({
  draft,
  setDraft
}: {
  draft: Settings
  setDraft: (updater: (d: Settings) => Settings) => void
}): JSX.Element {
  const [anonId, setAnonId] = useState<string>('')
  const [showPreview, setShowPreview] = useState(false)
  const [payloadJson, setPayloadJson] = useState<string>('')

  useEffect(() => {
    window.api
      .getTelemetryStatus()
      .then((s) => setAnonId(s.anonId))
      .catch(() => undefined)
  }, [])

  const enabled = draft.telemetry.enabled

  const toggle = async (next: boolean): Promise<void> => {
    setDraft((d) => ({
      ...d,
      telemetry: {
        ...d.telemetry,
        enabled: next,
        consentShownAt: d.telemetry.consentShownAt || Date.now()
      }
    }))
    await window.api.setTelemetryEnabled(next).catch(() => undefined)
  }

  const reset = async (): Promise<void> => {
    const next = await window.api.resetTelemetryAnonId().catch(() => '')
    if (next) setAnonId(next)
  }

  const preview = async (): Promise<void> => {
    setShowPreview(true)
    setPayloadJson('loading…')
    try {
      const p = await window.api.previewTelemetryPayload()
      setPayloadJson(p ? JSON.stringify(p, null, 2) : '(empty payload)')
    } catch (e) {
      setPayloadJson(`error: ${(e as Error).message ?? String(e)}`)
    }
  }

  return (
    <section className="settings-section privacy-section">
      <h3>Privacy</h3>

      <label className="settings-row">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <span className="settings-label">Share anonymous usage stats</span>
      </label>
      <p className="settings-hint">
        Sends a once-a-day summary so we know which features people use. No prompts, no project
        names, no file paths, no IP. See exactly what's sent below.
      </p>

      <div className="privacy-actions">
        <button type="button" className="settings-test-btn" onClick={preview}>
          See exactly what's sent →
        </button>
        <button type="button" className="settings-test-btn" onClick={reset}>
          Reset anonymous ID
        </button>
      </div>

      <div className="privacy-anonid">
        <span className="settings-label">Anonymous ID</span>
        <code>{anonId || '—'}</code>
      </div>

      {showPreview && (
        <div
          className="dialog-backdrop payload-preview-backdrop"
          onClick={() => setShowPreview(false)}
        >
          <div
            className="dialog payload-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Today's payload (preview)</h3>
            <p className="settings-hint">
              This is the exact JSON that would be POSTed to <code>api.pikud.io/v1/heartbeat</code>{' '}
              at the end of the day — minus the {' '}
              <code>day</code> field which always reflects yesterday in production.
            </p>
            <pre className="payload-preview-json">{payloadJson}</pre>
            <div className="dialog-actions">
              <button onClick={() => setShowPreview(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
