import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Review } from '../types'
import { fromEdit, fromUnifiedDiff, fromWrite } from '../hooks/changes'
import { buildBrief, fingerprintOf, parseVerdict } from '../hooks/review'
import { commandSignals, shouldReview, textSignals } from '../hooks/signals'

const rules = (list: readonly { rule: string }[]) => list.map(s => s.rule)

describe('the local scanner', () => {
  test('a query added inside an existing loop is a cost multiplier', async () => {
    const before = 'for (const order of orders) {\n  total += order.amount\n}'
    const after =
      'for (const order of orders) {\n  total += order.amount\n  const customer = await db.customers.findOne({ id: order.customerId })\n}'
    const change = fromEdit('src/orders.ts', before, after)
    expect(rules(change.signals)).toContain('loop-io')
    expect(change.added).toBe(1)
  })

  test('code the change did not touch is not flagged again', async () => {
    const before = 'const rows = await db.query("SELECT * FROM users")\nreturn rows'
    const after = 'const rows = await db.query("SELECT * FROM users")\nreturn rows.map(r => r.id)'
    expect(rules(fromEdit('src/users.ts', before, after).signals)).not.toContain('select-star')
  })

  test('the loop sees its context: a call added under a loop header above the edit', async () => {
    const context = 'async function sync(ids) {\n  for (const id of ids) {'
    const signals = textSignals('src/sync.ts', '    await fetch(`/api/items/${id}`)', { context, firstLine: 3 })
    const hit = signals.find(s => s.rule === 'loop-io')
    expect(hit?.line).toBe(3)
  })

  test('secrets are caught even in tests; other rules stay quiet there', async () => {
    const text = 'const apiKey = "sk-live-0123456789abcdef"\nconst rows = await db.query("SELECT * FROM t")'
    expect(rules(textSignals('src/__tests__/a.test.ts', text))).toEqual(['secret'])
  })

  test('security, reliability and cost rules', async () => {
    const py = [
      'resp = requests.get(url)',
      'cur.execute(f"SELECT name FROM users WHERE id = {user_id}")',
      'client = OpenAI()',
      'out = client.chat.completions.create(model="gpt", messages=m)',
      'requests.post(hook, verify=False, timeout=5)',
    ].join('\n')
    const found = rules(textSignals('app/handlers.py', py))
    expect(found).toContain('no-timeout')
    expect(found).toContain('sql-concat')
    expect(found).toContain('llm-call')
    expect(found).toContain('tls-off')
  })

  test('shell commands that move the stack or the infrastructure', async () => {
    expect(rules(commandSignals('npm install openai@4'))).toEqual(['dep-install'])
    expect(rules(commandSignals('kubectl scale deploy/api --replicas=12'))).toEqual(['infra-command'])
    expect(commandSignals('ls -la')).toEqual([])
  })

  test('smart mode spends tokens only when it is worth it', async () => {
    const quiet = [{ file: 'README.md', added: 40, signals: [], isDocOrTest: true }]
    expect(shouldReview(quiet, 'balanced').review).toBe(false)
    const small = [{ file: 'src/a.ts', added: 3, signals: [], isDocOrTest: false }]
    expect(shouldReview(small, 'balanced').review).toBe(false)
    const risky = fromEdit('src/orders.ts', '', 'for (const o of orders) {\n  await db.save(o)\n}')
    expect(shouldReview([risky], 'balanced').review).toBe(true)
  })

  test('a git diff becomes one change per file, with real line numbers', async () => {
    const diff = [
      'diff --git a/src/jobs.ts b/src/jobs.ts',
      'index 1..2 100644',
      '--- a/src/jobs.ts',
      '+++ b/src/jobs.ts',
      '@@ -10,3 +10,4 @@ export function start() {',
      ' const queue = connect()',
      '-setTimeout(run, 1000)',
      '+setInterval(run, 1000)',
      '+console.log("started")',
      ' export default queue',
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,1 +1,1 @@',
      '-{"dependencies":{}}',
      '+{"dependencies":{"openai":"^4"}}',
    ].join('\n')
    const [jobs, pkg] = fromUnifiedDiff(diff)
    expect(jobs?.added).toBe(2)
    expect(jobs?.signals.find(s => s.rule === 'polling')?.line).toBe(11)
    expect(rules(pkg?.signals ?? [])).toContain('deps-manifest')
  })

  test('a rewrite counts only what changed', async () => {
    const change = fromWrite('src/a.ts', 'one\ntwo\nthree\nfour', 'one\ntwo\nthree')
    expect(change.added).toBe(1)
    expect(change.removed).toBe(0)
  })
})

