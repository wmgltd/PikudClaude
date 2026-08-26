/**
 * Pure inspection of a tmux pane's state. Kept free of node-pty/Electron so it
 * can be unit-tested without an Electron ABI build.
 */

const SHELL_COMMANDS = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'login', 'screen', 'tmux'
])

/**
 * True when the pane is sitting at a plain shell rather than running an app.
 * Claude Code reports its version as the command name (e.g. "2.1.228"), so
 * anything unrecognised counts as an app, not a shell.
 */
export function isShellCommand(cmd: string): boolean {
  if (!cmd) return true
  const trimmed = cmd.trim().replace(/^-/, '')
  return SHELL_COMMANDS.has(trimmed)
}

/**
 * Detect Claude's numbered-choice prompt. It renders the selected option with a
 * pointer glyph and the others plain, so requiring BOTH shapes avoids firing on
 * an ordinary numbered list in output.
 */
export function detectAwaiting(content: string): boolean {
  const lines = content.split('\n').slice(-30)
  let arrowOption = false
  let plainOption = false
  for (const line of lines) {
    if (/^\s*[❯>›]\s*\d+\.\s/.test(line)) arrowOption = true
    else if (/^\s+\d+\.\s/.test(line)) plainOption = true
  }
  return arrowOption && plainOption
}

/**
 * Pick the next `take` items round-robin from `items`, starting at `cursor`.
 * Returns the slice plus the cursor to use next time.
 *
 * Used to bound how many `capture-pane` subprocesses the awaiting poll spawns
 * per tick. The contract that matters: over enough ticks every item must come
 * up, so no background session's status can go stale forever.
 */
export function pickRotation<T>(
  items: T[],
  cursor: number,
  take: number
): { picked: T[]; nextCursor: number } {
  if (items.length === 0 || take <= 0) return { picked: [], nextCursor: 0 }
  const n = Math.min(take, items.length)
  const start = ((cursor % items.length) + items.length) % items.length
  const picked: T[] = []
  for (let i = 0; i < n; i++) picked.push(items[(start + i) % items.length])
  return { picked, nextCursor: (start + n) % items.length }
}
