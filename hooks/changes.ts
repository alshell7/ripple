// Turning edits, writes, commands and git diffs into Changes the reviewer reads.

import type { Change } from '../types'
import { commandSignals, freshLines, isDocOrTest, pathSignals, textSignals } from './signals'

const PER_CHANGE_DIFF = 3500

let counter = 0
function nextId(): string {
  counter += 1
  return `c${Date.now().toString(36)}${counter}`
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}

function prefixed(text: string, mark: string, max: number): string {
  return clip(text.split('\n').map(l => `${mark}${l}`).join('\n'), max)
}

/** An Edit: `before` and `after` are its old and new strings; `fileText` the file once edited, when read. */
export function fromEdit(file: string, before: string, after: string, fileText?: string): Change {
  const fresh = freshLines(before, after)
  let firstLine: number | undefined
  let context = ''
  if (fileText !== undefined && after !== '') {
    const at = fileText.indexOf(after)
    if (at >= 0) {
      firstLine = fileText.slice(0, at).split('\n').length
      context = fileText.split('\n').slice(Math.max(0, firstLine - 26), firstLine - 1).join('\n')
    }
  }
  const signals = [...pathSignals(file), ...textSignals(file, after, { context, firstLine, fresh })]
  const where = firstLine === undefined ? '' : ` near line ${firstLine}`
  const gone = freshLines(after, before)
  const removedText = before.split('\n').filter((_, i) => gone.has(i))
  return {
    id: nextId(),
    tool: 'Edit',
    file,
    added: fresh.size,
    removed: gone.size,
    diff: clip(
      [`--- ${file} (edit${where})`, ...removedText.map(l => `- ${l}`), compact(after, fresh)].join('\n'),
      PER_CHANGE_DIFF,
    ),
    signals,
    isDocOrTest: isDocOrTest(file),
  }
}

/** The new text with added lines marked "+", keeping two unchanged lines around them and folding the rest. */
function compact(text: string, fresh: ReadonlySet<number>): string {
  const lines = text.split('\n')
  const near = (i: number) => [-2, -1, 0, 1, 2].some(d => fresh.has(i + d))
  const out: string[] = []
  lines.forEach((line, i) => {
    if (fresh.has(i)) out.push(`+ ${line}`)
    else if (near(i)) out.push(`  ${line}`)
    else if (out.at(-1) !== '  …') out.push('  …')
  })
  return out.join('\n')
}

/** A Write: `previous` is the file's text before it, undefined for a new file. */
export function fromWrite(file: string, content: string, previous?: string): Change {
  const fresh = previous === undefined ? undefined : freshLines(previous, content)
  const signals = [...pathSignals(file), ...textSignals(file, content, { firstLine: 1, fresh })]
  const lines = content.split('\n')
  const body = fresh === undefined ? prefixed(content, '+ ', PER_CHANGE_DIFF) : clip(compact(content, fresh), PER_CHANGE_DIFF)
  const removed = previous === undefined ? 0 : freshLines(content, previous).size
  const kind = previous === undefined ? `new file, ${lines.length} lines` : `rewritten, +${fresh?.size ?? 0} -${removed}`
  return {
    id: nextId(),
    tool: 'Write',
    file,
    added: fresh === undefined ? countLines(content) : fresh.size,
    removed,
    diff: `+++ ${file} (${kind})\n${body}`,
    signals,
    isDocOrTest: isDocOrTest(file),
  }
}

export function fromNotebook(file: string, source: string): Change {
  return {
    id: nextId(),
    tool: 'NotebookEdit',
    file,
    added: countLines(source),
    removed: 0,
    diff: `+++ ${file} (notebook cell)\n${prefixed(source, '+ ', PER_CHANGE_DIFF)}`,
    signals: textSignals(file, source),
    isDocOrTest: isDocOrTest(file),
  }
}

/** A shell command, kept only when it looks like it moved the stack or the infrastructure. */
export function fromCommand(command: string): Change | undefined {
  const signals = commandSignals(command)
  if (signals.length === 0) return undefined
  return {
    id: nextId(),
    tool: 'Bash',
    file: '(shell)',
    added: 0,
    removed: 0,
    diff: `$ ${clip(command, 600)}`,
    signals,
    isDocOrTest: false,
  }
}

/** A unified diff (`git diff`), one Change per file, signals only on added lines. */
export function fromUnifiedDiff(diff: string): Change[] {
  const changes: Change[] = []
  const files = diff.split(/^diff --git /m).slice(1)
  for (const chunk of files) {
    const header = /^a\/(.+?) b\/(.+)$/m.exec(chunk)
    const file = header?.[2]?.trim() ?? '(unknown)'
    if (/^Binary files /m.test(chunk)) continue
    const signals = [...pathSignals(file)]
    let added = 0
    let removed = 0
    const hunks = chunk.split(/^(?=@@ )/m).slice(1)
    for (const hunk of hunks) {
      const start = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk)?.[1] ?? '1')
      const body = hunk.split('\n').slice(1)
      const newSide: string[] = []
      const fresh = new Set<number>()
      for (const line of body) {
        if (line.startsWith('+')) {
          fresh.add(newSide.length)
          newSide.push(line.slice(1))
          added += 1
        } else if (line.startsWith('-')) {
          removed += 1
        } else if (line.startsWith(' ')) {
          newSide.push(line.slice(1))
        }
      }
      if (fresh.size > 0) signals.push(...textSignals(file, newSide.join('\n'), { firstLine: start, fresh }))
    }
    changes.push({
      id: nextId(),
      tool: 'git',
      file,
      added,
      removed,
      diff: clip(`diff --git ${chunk}`, PER_CHANGE_DIFF * 2),
      signals: dedupe(signals),
      isDocOrTest: isDocOrTest(file),
    })
  }
  return changes
}

function dedupe<T extends { rule: string; file: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter(s => {
    const key = `${s.rule}|${s.file}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function relativeTo(root: string, file: string): string {
  const norm = file.replaceAll('\\', '/')
  const base = root.replaceAll('\\', '/').replace(/\/$/, '')
  return norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm
}
