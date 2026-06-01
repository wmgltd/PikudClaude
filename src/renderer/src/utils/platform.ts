export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform)

// On Mac, app shortcuts use ⌘; on Windows/Linux, Ctrl. Plus dashboard
// specifically needs Ctrl+Shift+D on Windows because plain Ctrl+D is EOF.
export function shortcutLabel(macCombo: string): string {
  if (IS_MAC) return macCombo
  // Replace ⌘ with Ctrl+. Special-case ⌘D → Ctrl+Shift+D (EOF conflict).
  if (macCombo === '⌘D') return 'Ctrl+Shift+D'
  return macCombo.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+')
}
