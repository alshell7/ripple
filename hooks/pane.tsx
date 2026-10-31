// The Ripple pane, drawn from plain data and the presses it hands back.
// Kept small on purpose: the top finding opens, the rest are one row each.

import type { Elements } from 'claude-code'

import type { Chart, Finding, FindingStatus, Ledger, Lens, Mode, Review, Severity } from '../types'
import { chartRows, chartSvg, diffHunk, legendRuns, radarSvg, SEVERITY_HEX, tokensLine } from './charts'
import type { Run } from './charts'
import { LENS_ICON, LENS_NAME, SEVERITY_ICON, where } from './review'

type Ui = Elements[keyof Elements]

export type PaneModel = {
  review: Review | null
  expanded: readonly string[]
  lens: Lens | 'all'
  book: Ledger
  mode: Mode
  queued: number
  isLedgerShown: boolean
  columns: number
  /** The terminal draws no SVG (it would show the alt text), so its charts are block characters. */
  hasSvg: boolean
}

export type PaneActions = {
  toggle: (id: string) => void
  decide: (f: Finding, decision: 'aware' | 'not-an-issue') => void
  handOff: (f: Finding, kind: 'fix' | 'dig') => void
  setLens: (lens: Lens | 'all') => void
  reviewNow: () => void
  retry: () => void
  toggleLedger: () => void
  forget: (fingerprint: string) => void
  setProfile: (text: string) => void
}

const SEVERITIES: readonly Severity[] = ['act', 'watch', 'fyi']

