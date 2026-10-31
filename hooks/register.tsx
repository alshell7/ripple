import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Change, Finding, FindingStatus, Ledger, LedgerEntry, Lens, Mode, Review } from '../types'
import { fromCommand, fromEdit, fromNotebook, fromUnifiedDiff, fromWrite, relativeTo } from './changes'
import { paneTree, severityCounts } from './pane'
import { buildBrief, digPrompt, fixPrompt, LENS_ICON, parseVerdict, SEVERITY_ICON, where } from './review'
import { shouldReview } from './signals'
import type { Sensitivity } from './signals'

type Engine = EngineInterface
type ForkResult = Awaited<ReturnType<Engine['model']['fork']>>

const PANE = 'ripple'
const TITLE = '🌊 Ripple'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_LEDGER: Ledger = { version: 1, profile: '', entries: [] }
const MODES: readonly Mode[] = ['smart', 'always', 'manual']

const pending = atom({ plugin: 'ripple', key: 'pending' } as const, [])
const review = atom({ plugin: 'ripple', key: 'review' } as const, null)
const expanded = atom({ plugin: 'ripple', key: 'expanded' } as const, [])
const lensFilter = atom({ plugin: 'ripple', key: 'lens' } as const, 'all')
const isBandHidden = atom({ plugin: 'ripple', key: 'isBandHidden' } as const, false)
const isLedgerOpen = atom({ plugin: 'ripple', key: 'isLedgerOpen' } as const, false)
const ledger = atom({ plugin: 'ripple', key: 'ledger' } as const, EMPTY_LEDGER)
const mode = atom({ plugin: 'ripple', key: 'mode' } as const, 'smart')

const MODE_NOTE: Record<Mode, string> = {
  smart: 'I review after a turn whose changes look risky or sizeable, and stay quiet (no model call) on small safe ones.',
  always: 'I review after every turn that changed something.',
  manual: 'I only note changes; run /ripple check when you want a review.',
}

const HELP = [
  '🌊 Ripple: what your changes ripple into',
  '',
  '/ripple              open the pane',
  '/ripple check        review everything uncommitted (git diff HEAD, plus new files)',
  '/ripple check main   review what this branch changed since it left main',
  '/ripple scale …      tell me your traffic, data and stack for sharper cost estimates',
  '/ripple ledger       what the team already knows about',
  '/ripple mode …       smart (default), always or manual',
  '',
  'In the pane: 👀 Got it records the ripple in the ledger so it is not raised again;',
  '🛠 Fix it asks Claude to fix it; 🔍 Dig deeper asks Claude to trace callers, services and cost',
  'without changing code; 🙅 Not an issue silences it for good.',
].join('\n')

type Settings = {
  mode: Mode
  sensitivity: Sensitivity
  reviewer: 'session' | 'lean'
  reviewModel: string
  ledgerPath: string
  autoOpen: boolean
}

function pick<T extends string>(value: unknown, all: readonly T[], fallback: T): T {
  return typeof value === 'string' && (all as readonly string[]).includes(value) ? (value as T) : fallback
}

function settingsOf(options: PluginOptions): Settings {
  return {
    mode: pick(options.mode, MODES, 'smart'),
    sensitivity: pick(options.sensitivity, ['relaxed', 'balanced', 'eager'] as const, 'balanced'),
    reviewer: pick(options.reviewer, ['session', 'lean'] as const, 'lean'),
    reviewModel: typeof options.reviewModel === 'string' && options.reviewModel.trim() !== '' ? options.reviewModel.trim() : 'sonnet',
    ledgerPath: typeof options.ledgerPath === 'string' ? options.ledgerPath.trim() : '.ripple/ledger.json',
    autoOpen: options.autoOpen !== false,
  }
}

