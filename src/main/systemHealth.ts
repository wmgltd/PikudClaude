import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { totalmem } from 'node:os'

const execFileAsync = promisify(execFile)

export interface MemoryPressure {
  /** Swap currently in use, in MB. 0 when the platform reports none. */
  swapUsedMB: number
  /** Total swap the OS has provisioned, in MB. */
  swapTotalMB: number
  /** Physical RAM, in MB. */
  ramTotalMB: number
  /**
   * True when the machine is thrashing hard enough that ANY app — including
   * this one — will stall for seconds at a time. At that point a frozen UI is
   * a symptom of the system, not of PikudClaude, and the stall banner says so.
   */
  critical: boolean
}

// Swap is the honest signal on macOS. `os.freemem()` looks alarming on a
// healthy Mac (the OS deliberately keeps free pages near zero and uses the rest
// for cache), so a low-free-RAM threshold would cry wolf constantly. Sustained
// swap use is what actually correlates with the machine grinding.
const CRITICAL_SWAP_RATIO = 0.75

// Sampling costs one tiny subprocess. Keep it rare — the whole point of this
// module is to not add load to a machine that is already struggling.
const SAMPLE_INTERVAL_MS = 30_000

let last: MemoryPressure | null = null
let timer: NodeJS.Timeout | null = null

function parseSwapMB(raw: string): { usedMB: number; totalMB: number } | null {
  // `sysctl -n vm.swapusage` →
  //   "total = 28672.00M  used = 26883.44M  free = 1788.56M  (encrypted)"
  const grab = (key: string): number | null => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)([MGK])`).exec(raw)
    if (!m) return null
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    return m[2] === 'G' ? n * 1024 : m[2] === 'K' ? n / 1024 : n
  }
  const usedMB = grab('used')
  const totalMB = grab('total')
  if (usedMB === null || totalMB === null) return null
  return { usedMB, totalMB }
}

async function sample(): Promise<MemoryPressure | null> {
  // Only macOS exposes vm.swapusage in this form. Elsewhere we simply don't
  // claim to know, and the banner falls back to "no reason given".
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], {
      timeout: 3000
    })
    const swap = parseSwapMB(stdout)
    if (!swap) return null
    return {
      swapUsedMB: Math.round(swap.usedMB),
      swapTotalMB: Math.round(swap.totalMB),
      ramTotalMB: Math.round(totalmem() / 1048576),
      critical: swap.totalMB > 0 && swap.usedMB / swap.totalMB >= CRITICAL_SWAP_RATIO
    }
  } catch {
    return null
  }
}

export function getMemoryPressure(): MemoryPressure | null {
  return last
}

/**
 * Begin sampling. `onChange` fires only when the critical flag flips or the
 * swap figure moves meaningfully, so the renderer isn't woken up for noise.
 */
export function startMemoryPressureSampling(
  onChange: (p: MemoryPressure) => void
): () => void {
  const tick = async (): Promise<void> => {
    const next = await sample()
    if (!next) return
    const prev = last
    last = next
    const swapMoved = !prev || Math.abs(next.swapUsedMB - prev.swapUsedMB) >= 256
    if (!prev || prev.critical !== next.critical || swapMoved) onChange(next)
  }
  void tick()
  timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
