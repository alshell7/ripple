export type Lens = 'stack' | 'security' | 'reliability' | 'efficiency' | 'scalability' | 'cost'

export type Severity = 'act' | 'watch' | 'fyi'

export type Mode = 'smart' | 'always' | 'manual'

/** One hit of the local scanner: a cheap regex hint, confirmed or ignored by the reviewer. */
export type Signal = {
  rule: string
  lens: Lens
  label: string
  weight: number
  file: string
  line?: number
  snippet: string
}

/** One edit, write or command of the session that has not been reviewed yet. */
export type Change = {
  id: string
  tool: string
  file: string
  added: number
  removed: number
  diff: string
  signals: Signal[]
  isDocOrTest: boolean
}

export type FindingStatus = 'new' | 'aware' | 'not-an-issue' | 'fixing' | 'digging'

/**
 * A small picture of a finding's numbers. `stack`: the parts of one total
 * against a limit (seconds per request against a timeout). `bars`: one bar per
 * option or scale (cost today against 10x, as written against a cheaper way).
 */
export type Chart = {
  type: 'stack' | 'bars'
  title: string
  unit: string
  items: { label: string; value: number }[]
  limit?: { value: number; label: string }
}

export type Finding = {
  id: string
  fingerprint: string
  title: string
  lenses: Lens[]
  severity: Severity
  file: string
  line?: number
  what: string
  chain?: string[]
  bitesWhen: string
  saveBy: string
  fix: string
  diff?: string
  chart?: Chart
  why?: string
  multiplier?: string
  confidence: 'low' | 'medium' | 'high'
  status: FindingStatus
}

export type ReviewUsage = { input: number; output: number; cached: number }

export type Review = {
  phase: 'running' | 'done' | 'failed'
  source: 'turn' | 'check'
  at: number
  files: string[]
  lines: number
  verdict: 'calm' | 'ripples' | 'quiet'
  headline: string
  findings: Finding[]
  signals: Signal[]
  reviewer: string
  usage?: ReviewUsage
  note?: string
}

export type LedgerEntry = {
  fingerprint: string
  title: string
  lenses: Lens[]
  severity: Severity
  file: string
  decision: 'aware' | 'not-an-issue'
  at: string
  note?: string
}

export type Ledger = {
  version: 1
  profile: string
  entries: LedgerEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      pending: Change[]
      review: Review | null
      expanded: string[]
      lens: Lens | 'all'
      isBandHidden: boolean
      isLedgerOpen: boolean
      ledger: Ledger
      mode: Mode
    }
  }
}