const STATUS_CHIP: Record<FindingStatus, string> = {
  new: '',
  aware: '  ✓ aware',
  'not-an-issue': '  ✓ not an issue',
  fixing: '  🛠 fix requested',
  digging: '  🔍 digging',
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function severityCounts(findings: readonly Finding[]): string {
  return SEVERITIES.map(s => [s, findings.filter(f => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${SEVERITY_ICON[s]} ${n} ${s}`)
    .join('   ')
}

function runs(ui: Ui, list: readonly Run[]) {
  const { Text } = ui
  return <Text>{list.map(run => (run.color === undefined ? run.text : <Text color={run.color}>{run.text}</Text>))}</Text>
}

function chartView(ui: Ui, chart: Chart, columns: number, hasSvg: boolean) {
  const { Box, Text } = ui
  const Svg = hasSvg && 'Svg' in ui ? ui.Svg : undefined
  const picture = chartSvg(chart)
  const alt = `${chart.title}: ${chart.items.map(it => `${it.label} ${it.value}${chart.unit}`).join(', ')}`
  return (
    <Box flexDirection="column">
      {chart.title !== '' && (
        <Text dimColor size="footnote">
          {chart.title}
        </Text>
      )}
      {Svg !== undefined ? (
        <Svg source={picture.source} alt={alt} height={picture.height} />
      ) : (
        chartRows(chart, columns - 14).map(row => runs(ui, row))
      )}
      {chart.type === 'stack' && <Text size="footnote">{legendRuns(chart).map(run => (run.color === undefined ? run.text : <Text color={run.color}>{run.text}</Text>))}</Text>}
    </Box>
  )
}

function card(ui: Ui, f: Finding, isOpen: boolean, m: PaneModel, act: PaneActions) {
  const { Box, Text, Button, Code } = ui
  const isNew = f.status === 'new'
  const chain = f.chain ?? []
  const lastStep = chain.length - 1
  const footnote = [f.bitesWhen && `Bites at: ${f.bitesWhen}`, f.saveBy && `Save by: ${f.saveBy}`].filter(Boolean).join('  ·  ')
  return (
    <Box
      key={`card-${f.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={isNew ? SEVERITY_HEX[f.severity] : 'inactive'}
      paddingX={1}
      rowGap={isOpen ? 1 : 0}
    >
      <Button key={`f-${f.id}`} plain dimColor={!isNew} onPress={() => act.toggle(f.id)}>
        {isOpen ? '▾ ' : '▸ '}
        {SEVERITY_ICON[f.severity]} {f.title}
        <Text dimColor>{STATUS_CHIP[f.status]}</Text>
      </Button>
      {isOpen && (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="column">
            <Text dimColor mono size="footnote">
              {where(f)} · {f.lenses.map(l => LENS_ICON[l]).join(' ')}
              {f.confidence === 'low' ? ' · low confidence' : ''}
            </Text>
            {f.what !== '' && <Text>{f.what}</Text>}
          </Box>
          {f.chart !== undefined && chartView(ui, f.chart, m.columns, m.hasSvg)}
          {chain.length > 0 && (
            <Text>
              <Text dimColor>Then </Text>
              {chain.map((step, i) =>
                i === lastStep ? (
                  <Text color={SEVERITY_HEX[f.severity]} weight="semibold">
                    {step}
                  </Text>
                ) : (
                  `${step} → `
                ),
              )}
            </Text>
          )}
          {chain.length === 0 && f.why !== undefined && f.why !== '' && <Text dimColor>{f.why}</Text>}
          {footnote !== '' && (
            <Text dimColor size="footnote">
              {footnote}
            </Text>
          )}
          {f.diff !== undefined ? (
            <Code source={diffHunk(f.diff)} format="diff" path={f.file} wrap="truncate-end" />
          ) : (
            f.fix !== '' && (
              <Text dimColor size="footnote">
                Fix: {f.fix}
              </Text>
            )
          )}
          {isNew && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Button key={`aware-${f.id}`} label="👀 Got it" onPress={() => act.decide(f, 'aware')} />
              <Button key={`fix-${f.id}`} label="🛠 Fix it" variant="primary" onPress={() => act.handOff(f, 'fix')} />
              <Button key={`dig-${f.id}`} label="🔍 Dig deeper" onPress={() => act.handOff(f, 'dig')} />
              <Button key={`nope-${f.id}`} label="🙅 Not an issue" onPress={() => act.decide(f, 'not-an-issue')} />
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

function titleOf(r: Review, open: number): { title: string; sentence: string } {
  const from = r.source === 'check' ? 'in your uncommitted changes' : 'from your last change'
  if (r.phase === 'running') return { title: `Reviewing ${plural(r.files.length, 'file')}…`, sentence: '' }
  if (r.phase === 'failed') return { title: 'The review did not land', sentence: r.note ?? '' }
  if (r.verdict === 'quiet') return { title: r.headline, sentence: '' }
  if (r.verdict === 'calm') return { title: 'Calm waters', sentence: r.headline }
  return { title: `${plural(open, 'ripple')} ${from}`, sentence: r.headline }
}

export function paneTree(ui: Ui, m: PaneModel, act: PaneActions) {
  const { Box, Text, Button } = ui
  const Svg = m.hasSvg && 'Svg' in ui ? ui.Svg : undefined
  const Input = 'Input' in ui ? ui.Input : undefined
  const r = m.review
  const findings = r?.findings ?? []
  const open = findings.filter(f => f.status === 'new')
  const lenses = [...new Set(findings.flatMap(f => f.lenses))]
  const showFilters = findings.length >= 3 && lenses.length >= 2
  const lens = showFilters && m.lens !== 'all' && lenses.includes(m.lens) ? m.lens : 'all'
  const shown = lens === 'all' ? findings : findings.filter(f => f.lenses.includes(lens))
  const aware = m.book.entries.filter(x => x.decision === 'aware').length
  const head = r === null ? undefined : titleOf(r, open.length)

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Text color="claude" weight="semibold">
            🌊 Ripple <Text dimColor weight="regular">· {m.mode}</Text>
          </Text>
          {head === undefined ? (
            <Text dimColor>After each change I tell you what it ripples into. Small, safe changes stay quiet and cost nothing.</Text>
          ) : (
            <Box flexDirection="column">
              <Text weight="semibold" size="heading" color={r?.phase === 'failed' ? 'error' : undefined}>
                {head.title}
              </Text>
              {head.sentence !== '' && <Text dimColor>{head.sentence}</Text>}
              {open.length > 0 && <Text>{severityCounts(open)}</Text>}
            </Box>
          )}
          {r?.phase === 'failed' && (
            <Box flexDirection="row">
              <Button key="retry" label="Try again" onPress={act.retry} />
            </Box>
          )}
        </Box>
        {Svg !== undefined && findings.length > 0 && (
          <Svg source={radarSvg(findings)} alt={`Ripple radar: ${severityCounts(findings)}`} width={96} height={96} isInteractive />
        )}
      </Box>

      {showFilters && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="lens-all" label={`All ${findings.length}`} variant={lens === 'all' ? 'primary' : 'secondary'} onPress={() => act.setLens('all')} />
          {lenses.map(l => (
            <Button
              key={`lens-${l}`}
              label={`${LENS_ICON[l]} ${LENS_NAME[l]} ${findings.filter(f => f.lenses.includes(l)).length}`}
              variant={lens === l ? 'primary' : 'secondary'}
              onPress={() => act.setLens(l)}
            />
          ))}
        </Box>
      )}

      {shown.length > 0 && (
        <Box flexDirection="column" rowGap={0}>
          {shown.map(f => card(ui, f, m.expanded.includes(f.id), m, act))}
        </Box>
      )}

      {r !== null && r.verdict === 'quiet' && r.phase === 'done' && r.signals.length > 0 && (
        <Box flexDirection="column">
          {r.signals.slice(0, 3).map(s => (
            <Text dimColor size="footnote" wrap="truncate-end">
              {LENS_ICON[s.lens]} {s.label}
            </Text>
          ))}
        </Box>
      )}

      {m.queued > 0 && r?.phase !== 'running' && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>🗂 {plural(m.queued, 'change')} not reviewed yet</Text>
          <Button key="review-now" label="Review now" onPress={act.reviewNow} />
        </Box>
      )}

      <Box flexDirection="column">
        {r?.usage !== undefined && (
          <Text dimColor size="footnote">
            This review: {tokensLine(r.usage, r.reviewer)} · {r.reviewer}
          </Text>
        )}
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor size="footnote">
            📒 Team aware: {String(aware)} · not an issue: {String(m.book.entries.length - aware)}
          </Text>
          {m.book.entries.length > 0 && (
            <Button key="ledger" plain label={m.isLedgerShown ? 'hide' : 'show'} onPress={act.toggleLedger} />
          )}
        </Box>
        {m.isLedgerShown &&
          m.book.entries
            .slice(-10)
            .reverse()
            .map(x => (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor size="footnote" wrap="truncate-end">
                  {x.decision === 'aware' ? '👀' : '🙅'} {x.title}
                </Text>
                <Button key={`forget-${x.fingerprint}`} plain label="forget" onPress={() => act.forget(x.fingerprint)} />
              </Box>
            ))}
        {Input !== undefined ? (
          <Input
            key="scale"
            label="📏 Scale"
            placeholder="50 msg/s peak, 2M contacts, AWS ECS + RDS Postgres + SQS"
            value={m.book.profile}
            submitLabel="Save"
            onSubmit={value => act.setProfile(value)}
          />
        ) : (
          <Text dimColor size="footnote">
            📏 Scale: {m.book.profile === '' ? 'not set (/ripple scale …)' : m.book.profile}
          </Text>
        )}
      </Box>
    </Box>
  )
}
