export interface SessionMeta {
  id: string
  name: string
  cwd: string
  color: string
  createdAt: number
  tmuxName: string
  imported?: boolean
}

export interface ExternalTmuxSession {
  name: string
  windows: number
  attached: boolean
  createdAt: number
}

export type SessionStatus = 'working' | 'idle' | 'awaiting' | 'detached' | 'shell'

export interface Bookmark {
  id: string
  sessionId: string
  label: string
  createdAt: number
  snapshot: string
}

export interface ProjectInfo {
  name: string
  path: string
  kind: string
}

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
}

export interface ThemeColors {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

export const THEME_PRESETS: Record<Exclude<ThemeName, 'custom'>, ThemeColors> = {
  default: {
    background: '#000000',
    foreground: '#e4e4ec',
    cursor: '#7c3aed',
    selectionBackground: '#7c3aed55'
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    selectionBackground: '#073642'
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#bd93f9',
    selectionBackground: '#44475a'
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    selectionBackground: '#4c566a'
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2937',
    cursor: '#7c3aed',
    selectionBackground: '#dbeafe'
  }
}

export function resolveTheme(s: Settings['appearance']): ThemeColors {
  if (s.theme === 'custom') return s.customTheme
  return THEME_PRESETS[s.theme]
}
