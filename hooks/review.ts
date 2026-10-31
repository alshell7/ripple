// The reviewer's brief and the reading of its answer. Pure: no `$` here.

import type { Change, Chart, Finding, Lens, LedgerEntry, Severity, Signal } from '../types'

const LENSES: readonly Lens[] = ['stack', 'security', 'reliability', 'efficiency', 'scalability', 'cost']
const SEVERITIES: readonly Severity[] = ['act', 'watch', 'fyi']

export const LENS_ICON: Record<Lens, string> = {
  stack: '🧩',
  security: '🔒',
  reliability: '🛟',
  efficiency: '⚡',
  scalability: '📈',
  cost: '💸',
}

export const LENS_NAME: Record<Lens, string> = {
  stack: 'Stack',
  security: 'Security',
  reliability: 'Reliability',
  efficiency: 'Efficiency',
  scalability: 'Scale',
  cost: 'Cost',
}

export const SEVERITY_ICON: Record<Severity, string> = { act: '🔴', watch: '🟠', fyi: '🔵' }

const BRIEF = `You are Ripple 🌊, a calm, sharp reviewer. A developer just finished a code change. Tell them what it ripples into beyond the edited lines: what to be aware of before it ships or grows. No style, naming or generic advice.

Lenses:
- stack: dependency, runtime or vendor changes; API, event, schema or contract changes others rely on; config other services need; migration rollout.
- security: secrets, injection, auth gaps, unsafe deserialization, TLS/CORS loosening, PII in logs, broad IAM or network.
- reliability: missing timeouts, retries without backoff or idempotency, swallowed errors, partial failure, slow work before an acknowledgement, unbounded queues.
- efficiency: N+1 queries, calls in loops, unbounded reads, missing pagination or indexes, blocking I/O on hot paths.
- scalability: per-instance state, hot keys, locks, fan-out; anything that breaks with more instances, tenants or data.
- cost: anything that multiplies a metered resource: DB reads/writes, data scanned, LLM tokens, per-message fees, invocations, queue messages, egress, log ingest, storage, always-on compute, polling.

For cost, efficiency and scalability, find the MULTIPLIER: the unit that drives it, how many units at the SCALE PROFILE (or your stated assumption), and where it starts to hurt. Prefix estimates with "~"; never invent exact prices.

Rules:
- Silence is a good answer: a typo, rename, test or doc change is "calm" with no findings.
- At most 5 findings, most important first, each with a concrete consequence in THIS change.
- Skip anything in KNOWN unless this change makes it materially worse; then start the title with "Worse: ".
- SIGNALS are regex hints and may be false alarms.
- severity: "act" = a security hole or likely to hurt soon; "watch" = bites at a threshold you name; "fyi" = good to know.
- Be brief, in plain words a new teammate understands. Respect every word limit below.
- "chart" and "diff" are optional: add a chart only when numbers make the point, a diff only when the fix fits in 6 lines.

Answer with JSON only, between <ripple> and </ripple>:
{"verdict":"calm"|"ripples","headline":"one plain sentence, at most 25 words: what this change now does that matters","findings":[{"title":"at most 60 characters","lenses":["reliability","cost"],"severity":"act"|"watch"|"fyi","file":"path/as/given","line":14,"what":"what happens and why it matters, at most 25 words","chain":["what follows, 2-3 steps of at most 5 words, ending in the consequence"],"bitesWhen":"the scale or condition, at most 10 words","saveBy":"how to avoid or save, at most 12 words","fix":"the concrete next step, at most 20 words","diff":"- old line\\n+ new line","chart":{"type":"stack","title":"at most 40 characters","unit":"s","items":[{"label":"AI replies","value":40},{"label":"sends","value":15}],"limit":{"value":10,"label":"provider timeout"}},"confidence":"low"|"medium"|"high"}]}

Chart types: "stack" = parts of one total against a limit (seconds before an acknowledgement, queries per request); "bars" = one bar per option or scale (monthly cost as written against a cheaper way, today against 10x). 2-4 items, short labels, positive numbers, unit like "s", "ms", "queries", "$/mo".`

export type BriefInput = {
  changes: readonly Change[]
  signals: readonly Signal[]
  profile: string
  known: readonly LedgerEntry[]
  /** What the developer asked for and what was said back: the change's intent, in a few hundred characters. */
  intent: { ask: string; answer: string }
  inConversation: boolean
  diffBudget: number
}

/**
 * The reviewer's prompt in two parts: `fixed`, the same on every call (sent
 * first and marked for the prompt cache), and `variable`, this change.
 */