// The module's own memory: it starts over on a reload, which is fine for all of it.
let cfg: Settings = settingsOf({})
let isRunning = false
let isAgainWanted = false
let isLedgerBroken = false
let lastBatch: { changes: Change[]; source: Review['source'] } | undefined
let lastAnswer = ''

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function isIgnored(file: string): boolean {
  return (
    // Still absolute once made relative to the project: a file outside it, not this project's change.
    /^(\/|[A-Za-z]:[\\/])/.test(file) ||
    /(^|\/)(\.ripple|node_modules|\.git|dist|build|\.next|vendor)\//.test(file) ||
    /\.(lock|min\.js|map|snap)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/.test(file)
  )
}

async function readText($: Engine, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

function normalizeLedger(raw: unknown): Ledger {
  if (typeof raw !== 'object' || raw === null) return EMPTY_LEDGER
  const o = raw as Record<string, unknown>
  const entries = (Array.isArray(o.entries) ? o.entries : []).filter(
    (x): x is LedgerEntry =>
      typeof x === 'object' && x !== null && typeof (x as LedgerEntry).fingerprint === 'string' && typeof (x as LedgerEntry).title === 'string',
  )
  return { version: 1, profile: typeof o.profile === 'string' ? o.profile : '', entries }
}

// ── the awareness ledger: a file in the repo the team shares, or this user's store ──

async function ledgerFile($: Engine): Promise<string | undefined> {
  if (cfg.ledgerPath === '') return undefined
  if (cfg.ledgerPath.startsWith('/')) return cfg.ledgerPath
  return `${(await $.session.root()).replace(/\/$/, '')}/${cfg.ledgerPath}`
}

async function loadLedger($: Engine): Promise<Ledger> {
  const path = await ledgerFile($)
  if (path !== undefined) {
    const text = await readText($, path)
    if (text !== undefined) {
      try {
        const book = normalizeLedger(JSON.parse(text))
        isLedgerBroken = false
        return book
      } catch {
        // A merge conflict or a hand edit gone wrong: read nothing from it, and never overwrite it.
        isLedgerBroken = true
        return await read($, ledger)
      }
    }
  }
  return normalizeLedger(await $.store.get(`ledger:${await $.session.root()}`))
}

async function saveLedger($: Engine, book: Ledger): Promise<void> {
  await update($, ledger, () => book)
  const path = await ledgerFile($)
  if (path === undefined) {
    await $.store.set(`ledger:${await $.session.root()}`, book)
  } else if (isLedgerBroken) {
    $.ui.toast(`🌊 ${cfg.ledgerPath} isn't valid JSON, so I kept that in memory only. Fix the file and it saves next time.`)
  } else {
    await $.fs.write(path, `${JSON.stringify(book, null, 2)}\n`)
  }
}

// ── noting changes as they happen ──

async function addChange($: Engine, change: Change): Promise<void> {
  const list = await update($, pending, all => [...all, change].slice(-200))
  const files = new Set(list.map(c => c.file)).size
  const hints = list.reduce((t, c) => t + c.signals.length, 0)
  $.ui.status(`🌊 noting · ${plural(files, 'file')}${hints > 0 ? ` · ${plural(hints, 'hint')}` : ''}`)
}

async function refreshStatus($: Engine): Promise<void> {
  const r = await read($, review)
  const open = r?.findings.filter(f => f.status === 'new').length ?? 0
  $.ui.status(open > 0 ? `🌊 ${plural(open, 'ripple')} · /ripple` : '🌊 calm')
}

// ── reviewing ──

/** The developer's latest ask, for the lean reviewer's sense of intent. */
async function lastAsk($: Engine): Promise<string> {
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m?.role === 'user' && m.text.trim() !== '' && (m.toolResults?.length ?? 0) === 0) return m.text
    }
  } catch {
    // No transcript to read: the diff speaks alone.
  }
  return ''
}