describe('the reviewer', () => {
  const answer = `Sure.
<ripple>{"verdict":"ripples","headline":"One DB call per order.","findings":[
 {"title":"Query per order inside the loop","lenses":["cost","efficiency"],"severity":"act","file":"src/orders.ts","line":3,
  "what":"Loads the customer once per order.","why":"N+1 round trips.","bitesWhen":"> 200 orders per request",
  "multiplier":"1 query × orders","saveBy":"batch with IN","fix":"Load customers once.","confidence":"high"},
 {"title":"","lenses":["cost"]},
 {"title":"Weird lens","lenses":["vibes"],"severity":"huge"}
]}</ripple>`

  test('reads tagged JSON, keeps good findings, normalizes the rest', async () => {
    const verdict = parseVerdict(answer, [])
    expect(verdict?.verdict).toBe('ripples')
    expect(verdict?.findings.length).toBe(2)
    expect(verdict?.findings[0]?.severity).toBe('act')
    expect(verdict?.findings[1]?.lenses).toEqual(['reliability'])
    expect(verdict?.findings[1]?.severity).toBe('watch')
  })

  test('what the ledger already holds is never raised again', async () => {
    const print = fingerprintOf('src/orders.ts', ['cost', 'efficiency'], 'Query per order inside the loop')
    const known = [
      { fingerprint: print, title: 't', lenses: ['cost' as const], severity: 'act' as const, file: 'src/orders.ts', decision: 'aware' as const, at: '' },
    ]
    expect(parseVerdict(answer, known)?.findings.map(f => f.title)).toEqual(['Weird lens'])
  })

  test('the fingerprint survives a rephrasing that keeps the main words', async () => {
    expect(fingerprintOf('a.ts', ['cost'], 'Query per order inside the loop')).toBe(
      fingerprintOf('a.ts', ['cost'], 'Inside the loop: query per order'),
    )
  })

  test('charts, chains and diffs are kept only when well formed', async () => {
    const one = (finding: Record<string, unknown>) =>
      parseVerdict(`<ripple>${JSON.stringify({ verdict: 'ripples', headline: 'h', findings: [{ title: 'T', lenses: ['cost'], ...finding }] })}</ripple>`, [])?.findings[0]
    expect(one({ chart: { type: 'bars', title: 'x', unit: '$/mo', items: [{ label: 'a', value: 5 }, { label: 'b', value: 1 }] } })?.chart?.items.length).toBe(2)
    expect(one({ chart: { type: 'bars', items: [{ label: 'a', value: 'lots' }] } })?.chart).toBeUndefined()
    expect(one({ diff: '+ ok()\n- old()' })?.diff).toBe('+ ok()\n- old()')
    expect(one({ diff: 'just prose, no diff' })?.diff).toBeUndefined()
    expect(one({ chain: ['a', '', 'b'] })?.chain).toEqual(['a', 'b'])
  })

  test('an unreadable answer is undefined, not a crash', async () => {
    expect(parseVerdict('no json here', [])).toBeUndefined()
  })

  test('the brief keeps its fixed part separate, for the prompt cache', async () => {
    const change = fromEdit('src/a.ts', '', 'const x = 1')
    const one = buildBrief({ changes: [change], signals: [], profile: '', known: [], intent: { ask: 'add x', answer: 'done' }, inConversation: false, diffBudget: 1000 })
    const two = buildBrief({ changes: [change], signals: [], profile: '10 rps', known: [], intent: { ask: '', answer: '' }, inConversation: false, diffBudget: 1000 })
    expect(one.fixed).toBe(two.fixed)
    expect(one.variable).toContain('asked: add x')
    expect(two.variable).toContain('SCALE PROFILE: 10 rps')
  })
})

const VERDICT = `<ripple>${JSON.stringify({
  verdict: 'ripples',
  headline: 'Every inbound message now costs an AI call, a lookup and a paid send before the provider gets its OK.',
  findings: [
    {
      title: 'Webhook replies before it acknowledges',
      lenses: ['reliability', 'cost'],
      severity: 'act',
      file: 'src/webhook.ts',
      line: 14,
      what: 'A 50-message batch now takes about a minute; the provider gives up at 10 s.',
      chain: ['Provider retries', 'Batch runs again', 'Duplicate replies, 2x cost'],
      bitesWhen: 'batches over ~8 messages',
      saveBy: 'acknowledge first, reply from a queue',
      fix: 'Send 200 right after saving; reply in a worker.',
      diff: '+ res.sendStatus(200)\n+ await queue.send(messages)\n- for (const message of messages) {',
      chart: { type: 'stack', title: 'Seconds before the provider gets its OK', unit: 's', items: [{ label: 'AI replies', value: 40 }, { label: 'lookups', value: 5 }, { label: 'sends', value: 15 }], limit: { value: 10, label: 'provider timeout' } },
      confidence: 'high',
    },
    {
      title: 'One Opus call per inbound message',
      lenses: ['cost'],
      severity: 'watch',
      file: 'src/ai.ts',
      line: 9,
      what: 'AI spend grows one-for-one with message volume.',
      bitesWhen: 'any real traffic',
      saveBy: 'Haiku, one reply per conversation',
      fix: 'Use claude-haiku-5-5 for greetings.',
      chart: { type: 'bars', title: 'Monthly cost at 10 msg/s', unit: '$/mo', items: [{ label: 'Opus, as written', value: 47000 }, { label: 'Haiku', value: 1200 }] },
      confidence: 'medium',
    },
    {
      title: 'Customer messages written to logs',
      lenses: ['security'],
      severity: 'fyi',
      file: 'src/webhook.ts',
      line: 18,
      what: 'Reply text and phone numbers land in log storage.',
      bitesWhen: '',
      saveBy: 'log ids only',
      fix: 'Log the message id, not the text.',
      confidence: 'medium',
    },
  ],
})}</ripple>`

