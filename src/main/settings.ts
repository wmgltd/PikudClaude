import { app } from 'electron'
import { join } from 'node:path'
import { writeAtomic, loadWithFallback } from './atomic'

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

const DEFAULTS: Settings = {
  notifications: {
    soundEnabled: true,
    soundType: 'chime',
    volume: 0.4,
    systemNotifications: true,
    onlyWhenUnfocused: false,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00'
  },
  sessions: {
    defaultInitialCommand: 'claude',
    defaultCwd: '',
    defaultColor: '#7c3aed',
    autoBookmarkOnAwaiting: false,
    autoBookmarkOnPrompt: false,
    trackPrompts: true,
    recentProjectsMax: 6,
    preferredIDE: 'cursor',
    initialCommandsLibrary: ['claude', 'claude --resume', 'claude --continue'],
    projectsRoot: ''
  },
  appearance: {
    fontSize: 13,
    fontFamily: 'Menlo, "SF Mono", Monaco, "Courier New", "Arial Hebrew", "Lucida Sans Unicode", monospace',
    lineHeight: 1.15,
    cursorStyle: 'block',
    cursorBlink: true,
    theme: 'default',
    customTheme: {
      background: '#000000',
      foreground: '#e4e4ec',
      cursor: '#7c3aed',
      selectionBackground: '#7c3aed55'
    }
  },
  updates: {
    channel: 'stable',
    autoCheck: true
  },
  ui: {
    welcomeShown: false
  }
}

const FILE = (): string => join(app.getPath('userData'), 'settings.json')

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!override || typeof override !== 'object') return base
  const out = { ...base } as Record<string, unknown>
  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overrideVal = (override as Record<string, unknown>)[key]
    if (
      baseVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      overrideVal &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal)
    ) {
      out[key] = deepMerge(baseVal, overrideVal as Partial<typeof baseVal>)
    } else if (overrideVal !== undefined) {
      out[key] = overrideVal
    }
  }
  return out as T
}

export class SettingsStore {
  private settings: Settings

  constructor() {
    this.settings = this.load()
  }

  private load(): Settings {
    const parsed = loadWithFallback<Partial<Settings>>(FILE(), (raw) => {
      const out = JSON.parse(raw)
      return out && typeof out === 'object' && !Array.isArray(out) ? (out as Partial<Settings>) : null
    })
    return parsed ? deepMerge(clone(DEFAULTS), parsed) : clone(DEFAULTS)
  }

  get(): Settings {
    return this.settings
  }

  save(next: Partial<Settings>): Settings {
    this.settings = deepMerge(this.settings, next)
    writeAtomic(FILE(), JSON.stringify(this.settings, null, 2))
    return this.settings
  }
}
