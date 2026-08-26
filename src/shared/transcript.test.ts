import { describe, expect, it } from 'vitest'
import {
  parseLine,
  projectDirName,
  scorePrompts,
  userMessagesFromTail
} from './transcript'

describe('projectDirName', () => {
  it('flattens a plain path', () => {
    expect(projectDirName('/Users/kobisela/KobisWorkspace/beplus')).toBe(
      '-Users-kobisela-KobisWorkspace-beplus'
    )
  })

  it('replaces spaces and punctuation, not just slashes', () => {
    // These three are real sessions whose conversation panel sat empty forever
    // because only '/' was being substituted.
    expect(projectDirName('/Users/kobisela/KobisWorkspace/Geektime APP')).toBe(
      '-Users-kobisela-KobisWorkspace-Geektime-APP'
    )
    expect(projectDirName('/Users/kobisela/KobisWorkspace/!static-websites')).toBe(
      '-Users-kobisela-KobisWorkspace--static-websites'
    )
    expect(projectDirName('/Users/kobisela/wabi app')).toBe('-Users-kobisela-wabi-app')
  })

  it('replaces dots and underscores too', () => {
    expect(projectDirName('/a/b.c/d_e')).toBe('-a-b-c-d-e')
  })

  it('drops a trailing slash before flattening', () => {
    expect(projectDirName('/a/b/')).toBe('-a-b')
    expect(projectDirName('/a/b//')).toBe('-a-b')
  })
})

describe('parseLine', () => {
  it('reads a plain user message', () => {
    const [m] = parseLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-21T09:00:00.000Z',
        message: { content: 'hello' }
      })
    )
    expect(m).toMatchObject({ id: 'u1', role: 'user', text: 'hello' })
    expect(m.ts).toBe(Date.parse('2026-08-21T09:00:00.000Z'))
  })

  it('splits a content array into text, tool_use and tool_result parts', () => {
    const out = parseLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_result', content: [{ type: 'text', text: 'file.txt' }] }
          ]
        }
      })
    )
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool_use', 'tool_result'])
    expect(out[1].toolName).toBe('Bash')
    expect(out[1].text).toContain('command')
    expect(out[2].text).toBe('file.txt')
    expect(new Set(out.map((m) => m.id)).size).toBe(3) // ids must stay unique — they are React keys
  })

  it('skips whitespace-only text', () => {
    expect(parseLine(JSON.stringify({ type: 'user', message: { content: '   ' } }))).toEqual([])
  })

  it('ignores non-conversation records and malformed lines', () => {
    expect(parseLine(JSON.stringify({ type: 'summary' }))).toEqual([])
    expect(parseLine('not json at all')).toEqual([])
    expect(parseLine('')).toEqual([])
  })

  it('caps a huge tool_result instead of shipping it whole to the renderer', () => {
    const [m] = parseLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] }
      })
    )
    expect(m.text.length).toBe(2000)
  })
})

describe('userMessagesFromTail', () => {
  const line = (text: string): string => JSON.stringify({ type: 'user', message: { content: text } })

  it('collects user text only', () => {
    const chunk = [
      line('first'),
      JSON.stringify({ type: 'assistant', message: { content: 'reply' } }),
      line('second')
    ].join('\n')
    expect(userMessagesFromTail(chunk, false)).toEqual(['first', 'second'])
  })

  it('drops the leading fragment when the read started mid-line', () => {
    const chunk = ['ent":"broken', line('intact')].join('\n')
    expect(userMessagesFromTail(chunk, true)).toEqual(['intact'])
  })

  it('survives a corrupt line in the middle', () => {
    expect(userMessagesFromTail([line('a'), '{oops', line('b')].join('\n'), false)).toEqual([
      'a',
      'b'
    ])
  })
})

describe('scorePrompts', () => {
  it('counts how many prompts appear in the transcript', () => {
    const msgs = ['please fix the login bug', 'now deploy it']
    expect(scorePrompts(msgs, ['please fix the login bug'])).toBe(1)
    expect(scorePrompts(msgs, ['please fix the login bug', 'now deploy it'])).toBe(2)
    expect(scorePrompts(msgs, ['something else entirely'])).toBe(0)
  })

  it('matches on a prefix signature so re-wrapping does not break it', () => {
    const long = 'a'.repeat(40) + ' tail that got wrapped differently'
    expect(scorePrompts([long], [long.slice(0, 60)])).toBe(1)
  })

  it('ignores prompts too short to identify a session', () => {
    expect(scorePrompts(['yes'], ['yes'])).toBe(0)
  })

  it('counts each prompt at most once', () => {
    expect(scorePrompts(['dup', 'dup', 'dup'], ['dup!'])).toBeLessThanOrEqual(1)
  })

  it('is zero when either side is empty', () => {
    expect(scorePrompts([], ['anything'])).toBe(0)
    expect(scorePrompts(['anything'], [])).toBe(0)
  })
})