export function buildBrief(input: BriefInput): { fixed: string; variable: string } {
  const files = summarizeFiles(input.changes)
  const signals = input.signals.slice(0, 30).map(s => {
    const where = s.line === undefined ? s.file : `${s.file}:${s.line}`
    return `- [${s.lens}] ${where}: ${s.label}${s.snippet ? ` | ${s.snippet}` : ''}`
  })
  const known = relevantKnown(input.known, input.changes).map(
    k => `- (${k.decision}) [${k.lenses.join(',')}] ${k.file}: ${k.title}`,
  )
  const diff = clip(input.changes.map(c => c.diff).join('\n\n'), input.diffBudget)
  const ask = oneLine(input.intent.ask, 600)
  const answer = oneLine(input.intent.answer, 600)

  const where = input.inConversation
    ? "THE CHANGE is the edits made in this conversation's most recent turn(s) to the files below; the conversation tells you their intent. A compact diff follows for reference."
    : 'THE CHANGE is the compact diff below ("+" added, "-" removed, "…" unchanged lines left out).'

  const variable = [
    where,
    '',
    ...(input.inConversation || (ask === '' && answer === '')
      ? []
      : ['INTENT:', ask && `asked: ${ask}`, answer && `done: ${answer}`, ''].filter(l => l !== '')),
    `SCALE PROFILE: ${input.profile.trim() === '' ? '(none given; infer from the code and say what you assumed)' : input.profile.trim()}`,
    '',
    'FILES:',
    ...files,
    '',
    'SIGNALS:',
    ...(signals.length === 0 ? ['(none)'] : signals),
    '',
    'KNOWN:',
    ...(known.length === 0 ? ['(none)'] : known),
    '',
    'DIFF:',
    diff === '' ? '(see the conversation)' : diff,
  ].join('\n')
  return { fixed: BRIEF, variable }
}

/** The ledger entries worth the reviewer's tokens: those on the changed files, then the newest few others. */
function relevantKnown(known: readonly LedgerEntry[], changes: readonly Change[]): LedgerEntry[] {
  const files = new Set(changes.map(c => c.file))
  const onFiles = known.filter(k => files.has(k.file.replace(/:\d+$/, '')))
  const others = known.filter(k => !onFiles.includes(k)).slice(-10)
  return [...onFiles.slice(-30), ...others]
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function summarizeFiles(changes: readonly Change[]): string[] {
  const byFile = new Map<string, { added: number; removed: number; tools: Set<string> }>()
  for (const c of changes) {
    const one = byFile.get(c.file) ?? { added: 0, removed: 0, tools: new Set<string>() }
    one.added += c.added
    one.removed += c.removed
    one.tools.add(c.tool)
    byFile.set(c.file, one)
  }
  return [...byFile].map(([file, s]) => `- ${file} (+${s.added} -${s.removed}, ${[...s.tools].join('/')})`)
}

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text
  return `${text.slice(0, budget)}\n... (${text.length - budget} more characters of diff left out)`
}

export type Verdict = { verdict: 'calm' | 'ripples'; headline: string; findings: Finding[] }

/** Reads the reviewer's answer; undefined when it holds no usable JSON. */
export function parseVerdict(text: string, known: readonly LedgerEntry[]): Verdict | undefined {
  const tagged = /<ripple>([\s\S]*?)<\/ripple>/.exec(text)?.[1]
  const body = tagged ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let raw: unknown
  try {
    raw = JSON.parse(body.trim())
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const knownPrints = new Set(known.map(k => k.fingerprint))
  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .map(toFinding)
    .filter((f): f is Finding => f !== undefined && !knownPrints.has(f.fingerprint))
    .slice(0, 5)
  const verdict = findings.length === 0 ? 'calm' : 'ripples'
  const headline = str(obj.headline, 220) || (verdict === 'calm' ? 'Calm waters.' : `${findings.length} ripples worth a look.`)
  return { verdict, headline, findings }
}

function toFinding(raw: unknown, index: number): Finding | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const title = str(o.title, 80)
  if (title === '') return undefined
  const lenses = (Array.isArray(o.lenses) ? o.lenses : [o.lens])
    .filter((l): l is Lens => typeof l === 'string' && (LENSES as readonly string[]).includes(l))
  const severity = (SEVERITIES as readonly string[]).includes(String(o.severity)) ? (o.severity as Severity) : 'watch'
  const file = str(o.file, 200)
  const line = typeof o.line === 'number' && Number.isFinite(o.line) && o.line > 0 ? Math.round(o.line) : undefined
  const confidence = o.confidence === 'low' || o.confidence === 'high' ? o.confidence : 'medium'
  const lensList: Lens[] = lenses.length === 0 ? ['reliability'] : [...new Set(lenses)]
  const fingerprint = fingerprintOf(file, lensList, title)
  const chain = (Array.isArray(o.chain) ? o.chain : []).map(step => str(step, 50)).filter(step => step !== '').slice(0, 4)
  const diff = diffOf(o.diff)
  const chart = chartOf(o.chart)
  return {
    id: `${fingerprint}-${index}`,
    fingerprint,
    title,
    lenses: lensList,
    severity,
    file,
    ...(line === undefined ? {} : { line }),
    what: str(o.what, 300),
    ...(chain.length === 0 ? {} : { chain }),
    bitesWhen: str(o.bitesWhen, 120),
    saveBy: str(o.saveBy, 160),
    fix: str(o.fix, 240),
    ...(diff === undefined ? {} : { diff }),
    ...(chart === undefined ? {} : { chart }),
    confidence,
    status: 'new',
  }
}

