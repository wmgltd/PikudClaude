import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Editors, formatters and AI tools often NFC-normalize text they write. A
// source file that changes under NFC holds a character that can be silently
// rewritten — exactly how a literal U+FB1D inside a regex range became
// U+05D9 U+05B4 and turned the Hebrew test into "any symbol" (bidi.ts).
// Write such characters as \u escapes instead.

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p)
  }
  return out
}

describe('source files are stable under Unicode normalization', () => {
  it.each(sourceFiles(SRC).map((p) => relative(SRC, p)))('%s', (rel) => {
    const text = readFileSync(join(SRC, rel), 'utf8')
    const nfc = text.normalize('NFC')
    if (text === nfc) return
    const i = [...text].findIndex((c, k) => c !== [...nfc][k])
    const cp = [...text][i]?.codePointAt(0)?.toString(16).toUpperCase()
    expect.fail(`${rel} changes under NFC near U+${cp}; write it as a \\u escape`)
  })
})
