// Pictures of a review: the radar and a finding's chart, as SVG for the
// surfaces that draw it and as colored block characters for the terminal.
// Fixed mid-tone colors, so each reads on a light and a dark background.

import type { Chart, Finding, Lens, ReviewUsage, Severity } from '../types'

export const SEVERITY_HEX: Record<Severity, string> = { act: '#E24B4A', watch: '#EF9F27', fyi: '#378ADD' }
export const PART_HEX = ['#EF9F27', '#378ADD', '#1D9E75', '#D4537E', '#888780'] as const
const MUTED = '#888780'
const FONT = 'font-family="system-ui, -apple-system, sans-serif"'
const ORDER: readonly Lens[] = ['cost', 'efficiency', 'scalability', 'reliability', 'security', 'stack']

export function partColor(index: number): string {
  return PART_HEX[index % PART_HEX.length] ?? MUTED
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function short(value: number): string {
  const [n, suffix] = value >= 1e6 ? [value / 1e6, 'M'] : value >= 1e3 ? [value / 1e3, 'k'] : [value, '']
  return `${Number(n.toFixed(n < 10 ? 1 : 0))}${suffix}`
}

/** 47000 with "$/mo" reads "~$47k/mo"; 40 with "s" reads "40 s". */
export function formatValue(value: number, unit: string): string {
  if (unit.startsWith('$')) return `~$${short(value)}${unit.slice(1)}`
  return unit === '' ? short(value) : `${short(value)} ${unit}`
}

/** One dot per finding: its first lens picks the direction, its severity the ring (act nearest the splash). */
export function radarSvg(findings: readonly Finding[]): string {
  const ring: Record<Severity, number> = { act: 16, watch: 30, fyi: 43 }
  const seen = new Map<string, number>()
  const dots = findings.map(f => {
    const lens = f.lenses[0] ?? 'reliability'
    const slot = `${lens}:${f.severity}`
    const nth = seen.get(slot) ?? 0
    seen.set(slot, nth + 1)
    const angle = ((ORDER.indexOf(lens) * 60 - 90 + nth * 22) * Math.PI) / 180
    const x = (48 + Math.cos(angle) * ring[f.severity]).toFixed(1)
    const y = (48 + Math.sin(angle) * ring[f.severity]).toFixed(1)
    const opacity = f.status === 'new' ? 1 : 0.35
    return `<circle cx="${x}" cy="${y}" r="${f.severity === 'act' ? 5 : 4.5}" fill="${SEVERITY_HEX[f.severity]}" opacity="${opacity}"><title>${escapeXml(f.title)}</title></circle>`
  })
  const rings = [16, 30, 43].map(r => `<circle cx="48" cy="48" r="${r}" fill="none" stroke="${MUTED}" stroke-opacity="0.45" stroke-width="0.8"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${rings.join('')}<circle cx="48" cy="48" r="2.5" fill="${MUTED}"/>${dots.join('')}</svg>`
}

/** The chart as SVG, 400 wide. Labels the legend does not carry are drawn in muted gray. */
export function chartSvg(chart: Chart): { source: string; height: number } {
  if (chart.type === 'stack') {
    const total = chart.items.reduce((t, it) => t + it.value, 0)
    const max = Math.max(total, chart.limit?.value ?? 0) * 1.06
    const scale = 392 / max
    let x = 4
    const parts = chart.items.map((it, i) => {
      const w = Math.max(it.value > 0 ? 2 : 0, it.value * scale)
      const rect = `<rect x="${x.toFixed(1)}" y="14" width="${w.toFixed(1)}" height="16" fill="${partColor(i)}"/>`
      x += w
      return rect
    })
    let limit = ''
    if (chart.limit !== undefined) {
      const lx = 4 + chart.limit.value * scale
      const isLeft = lx > 260
      const label = escapeXml(`${formatValue(chart.limit.value, chart.unit)} ${chart.limit.label}`.trim())
      limit =
        `<line x1="${lx.toFixed(1)}" y1="8" x2="${lx.toFixed(1)}" y2="36" stroke="${SEVERITY_HEX.act}" stroke-width="2" stroke-dasharray="3 2"/>` +
        `<text x="${(isLeft ? lx - 4 : lx + 4).toFixed(1)}" y="48" ${FONT} font-size="11" fill="${SEVERITY_HEX.act}" text-anchor="${isLeft ? 'end' : 'start'}">${label}</text>`
    }
    const totalLabel = `<text x="396" y="10" ${FONT} font-size="11" fill="${MUTED}" text-anchor="end">${escapeXml(formatValue(total, chart.unit))}</text>`
    return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="52" viewBox="0 0 400 52">${parts.join('')}${limit}${totalLabel}</svg>`, height: 52 }
  }
  const max = Math.max(...chart.items.map(it => it.value)) || 1
  const rows = chart.items.map((it, i) => {
    const y = i * 24
    const w = Math.max(3, (it.value / max) * 190)
    return (
      `<text x="0" y="${y + 15}" ${FONT} font-size="12" fill="${MUTED}">${escapeXml(it.label)}</text>` +
      `<rect x="130" y="${y + 4}" width="${w.toFixed(1)}" height="14" rx="2" fill="${partColor(i)}"/>` +
      `<text x="${(136 + w).toFixed(1)}" y="${y + 15}" ${FONT} font-size="12" fill="${MUTED}">${escapeXml(formatValue(it.value, chart.unit))}</text>`
    )
  })
  const height = chart.items.length * 24 + 2
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${height}" viewBox="0 0 400 ${height}">${rows.join('')}</svg>`, height }
}

export type Run = { text: string; color?: string }

/** The chart as rows of colored runs, for the terminal: `width` cells for the bar. */
export function chartRows(chart: Chart, width: number): Run[][] {
  const cells = Math.max(10, Math.min(48, width))
  if (chart.type === 'stack') {
    const total = chart.items.reduce((t, it) => t + it.value, 0)
    const max = Math.max(total, chart.limit?.value ?? 0)
    const bar: Run[] = chart.items.map((it, i) => ({
      text: '█'.repeat(Math.max(it.value > 0 ? 1 : 0, Math.round((it.value / max) * cells))),
      color: partColor(i),
    }))
    const rows: Run[][] = [[...bar, { text: ` ${formatValue(total, chart.unit)}`, color: MUTED }]]
    if (chart.limit !== undefined) {
      const at = Math.min(cells - 1, Math.round((chart.limit.value / max) * cells))
      rows.push([
        { text: ' '.repeat(at) },
        { text: `▲ ${formatValue(chart.limit.value, chart.unit)} ${chart.limit.label}`.trim(), color: SEVERITY_HEX.act },
      ])
    }
    return rows
  }
  const max = Math.max(...chart.items.map(it => it.value)) || 1
  const labelWidth = Math.min(16, Math.max(...chart.items.map(it => it.label.length)))
  return chart.items.map((it, i) => [
    { text: `${it.label.slice(0, labelWidth).padEnd(labelWidth)} `, color: MUTED },
    { text: '█'.repeat(Math.max(1, Math.round((it.value / max) * (cells - labelWidth)))), color: partColor(i) },
    { text: ` ${formatValue(it.value, chart.unit)}`, color: MUTED },
  ])
}

/** A stack chart's legend: one colored square per part. */
export function legendRuns(chart: Chart): Run[] {
  return chart.items.flatMap((it, i) => [
    { text: '■ ', color: partColor(i) },
    { text: `${it.label} ${formatValue(it.value, chart.unit)}${i < chart.items.length - 1 ? '   ' : ''}` },
  ])
}

/** A few lines of fix as one unified-diff hunk, so the Code element draws it with gutters and colors. */
export function diffHunk(diff: string): string {
  const lines = diff.split('\n')
  const before = lines.filter(l => !l.startsWith('+')).length
  const after = lines.filter(l => !l.startsWith('-')).length
  return `@@ -1,${before} +1,${after} @@\n${lines.join('\n')}`
}

// Per million tokens: input, output, cache read. An estimate for the footer, by the reviewer's name.
const PRICE: Record<string, readonly [number, number, number]> = {
  haiku: [0.1, 0.5, 0.01],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  sonnet: [2, 10, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  opus: [4, 20, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
}

export function tokensLine(usage: ReviewUsage, reviewer: string): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const price = PRICE[reviewer]
  const usd = price && (usage.input * price[0] + usage.output * price[1] + usage.cached * price[2]) / 1e6
  const cost = usd === undefined ? '' : ` · ~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`
  return `${k(usage.input)} in · ${k(usage.cached)} cached · ${k(usage.output)} out${cost}`
}
