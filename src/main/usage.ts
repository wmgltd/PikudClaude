import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendErrorEntry } from './errorLog'

const execFileAsync = promisify(execFile)

export interface ActiveUsageBlock {
  startTime: string
  endTime: string
  totalTokens: number
  costUSD: number
  msUntilReset: number
  percentUsed: number | null
  costPerHour: number | null
  tokensPerMinute: number | null
  projectedCost: number | null
  projectedTokens: number | null
}

interface CcusageBlock {
  isActive?: boolean
  isGap?: boolean
  startTime?: string
  endTime?: string
  totalTokens?: number
  costUSD?: number
  tokenLimitStatus?: {
    limit?: number
    percentUsed?: number
  }
  burnRate?: {
    costPerHour?: number
    tokensPerMinute?: number
  }
  projection?: {
    totalCost?: number
    totalTokens?: number
  }
}

/**
 * macOS GUI apps launched from Finder/Dock get a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) — they do NOT inherit the user's shell
 * PATH. So a bare `npx` (installed under Homebrew, nvm, fnm, volta, …) is
 * not found, ccusage never runs, and the usage strip silently shows
 * "no active usage". It works under `npm run dev` only because the dev
 * process inherits the terminal's PATH.
 *
 * Fix: once, resolve the real interactive-login-shell PATH and reuse it.
 */
let cachedPath: string | null = null

async function resolveUserPath(): Promise<string> {
  if (cachedPath !== null) return cachedPath

  // Windows GUI apps inherit the user PATH from the registry on launch, so
  // process.env.PATH is already the right thing. Skip the POSIX shell probe
  // entirely — there's no /bin/zsh to query and the fallback list below is
  // all Mac/Linux paths that don't apply.
  if (process.platform === 'win32') {
    cachedPath = process.env.PATH || ''
    return cachedPath
  }

  // In dev the inherited PATH is already rich; don't pay the shell cost.
  if (process.env.PATH && process.env.PATH.split(':').length > 5) {
    cachedPath = process.env.PATH
    return cachedPath
  }

  const fallback = [
    process.env.PATH || '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME || ''}/.nvm/current/bin`,
    `${process.env.HOME || ''}/.volta/bin`,
    `${process.env.HOME || ''}/.local/bin`
  ]
    .filter(Boolean)
    .join(':')

  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -l (login → .zprofile) and -i (interactive → .zshrc, where nvm/fnm
    // usually live). A sentinel brackets the value so shell noise (motd,
    // prompt escapes) can't corrupt the parse.
    const { stdout } = await execFileAsync(shell, ['-lic', 'echo __PK_PATH__$PATH__PK_PATH__'], {
      timeout: 10_000
    })
    const m = /__PK_PATH__(.*?)__PK_PATH__/.exec(stdout)
    cachedPath = m && m[1] ? m[1] : fallback
  } catch {
    cachedPath = fallback
  }
  return cachedPath
}

export async function getActiveBlock(): Promise<ActiveUsageBlock | null> {
  try {
    const PATH = await resolveUserPath()
    const { stdout } = await execFileAsync(
      'npx',
      ['--yes', '--quiet', 'ccusage@latest', 'blocks', '--active', '--token-limit', 'max', '--json'],
      {
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH }
      }
    )
    const data = JSON.parse(stdout) as { blocks?: CcusageBlock[] }
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    const active = blocks.find((b) => b.isActive && !b.isGap)
    if (!active || !active.endTime || !active.startTime) {
      appendErrorEntry({
        source: 'main',
        kind: 'usage:no-active-block',
        message: 'ccusage ran but returned no active block',
        context: { blocksCount: blocks.length }
      })
      return null
    }
    const endMs = Date.parse(active.endTime)
    if (!Number.isFinite(endMs)) return null
    const tokens = active.totalTokens ?? 0
    const limit = active.tokenLimitStatus?.limit ?? 0
    const pct = limit > 0 ? Math.min(100, (tokens / limit) * 100) : null
    return {
      startTime: active.startTime,
      endTime: active.endTime,
      totalTokens: tokens,
      costUSD: active.costUSD ?? 0,
      msUntilReset: Math.max(0, endMs - Date.now()),
      percentUsed: pct,
      costPerHour: active.burnRate?.costPerHour ?? null,
      tokensPerMinute: active.burnRate?.tokensPerMinute ?? null,
      projectedCost: active.projection?.totalCost ?? null,
      projectedTokens: active.projection?.totalTokens ?? null
    }
  } catch (err) {
    // Clear the cached PATH so the next call re-probes. If the shell probe
    // produced a bogus PATH that doesn't contain npx, we'd otherwise be
    // stuck failing forever on this single bad cache entry.
    cachedPath = null
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    appendErrorEntry({
      source: 'main',
      kind: 'usage:ccusage-failed',
      message: e.message || 'unknown',
      stack: e.stack,
      context: {
        code: e.code,
        stderr: typeof e.stderr === 'string' ? e.stderr.slice(0, 500) : undefined,
        stdoutHead: typeof e.stdout === 'string' ? e.stdout.slice(0, 200) : undefined
      }
    })
    return null
  }
}