async function afterTurn($: Engine): Promise<void> {
  const list = await read($, pending)
  if (list.length === 0) return
  const current = await read($, mode)
  if (current === 'manual') {
    $.ui.status(`🌊 ${plural(list.length, 'change')} unreviewed · /ripple check`)
    return
  }
  const decision = current === 'always' ? { review: true, why: 'every change' } : shouldReview(list, cfg.sensitivity)
  if (decision.review) {
    await startReview($, 'turn')
    return
  }
  // Small and safe-looking: say so without spending a token.
  await update($, pending, () => [])
  const prev = await read($, review)
  const quiet: Review = {
    phase: 'done',
    source: 'turn',
    at: await $.clock.now(),
    files: [...new Set(list.map(c => c.file))],
    lines: list.reduce((t, c) => t + c.added, 0),
    verdict: 'quiet',
    headline: `Calm waters: ${decision.why}.`,
    findings: (prev?.findings ?? []).filter(f => f.status === 'new'),
    signals: list.flatMap(c => c.signals).slice(0, 20),
    reviewer: 'local scanner, no model call',
  }
  await update($, review, () => quiet)
  await refreshStatus($)
}

async function startReview($: Engine, source: Review['source'], given?: Change[]): Promise<void> {
  if (isRunning) {
    if (source === 'turn') isAgainWanted = true
    else $.ui.toast('🌊 A review is already running; try again when it lands.')
    return
  }
  isRunning = true
  try {
    let batch = given
    if (batch === undefined) {
      batch = await read($, pending)
      await update($, pending, () => [])
    }
    if (batch.length === 0) return
    lastBatch = { changes: batch, source }
    await runReview($, batch, source)
  } catch (error) {
    await fail($, `something broke: ${String(error)}`)
  } finally {
    isRunning = false
    if (isAgainWanted) {
      isAgainWanted = false
      void afterTurn($)
    }
  }
}

async function runReview($: Engine, batch: Change[], source: Review['source']): Promise<void> {
  const files = [...new Set(batch.map(c => c.file))]
  const lines = batch.reduce((t, c) => t + c.added, 0)
  const signals = batch.flatMap(c => c.signals)
  const prev = await read($, review)
  const carried = (prev?.findings ?? []).filter(f => f.status === 'new')
  const base = { source, at: await $.clock.now(), files, lines, signals: signals.slice(0, 20) }
  const running: Review = {
    ...base,
    phase: 'running',
    verdict: 'quiet',
    headline: `Reading the ripples of ${plural(files.length, 'file')}…`,
    findings: carried,
    reviewer: '',
  }
  await update($, review, () => running)
  $.ui.status(`🌊💭 reviewing ${plural(files.length, 'file')}…`)

  const book = await loadLedger($)
  await update($, ledger, () => book)
  const intent = source === 'turn' ? { ask: await lastAsk($), answer: lastAnswer } : { ask: '', answer: '' }
  const brief = { changes: batch, signals, profile: book.profile, known: book.entries, intent }

  let reviewer = 'this session (fork)'
  let result: ForkResult | undefined
  if (source === 'turn' && cfg.reviewer === 'session') {
    const { fixed, variable } = buildBrief({ ...brief, inConversation: true, diffBudget: 6000 })
    result = await $.model.fork({ prompt: `${fixed}\n\n${variable}` })
  }
  if (result === undefined || (!result.isAnswered && result.reason === 'nothing-to-fork')) {
    // The fixed brief leads and is marked, so back-to-back reviews read it from the prompt cache.
    const { fixed, variable } = buildBrief({ ...brief, inConversation: false, diffBudget: source === 'check' ? 48000 : 24000 })
    reviewer = cfg.reviewModel
    result = await $.model.complete({
      model: cfg.reviewModel,
      prompt: [{ text: fixed, cache: true }, { text: variable }],
      maxTokens: 3000,
      effort: source === 'check' ? 'medium' : 'low',
      timeoutMs: 180000,
    })
  }
  const usage = result.usage && {
    input: (result.usage.input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0),
    output: result.usage.output_tokens ?? 0,
    cached: result.usage.cache_read_input_tokens ?? 0,
  }
  if (!result.isAnswered) {
    const why =
      result.reason === 'api-error' ? `the API answered ${result.status}` : result.reason === 'aborted' ? 'it was cut short' : 'the reply was empty'
    await fail($, `I couldn't finish the review: ${why}.`)
    return
  }
  const verdict = parseVerdict(result.text, book.entries)
  if (verdict === undefined) {
    await fail($, "the reviewer's answer wasn't readable.")
    return
  }
  const fresh = verdict.findings
  const prints = new Set(fresh.map(f => f.fingerprint))
  const done: Review = {
    ...base,
    phase: 'done',
    verdict: verdict.verdict,
    headline: verdict.headline,
    findings: [...fresh, ...carried.filter(c => !prints.has(c.fingerprint))].slice(0, 12),
    reviewer,
    ...(usage === undefined ? {} : { usage }),
  }
  await update($, review, () => done)
  await announce($, fresh)
}

