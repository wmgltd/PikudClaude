/**
 * The single definition of the user-settings shape.
 *
 * This lived in three places at once — src/main/settings.ts, the preload
 * bridge, and the renderer's types.ts — and they drifted: the preload copy was
 * missing `updates`, `telemetry`, `initialCommandsLibrary` and `projectsRoot`,
 * so `window.api.getSettings()` returned something the renderer's own Settings
 * type rejected. That produced 11 of the type errors the project had learned to
 * ignore. All three now import from here.
 */
export type ThemeName = 'default' | 'solarized-dark' | 'dracula' | 'nord' | 'light' | 'custom'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type SoundType = 'chime' | 'beep'
export type UpdateChannel = 'stable' | 'beta'

export interface Settings {
  notifications: {
    soundEnabled: boolean
    soundType: SoundType
    volume: number
    systemNotifications: boolean
    onlyWhenUnfocused: boolean
    quietHoursEnabled: boolean
    quietHoursStart: string
    quietHoursEnd: string
  }
  sessions: {
    defaultInitialCommand: string
    defaultCwd: string
    defaultColor: string
    autoBookmarkOnAwaiting: boolean
    autoBookmarkOnPrompt: boolean
    trackPrompts: boolean
    recentProjectsMax: number
    preferredIDE: 'cursor' | 'vscode' | 'finder'
    initialCommandsLibrary: string[]
    projectsRoot: string
  }
  appearance: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorStyle: CursorStyle
    cursorBlink: boolean
    theme: ThemeName
    customTheme: {
      background: string
      foreground: string
      cursor: string
      selectionBackground: string
    }
  }
  updates: {
    channel: UpdateChannel
    autoCheck: boolean
  }
  ui: {
    welcomeShown: boolean
  }
  telemetry: {
    enabled: boolean
    consentShownAt: number
    lastHeartbeatAt: number
  }
}