/** A fix of a few diff lines, each starting with "-", "+" or " "; anything else is dropped whole. */
function diffOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const lines = raw.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '').slice(0, 8)
  if (!lines.every(l => /^[-+ ]/.test(l))) return undefined
  return lines.map(l => (l.length > 140 ? `${l.slice(0, 139)}…` : l)).join('\n')
}

function chartOf(raw: unknown): Chart | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const items = (Array.isArray(o.items) ? o.items : [])
    .map(item => {
      const it = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
      return { label: str(it.label, 24), value: typeof it.value === 'number' ? it.value : Number.NaN }
    })
    .filter(it => it.label !== '' && Number.isFinite(it.value) && it.value >= 0)
    .slice(0, 5)
  if (items.length < (o.type === 'stack' ? 1 : 2) || items.every(it => it.value === 0)) return undefined
  const limitRaw = (typeof o.limit === 'object' && o.limit !== null ? o.limit : undefined) as Record<string, unknown> | undefined
  const limitValue = typeof limitRaw?.value === 'number' && Number.isFinite(limitRaw.value) && limitRaw.value > 0 ? limitRaw.value : undefined
  return {
    type: o.type === 'stack' ? 'stack' : 'bars',
    title: str(o.title, 60),
    unit: str(o.unit, 12),
    items,
    ...(limitValue === undefined ? {} : { limit: { value: limitValue, label: str(limitRaw?.label, 30) } }),
  }
}

function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value.trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const STOP = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'for', 'to', 'per', 'and', 'or', 'with', 'is', 'are', 'worse'])

/** Stable across rephrasings of the same title: the file, the lenses and the title's main words. */
export function fingerprintOf(file: string, lenses: readonly Lens[], title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .sort()
    .slice(0, 6)
  return fnv1a(`${file}|${[...lenses].sort().join(',')}|${words.join(' ')}`)
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** The prompt "Fix it" hands the main session. */
export function fixPrompt(f: Finding): string {
  return [
    `Ripple 🌊 flagged this in the change we just made. Please fix it, keeping the change small and focused:`,
    '',
    `${SEVERITY_ICON[f.severity]} ${f.title} (${f.lenses.join(', ')})`,
    `Where: ${where(f)}`,
    f.what && `What: ${f.what}`,
    f.chain && f.chain.length > 0 ? `Then: ${f.chain.join(' → ')}` : '',
    f.bitesWhen && `Bites when: ${f.bitesWhen}`,
    f.fix && `Suggested fix: ${f.fix}`,
    f.diff ? `Sketch:\n${f.diff}` : '',
    '',
    'If you find it is not actually a problem, say so and explain why instead of changing code.',
  ]
    .filter(line => line !== '')
    .join('\n')
}

/** The prompt "Dig deeper" hands the main session: investigate, change nothing. */
export function digPrompt(f: Finding): string {
  return [
    `Ripple 🌊 flagged a possible ripple. Investigate it before we decide; do not change any code yet.`,
    '',
    `${SEVERITY_ICON[f.severity]} ${f.title} (${f.lenses.join(', ')}) at ${where(f)}`,
    f.what && `What: ${f.what}`,
    '',
    'Find out: who calls or consumes this (other modules, services, jobs, clients), how often it runs on real traffic, what it costs or risks at our scale and at 10x, and whether other services, deploy config or docs must change with it. End with a short verdict: real or not, how urgent, and the cheapest safe fix.',
  ]
    .filter(line => line !== '')
    .join('\n')
}

export function where(f: Pick<Finding, 'file' | 'line'>): string {
  if (f.file === '') return '(general)'
  return f.line === undefined ? f.file : `${f.file}:${f.line}`
}