async function fail($: Engine, note: string): Promise<void> {
  await update($, review, (r): Review | null =>
    r === null ? r : { ...r, phase: 'failed', headline: 'The review did not land.', note },
  )
  $.ui.status('🌊 review failed · /ripple')
}

async function announce($: Engine, fresh: Finding[]): Promise<void> {
  await refreshStatus($)
  const first = fresh[0]
  if (first === undefined) return
  await update($, expanded, () => [first.id])
  await update($, lensFilter, () => 'all')
  await update($, isBandHidden, () => false)
  const acts = fresh.filter(f => f.severity === 'act').length
  $.ui.toast(`🌊 ${plural(fresh.length, 'ripple')}${acts > 0 ? ` (${acts} to act on)` : ''} from that change: ${first.title}`, {
    timeoutMs: 8000,
  })
  if (cfg.autoOpen) {
    const opened = await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    if (opened?.isPlaced === true) await update($, isBandHidden, () => true)
  }
}

// ── what a press does ──

async function setStatus($: Engine, id: string, status: FindingStatus): Promise<void> {
  await update($, review, r => (r === null ? r : { ...r, findings: r.findings.map(f => (f.id === id ? { ...f, status } : f)) }))
}

async function decide($: Engine, f: Finding, decision: LedgerEntry['decision']): Promise<void> {
  await setStatus($, f.id, decision)
  const book = await loadLedger($)
  const entry: LedgerEntry = {
    fingerprint: f.fingerprint,
    title: f.title,
    lenses: f.lenses,
    severity: f.severity,
    file: where(f),
    decision,
    at: new Date(await $.clock.now()).toISOString(),
  }
  await saveLedger($, { ...book, entries: [...book.entries.filter(x => x.fingerprint !== f.fingerprint), entry] })
  await refreshStatus($)
}

async function forget($: Engine, fingerprint: string): Promise<void> {
  const book = await loadLedger($)
  await saveLedger($, { ...book, entries: book.entries.filter(x => x.fingerprint !== fingerprint) })
}

async function handOff($: Engine, f: Finding, kind: 'fix' | 'dig'): Promise<void> {
  await setStatus($, f.id, kind === 'fix' ? 'fixing' : 'digging')
  await refreshStatus($)
  await $.prompt.submit({ text: kind === 'fix' ? fixPrompt(f) : digPrompt(f) })
}

async function setProfile($: Engine, text: string): Promise<void> {
  const book = await loadLedger($)
  await saveLedger($, { ...book, profile: text.trim().slice(0, 600) })
  $.ui.toast(text.trim() === '' ? '📏 Scale profile cleared.' : '📏 Got it. Estimates will use that scale.')
}

async function retry($: Engine): Promise<void> {
  if (lastBatch !== undefined) await startReview($, lastBatch.source, lastBatch.changes)
}

async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined)
  await update($, isBandHidden, () => true)
}

// ── /ripple check: the git diff, for changes made outside Claude ──

async function git($: Engine, root: string, args: string[]) {
  return $.process.run(['git', ...args], { cwd: root, timeoutMs: 30000 })
}