const ORDERS = 'export async function total(orders) {\n  for (const order of orders) {\n    const c = await db.customers.findOne({ id: order.customerId })\n  }\n}'

const USAGE = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200 }

/** What the engine does beneath the plugin, as far as these tests need it. */
function engine(on: On, root = '/repo'): void {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 23, 10, 0) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ripple' } }))
  on('session.root', () => ({ value: root }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

/** Resolves with the first review the plugin writes that `isWanted` accepts: the review runs after the turn, unawaited. */
function reviewWhere(on: On, isWanted: (r: Review) => boolean): Promise<Review> {
  return new Promise(resolve => {
    on('state.set', { plugin: 'ripple', key: 'review' }, (_, e, next) => {
      const value = e.value as Review | null
      if (value !== null && isWanted(value)) resolve(value)
      return next(e)
    })
  })
}

test('an edit, a turn, a review, a pane and a press', async ($, on) => {
  const written: Record<string, string> = {}
  const prompts: string[] = []
  const landed = reviewWhere(on, r => r.phase === 'done')
  engine(on)
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Add customer names to order totals', toolUses: [] }] }))
  on('fs.read', (_, e) => (e.path === '/repo/src/orders.ts' ? { value: ORDERS } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: VERDICT, usage: USAGE } }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/orders.ts',
    old_string: 'for (const order of orders) {\n  }',
    new_string: 'for (const order of orders) {\n    const c = await db.customers.findOne({ id: order.customerId })\n  }',
  })
  await $.turn.complete({ answer: 'Added names.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  const review = await landed
  expect(review.findings.map(f => f.title)).toEqual([
    'Webhook replies before it acknowledges',
    'One Opus call per inbound message',
    'Customer messages written to logs',
  ])
  expect(review.findings[0]?.chart?.limit?.value).toBe(10)
  expect(review.findings[0]?.chain?.length).toBe(3)
  expect(review.usage).toEqual({ input: 900, output: 300, cached: 1200 })
  expect(prompts[0]).toContain('asked: Add customer names to order totals')
  expect(prompts[0]).toContain('Call inside a loop')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ripple',
      surface,
      component: 'Pane',
      requestId: 'ripple',
      props: { title: '🌊 Ripple', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /3 ripples from your last change/ }), 'the title counts the ripples').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bites at: batches over/ }), 'when it bites').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Duplicate replies, 2x cost/ }), 'the consequence chain').toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' }), 'desktop draws SVG').toBeDefined()
    else expect(await ui.find({ type: 'Text', text: /█/ }), 'the terminal draws block bars').toBeDefined()
    // Only the top finding opens: the others are one row each.
    expect(await ui.find({ type: 'Text', text: /AI spend grows/ }), 'only the top finding opens').toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'ripple',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'ripple',
    props: { title: '🌊 Ripple', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await ui.press({ key: 'lens-security' })
  expect(await ui.find({ type: 'Button', text: /Customer messages written to logs/ }), 'the security finding stays').toBeDefined()
  expect(await ui.find({ type: 'Button', text: /One Opus call per inbound message/ }), 'the cost finding is filtered out').toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Webhook replies before it acknowledges/ }), 'so is the reliability one').toBeUndefined()
  await ui.press({ key: 'lens-all' })

  const id = review.findings[0]?.id ?? ''
  await ui.press({ key: `aware-${id}` })
  const ledgerFile = written['/repo/.ripple/ledger.json'] ?? ''
  expect(ledgerFile).toContain('Webhook replies before it acknowledges')
  expect(ledgerFile).toContain('"decision": "aware"')
  expect(await ui.find({ type: 'Text', text: /Team aware: 1/ }), 'the ledger count moves').toBeDefined()
  await ui.unmount()
})

test('a small safe edit spends no tokens', async ($, on) => {
  let calls = 0
  const landed = reviewWhere(on, () => true)
  engine(on)
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '<ripple>{"verdict":"calm","headline":"x","findings":[]}</ripple>', usage: USAGE } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'const greeting = "helo"', new_string: 'const greeting = "hello"' })
  await $.turn.complete({ answer: 'Fixed the typo.', durationMs: 500, isAborted: false, turnId: 't1', reason: 'answer' })
  const review = await landed
  expect(review.verdict).toBe('quiet')
  expect(review.reviewer).toBe('local scanner, no model call')
  expect(calls).toBe(0)
})