async function check($: Engine, ref: string): Promise<string> {
  if (ref !== '' && (!/^[A-Za-z0-9._/~^@{}:-]+$/.test(ref) || ref.startsWith('-'))) {
    return `🌊 "${ref}" doesn't look like a git ref.`
  }
  const root = await $.session.root()
  const inside = await git($, root, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined)
  if (inside === undefined || inside.exitCode !== 0) {
    return "🌊 This folder isn't a git repository, so there's no diff to check. I still review the edits Claude makes here."
  }
  let base = 'HEAD'
  if (ref !== '') {
    const merged = await git($, root, ['merge-base', ref, 'HEAD'])
    if (merged.exitCode !== 0) return `🌊 I can't find "${ref}" in this repository.`
    base = merged.stdout.trim()
  } else if ((await git($, root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).exitCode !== 0) {
    base = EMPTY_TREE
  }
  const diff = await git($, root, ['diff', '--no-color', '--no-ext-diff', '-U3', base, '--'])
  const changes = fromUnifiedDiff(diff.stdout).filter(c => !isIgnored(c.file))
  const untracked = await git($, root, ['ls-files', '--others', '--exclude-standard'])
  for (const file of untracked.stdout.split('\n').filter(f => f !== '' && !isIgnored(f)).slice(0, 25)) {
    const text = await readText($, `${root.replace(/\/$/, '')}/${file}`)
    if (text === undefined || text.length > 200_000 || text.includes('\u0000')) continue
    changes.push(fromWrite(file, text))
  }
  const against = ref === '' ? 'your last commit' : ref
  if (changes.length === 0) return `🌊 Nothing changed against ${against}. Calm waters.`
  const added = changes.reduce((t, c) => t + c.added, 0)
  const removed = changes.reduce((t, c) => t + c.removed, 0)
  void startReview($, 'check', changes)
  await openPane($)
  return `🌊 Checking ${plural(changes.length, 'file')} (+${added} −${removed}) against ${against}… the verdict lands in the Ripple pane.`
}

function ledgerText(book: Ledger): string {
  const kept = cfg.ledgerPath === '' ? 'kept privately for you' : `kept in ${cfg.ledgerPath}`
  if (book.entries.length === 0) {
    return `📒 The ledger is empty (${kept}). Press 👀 Got it on a ripple and it lands here, so it isn't raised again.${book.profile ? `\n📏 Scale: ${book.profile}` : ''}`
  }
  const rows = book.entries
    .slice()
    .reverse()
    .map(x => `- ${x.decision === 'aware' ? '👀' : '🙅'} ${SEVERITY_ICON[x.severity]} ${x.title} · ${x.lenses.map(l => LENS_ICON[l]).join('')} ${x.file} · ${x.at.slice(0, 10)}`)
  return [`📒 What the team already knows (${kept}):`, ...rows, book.profile ? `\n📏 Scale: ${book.profile}` : ''].join('\n')
}

async function runCommand($: Engine, args: string): Promise<string> {
  const sub = (args.split(/\s+/)[0] ?? '').toLowerCase()
  const rest = args.slice(sub.length).trim()
  switch (sub) {
    case '':
    case 'open':
    case 'show':
      await openPane($)
      return '🌊 Ripple pane open.'
    case 'check':
      return check($, rest)
    case 'scale':
    case 'profile': {
      if (rest !== '') {
        await setProfile($, rest)
        return `📏 Got it. I'll size estimates for: ${rest}`
      }
      const book = await loadLedger($)
      return book.profile
        ? `📏 Scale profile: ${book.profile}`
        : '📏 No scale profile yet. Try: /ripple scale 50 msg/s peak, 2M contacts, AWS ECS + RDS Postgres + SQS, LLM replies on 10% of messages'
    }
    case 'ledger':
      return ledgerText(await loadLedger($))
    case 'mode': {
      const wanted = rest.toLowerCase()
      if (!(MODES as readonly string[]).includes(wanted)) {
        const current = await read($, mode)
        return `🌊 Mode: ${current}. ${MODE_NOTE[current]}\nChange it with /ripple mode smart | always | manual.`
      }
      const chosen = wanted as Mode
      await update($, mode, () => chosen)
      await $.store.set('mode', chosen)
      return `🌊 Mode: ${chosen}. ${MODE_NOTE[chosen]}`
    }
    case 'help':
      return HELP
    default:
      return `🌊 I don't know "${sub}".\n\n${HELP}`
  }
}

// ── events ──

export const register: Register = (on, options) => {
  cfg = settingsOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'ripple',
      description: 'Ripple 🌊: what your changes ripple into (stack, security, reliability, scale, cost)',
      argumentHint: '[check [ref] | scale <text> | ledger | mode <smart|always|manual> | help]',
    })
    const stored = await $.store.get('mode')
    await update($, mode, () => pick(stored, MODES, cfg.mode))
    const book = await loadLedger($)
    await update($, ledger, () => book)
    $.ui.status('🌊 watching')
    return started
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const previous = e.tool === 'Write' ? await readText($, e.file_path) : undefined
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const root = await $.session.root()
      if (e.tool === 'Edit') {
        const file = relativeTo(root, e.file_path)
        if (!isIgnored(file)) await addChange($, fromEdit(file, e.old_string, e.new_string, await readText($, e.file_path)))
      } else if (e.tool === 'Write') {
        const file = relativeTo(root, e.file_path)
        if (!isIgnored(file)) await addChange($, fromWrite(file, e.content, previous))
      } else if (e.tool === 'NotebookEdit' && e.edit_mode !== 'delete') {
        const file = relativeTo(root, e.notebook_path)
        if (!isIgnored(file)) await addChange($, fromNotebook(file, e.new_source))
      }
    } catch (error) {
      $.ui.log(`ripple: could not note a change: ${String(error)}`, { to: 'debug' })
    }
    return ran
    // Ripple only watches: if it ever fails, the call goes on (or its settled result is replayed), never run twice.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const change = fromCommand(e.command)
      if (change !== undefined) await addChange($, change).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined && !e.isAborted) {
      lastAnswer = e.answer
      void afterTurn($).catch(error => $.ui.log(`ripple: review skipped: ${String(error)}`, { to: 'debug' }))
    }
    return ended
  })

  on('command.run', { command: 'ripple' }, async ($, e) => ({ text: await runCommand($, e.args.trim()) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const r = await read($, review)
    const isHidden = await read($, isBandHidden)
    const fresh = r?.findings.filter(f => f.status === 'new') ?? []
    if (r === null || isHidden || r.phase !== 'done' || fresh.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text>
          🌊 <Text bold>{plural(fresh.length, 'ripple')}</Text> from your last change {severityCounts(fresh)}
        </Text>
        <Button key="show" label="Show me" variant="primary" onPress={() => void openPane($)} />
        <Button key="later" label="Later" onPress={() => void update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const model = {
      review: await read($, review),
      expanded: await read($, expanded),
      lens: await read($, lensFilter),
      book: await read($, ledger),
      mode: await read($, mode),
      queued: (await read($, pending)).length,
      isLedgerShown: await read($, isLedgerOpen),
      columns: e.props.bodyColumns,
      hasSvg: e.surface !== 'terminal',
    }
    return paneTree(ui, model, {
      toggle: id => void update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])),
      decide: (f, decision) => void decide($, f, decision),
      handOff: (f, kind) => void handOff($, f, kind),
      setLens: (l: Lens | 'all') => void update($, lensFilter, () => l),
      reviewNow: () => void startReview($, 'turn'),
      retry: () => void retry($),
      toggleLedger: () => void update($, isLedgerOpen, v => !v),
      forget: fingerprint => void forget($, fingerprint),
      setProfile: text => void setProfile($, text),
    })
  })
}
