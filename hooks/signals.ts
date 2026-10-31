// The local scanner: free, instant regex hints run on every edit. They decide
// whether a review is worth a model call, and the reviewer confirms or drops them.

import type { Lens, Signal } from '../types'

type PathRule = { id: string; lens: Lens; weight: number; label: string; path: RegExp }

type TextRule = {
  id: string
  lens: Lens
  weight: number
  label: string
  text: RegExp
  only?: RegExp
  evenInTests?: boolean
}

const DOC_OR_TEST =
  /\.(md|mdx|txt|rst|adoc)$|(^|\/)(__tests__|tests?|spec|specs|fixtures?|mocks?|__mocks__|docs?)\/|[._-](test|spec)\.[a-z]+$/i

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|<!--)/

const PATH_RULES: PathRule[] = [
  {
    id: 'deps-manifest',
    lens: 'stack',
    weight: 2,
    label: 'Dependency manifest changed: versions here reach every image, lockfile and consumer',
    path: /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.csproj|pubspec\.yaml|Package\.swift|Podfile)$/,
  },
  {
    id: 'container',
    lens: 'stack',
    weight: 2,
    label: 'Container or runtime definition changed',
    path: /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i,
  },
  {
    id: 'infra',
    lens: 'stack',
    weight: 2,
    label: 'Infrastructure definition changed: capacity, network and the bill live here',
    path: /\.(tf|tfvars|bicep)$|(^|\/)(serverless\.ya?ml|template\.ya?ml|cdk\.json|Chart\.yaml|values[^/]*\.ya?ml|kustomization\.ya?ml|fly\.toml|app\.yaml|vercel\.json|netlify\.toml)$|(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|infra|terraform|cdk|pulumi)\//i,
  },
  {
    id: 'contract',
    lens: 'stack',
    weight: 3,
    label: 'Service contract changed: other services, clients or teams may depend on it',
    path: /\.(proto|graphql|gql|avsc|thrift)$|(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i,
  },
  {
    id: 'migration',
    lens: 'stack',
    weight: 2,
    label: 'Database schema or migration: locking, rollout order and rollback matter',
    path: /(^|\/)(migrations?|migrate|alembic|db\/migrate|flyway|liquibase)\/|\.sql$|schema\.prisma$/i,
  },
  {
    id: 'ci',
    lens: 'stack',
    weight: 1,
    label: 'CI/CD pipeline changed: runner minutes and the deploy path',
    path: /(^|\/)\.github\/workflows\/|\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\/|(^|\/)buildspec\.ya?ml$|(^|\/)cloudbuild\.ya?ml$/i,
  },
  {
    id: 'env-config',
    lens: 'stack',
    weight: 1,
    label: 'Config or env changed: every environment and service reading it needs it too',
    path: /(^|\/)\.env(\.[^/]*)?$|(^|\/)(config|settings|appsettings)[^/]*\.(ya?ml|json|toml|ini)$/i,
  },
]

const SQL_VERB = '(SELECT|INSERT|UPDATE|DELETE)'

const TEXT_RULES: TextRule[] = [
  // security
  {
    id: 'secret',
    lens: 'security',
    weight: 3,
    label: 'Looks like a hardcoded secret',
    text: /(api[_-]?key|secret|passw(or)?d|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"\s]{8,}['"]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[sr]k_live_[0-9a-zA-Z]{10,}|\bghp_[0-9A-Za-z]{30,}|\bxox[baprs]-[0-9A-Za-z-]{10,}|\bsk-ant-[0-9A-Za-z_-]{20,}|\bsk-[A-Za-z0-9]{32,}/i,
    evenInTests: true,
  },
  {
    id: 'eval',
    lens: 'security',
    weight: 3,
    label: 'Dynamic code execution',
    text: /\beval\s*\(|new Function\s*\(/,
  },
  {
    id: 'shell',
    lens: 'security',
    weight: 2,
    label: 'Shell execution: injection risk if input reaches it',
    text: /shell\s*=\s*True|os\.system\s*\(|\bexecSync\s*\(|child_process['"]\)?\.exec\b|\bexec\s*\(\s*`[^`]*\$\{|Runtime\.getRuntime\(\)\.exec/,
  },
  {
    id: 'tls-off',
    lens: 'security',
    weight: 3,
    label: 'TLS verification turned off',
    text: /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|ssl\.CERT_NONE|check_hostname\s*=\s*False/,
  },
  {
    id: 'cors-open',
    lens: 'security',
    weight: 2,
    label: 'CORS opened to any origin',
    text: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|\borigin\s*:\s*(['"]\*['"]|true)\b|allow_origins\s*=\s*\[\s*['"]\*['"]|\bcors\(\s*\)/,
  },
  {
    id: 'raw-html',
    lens: 'security',
    weight: 2,
    label: 'Raw HTML injection point (XSS)',
    text: /dangerouslySetInnerHTML|\.innerHTML\s*=|\bv-html=|\|\s*safe\b|mark_safe\(|bypassSecurityTrust/,
  },
  {
    id: 'sql-concat',
    lens: 'security',
    weight: 3,
    label: 'SQL built from strings: injection risk',
    text: new RegExp(
      `\`[^\`]*\\b${SQL_VERB}\\b[^\`]*\\$\\{|\\bf['"][^'"]*\\b${SQL_VERB}\\b[^'"]*\\{|['"][^'"]*\\b${SQL_VERB}\\b[^'"]*['"]\\s*(\\+|%\\s*[(\\w])|\\.format\\([^)]*\\)[^\\n]*\\b${SQL_VERB}\\b|\\b${SQL_VERB}\\b[^'"\\n]*['"]\\s*\\.\\s*format\\(`,
      'i',
    ),
  },
  {
    id: 'deserialize',
    lens: 'security',
    weight: 3,
    label: 'Unsafe deserialization',
    text: /pickle\.loads?\(|yaml\.load\((?![^)]*SafeLoader)|ObjectInputStream|\bunserialize\(|Marshal\.load|BinaryFormatter/,
  },
  {
    id: 'wide-access',
    lens: 'security',
    weight: 3,
    label: 'Over-broad access: wildcard IAM, open network or public bucket',
    text: /"Action"\s*:\s*"\*"|"Resource"\s*:\s*"\*"|"Principal"\s*:\s*"\*"|actions\s*=\s*\[\s*"\*"\s*\]|0\.0\.0\.0\/0|::\/0|public-read|PublicAccessBlock[^\n]*false|block_public_acls\s*=\s*false/,
  },
  {
    id: 'jwt-weak',
    lens: 'security',
    weight: 3,
    label: 'Token verification weakened',
    text: /algorithms?\s*[:=]\s*\[?\s*['"]none['"]|verify_signature['"]?\s*:\s*False|ignoreExpiration\s*:\s*true|verify\s*=\s*False[^\n]*jwt|jwt\.decode\([^)]*verify\s*=\s*False/i,
  },
  {
    id: 'weak-hash',
    lens: 'security',
    weight: 1,
    label: 'Weak hash (MD5/SHA-1): fine for checksums, not for secrets',
    text: /createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\(|\bMD5\.Create\(|DigestUtils\.(md5|sha1)/i,
  },
  {
    id: 'pii-log',
    lens: 'security',
    weight: 2,
    label: 'Sensitive data may end up in logs',
    text: /(console\.(log|info|warn|error)|logger\.\w+|logging\.\w+|\bprint|log\.\w+)\s*\([^\n]*\b(password|passwd|token|secret|ssn|card_?number|cvv|authorization|api_?key)\b/i,
  },

  // cost: anything that multiplies a metered resource
  {
    id: 'llm-call',
    lens: 'cost',
    weight: 3,
    label: 'LLM/AI API call: billed per token, scales with traffic and prompt size',
    text: /\b(chat\.completions\.create|responses\.create|messages\.create|messages\.stream|generateContent|generate_content|ChatOpenAI|ChatAnthropic|InvokeModel(WithResponseStream)?Command|invoke_model|embeddings\.create|embed_documents|createEmbedding|ConverseCommand|new (OpenAI|Anthropic)\(|from (openai|anthropic) import|['"]@?(openai|anthropic-ai\/sdk|@google\/generative-ai)['"])/,
  },
  {
    id: 'per-message-api',
    lens: 'cost',
    weight: 2,
    label: 'Per-message billed API (SMS, email, WhatsApp, voice)',
    text: /\b(twilio|sendgrid|mailgun|postmark|vonage|nexmo|messagebird|plivo|SendEmailCommand|SendRawEmailCommand|ses\.send_email|graph\.facebook\.com\/[^\n]*\/messages|whatsapp)\b/i,
  },
  {
    id: 'table-scan',
    lens: 'cost',
    weight: 2,
    label: 'Full table scan: billed and slowed per item read',
    text: /\bScanCommand\b|dynamodb[^\n]*\.scan\(|\btable\.scan\(|\.scan\(\s*\{\s*TableName/i,
  },
  {
    id: 'analytics-scan',
    lens: 'cost',
    weight: 2,
    label: 'Analytics query: billed by data scanned',
    text: /\b(bigquery|BigQuery|snowflake|athena|StartQueryExecution|redshift-data)\b/,
  },
  {
    id: 'object-storage',
    lens: 'cost',
    weight: 1,
    label: 'Object storage request: per-request and egress billing',
    text: /\b(PutObjectCommand|GetObjectCommand|ListObjectsV2Command|putObject|getObject|upload_file|download_file|list_objects_v2|bucket\.file\(|BlobClient|upload_blob)\b/,
  },
  {
    id: 'queue-invoke',
    lens: 'cost',
    weight: 1,
    label: 'Metered invocation or message (Lambda, SQS, SNS, Pub/Sub, events)',
    text: /\b(InvokeCommand|lambda\.invoke|SendMessageCommand|SendMessageBatchCommand|PublishCommand|PutEventsCommand|PutRecordCommand|send_message|publish_message|topic\.publish|\.publishMessage)\b/,
  },
  {
    id: 'polling',
    lens: 'cost',
    weight: 2,
    label: 'Polling or scheduled loop: runs and bills even when idle',
    text: /setInterval\s*\(|schedule\.every\(|@Scheduled\b|@periodic_task|\brate\(\s*\d+\s*(minute|minutes|second|seconds)\s*\)|['"](\*|\*\/\d+|\d+)\s+\*\s+\*\s+\*\s+\*['"]|while\s*\(\s*true\s*\)|while\s+True\s*:|for\s*\{\s*$/,
  },
  {
    id: 'sizing',
    lens: 'cost',
    weight: 2,
    label: 'Compute or capacity sizing changed: a direct line on the bill',
    text: /\b(instance_type|instanceType|InstanceType|node_type|machine_type|machineType|replicas|min_?(size|capacity|replicas|instances)|minReplicas|desired_?count|desiredCount|memory_?size|MemorySize|memorySize|provisioned_?concurrency|ProvisionedConcurrency|ReadCapacityUnits|WriteCapacityUnits|billing_mode|BillingMode|allocated_storage|storage_size|max_?(replicas|capacity|instances))\b/,
    only: /\.(tf|tfvars|ya?ml|json|toml|ts|js|py|bicep)$/i,
  },
  {
    id: 'network-egress',
    lens: 'cost',
    weight: 2,
    label: 'NAT, egress or cross-region path: billed per GB',
    text: /\b(aws_nat_gateway|NatGateway|nat_gateway|cross[-_]?region|replication_configuration|global_table|GlobalTable|egress)\b/i,
  },
  {
    id: 'retention',
    lens: 'cost',
    weight: 1,
    label: 'Retention or TTL changed: storage grows, or data disappears',
    text: /\b(retention(_in_days|InDays|_days|Days|_period)?|RetentionInDays|log_retention|ttl|TimeToLive)\b\s*[:=]\s*['"]?(0|null|None|-1|\d{3,})\b/i,
  },

  // efficiency
  {
    id: 'select-star',
    lens: 'efficiency',
    weight: 1,
    label: 'SELECT *: reads every column, defeats covering indexes',
    text: /\bSELECT\s+\*\s+FROM\b/i,
  },
  {
    id: 'unbounded-read',
    lens: 'efficiency',
    weight: 2,
    label: 'Unbounded read: grows with the table',
    text: /\.findAll\(\s*\)|\.find\(\s*\{\s*\}\s*\)|\.find\(\s*\)\s*(\.toArray\(\))?|\.objects\.all\(\)|\.findMany\(\s*\)|\.query\.all\(\)|\.all\(\)\s*$|\.fetchall\(\)/m,
  },
  {
    id: 'leading-wildcard',
    lens: 'efficiency',
    weight: 2,
    label: "Leading-wildcard LIKE: can't use an index",
    text: /\bI?LIKE\s+['"]%|\bcontains:\s*\w|\$regex\b/i,
  },
  {
    id: 'order-random',
    lens: 'efficiency',
    weight: 2,
    label: 'ORDER BY RANDOM(): sorts the whole table',
    text: /ORDER\s+BY\s+(RAND|RANDOM|NEWID)\(\)/i,
  },
  {
    id: 'count-star',
    lens: 'efficiency',
    weight: 1,
    label: 'COUNT(*): full count on a large table',
    text: /COUNT\(\s*\*\s*\)|\.count\(\s*\)|countDocuments\(\s*\{?\s*\}?\s*\)/,
  },
  {
    id: 'blocking-io',
    lens: 'efficiency',
    weight: 1,
    label: 'Blocking I/O: stalls the event loop under load',
    text: /\b(readFileSync|writeFileSync|execSync|spawnSync|appendFileSync)\b/,
  },
  {
    id: 'deep-clone',
    lens: 'efficiency',
    weight: 1,
    label: 'JSON round-trip clone: CPU heavy on large objects',
    text: /JSON\.parse\(\s*JSON\.stringify\(/,
  },
  {
    id: 'fan-out',
    lens: 'scalability',
    weight: 2,
    label: 'Unbounded parallel fan-out: spikes connections and rate limits',
    text: /Promise\.(all|allSettled)\(\s*[\w.]+\.map\(|asyncio\.gather\(\s*\*|errgroup|\.parallelStream\(\)/,
  },

  // reliability
  {
    id: 'swallowed-error',
    lens: 'reliability',
    weight: 2,
    label: 'Error swallowed: failures go silent',
    text: /except\s*(\w+(\s+as\s+\w+)?)?\s*:\s*\n?\s*(pass|\.\.\.)\s*$|catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)|if err != nil \{\s*\}/m,
  },
  {
    id: 'no-timeout',
    lens: 'reliability',
    weight: 2,
    label: 'Outbound call without a timeout: a slow dependency can hang workers',
    text: /requests\.(get|post|put|delete|patch|request)\((?![^)]*timeout)[^)]*\)|\bhttp\.(Get|Post|Head)\(|httpx\.(get|post)\((?![^)]*timeout)[^)]*\)|urllib\.request\.urlopen\((?![^)]*timeout)[^)]*\)/,
  },
  {
    id: 'todo',
    lens: 'reliability',
    weight: 1,
    label: 'TODO/FIXME/HACK left in the change',
    text: /\b(TODO|FIXME|HACK|XXX)\b/,
  },

  // scalability
  {
    id: 'in-process-state',
    lens: 'scalability',
    weight: 2,
    label: 'In-process cache or state: per instance, unbounded, lost on restart',
    text: /^(export\s+)?(const|let|var)\s+\w*(cache|Cache|store|Store|sessions?|Sessions?|registry|Registry|queue|Queue|memo)\w*\s*(:\s*[\w<>, ]+)?\s*=\s*(new (Map|Set|WeakMap)\b|\{\s*\}|\[\s*\])|^\w*(cache|CACHE|sessions?|SESSIONS|registry)\w*\s*(:\s*\w+\s*)?=\s*(\{\s*\}|dict\(\)|\[\s*\])\s*$|\bMemoryStore\b|lru_cache\(\s*maxsize\s*=\s*None|@functools\.cache\b|^@cache\b/m,
  },
  {
    id: 'local-disk',
    lens: 'scalability',
    weight: 1,
    label: "Writes to local disk: doesn't survive several instances or a redeploy",
    text: /(writeFile|createWriteStream|open)\(\s*['"`](\.\/|\/tmp\/|uploads?\/|data\/)/,
  },
  {
    id: 'locking',
    lens: 'scalability',
    weight: 1,
    label: 'Locking: contention grows with concurrency',
    text: /\b(threading\.Lock|sync\.Mutex|synchronized\s*\(|LOCK TABLE|FOR UPDATE\b|pg_advisory_lock|SETNX|Redlock)\b/i,
  },
  {
    id: 'sleep',
    lens: 'scalability',
    weight: 1,
    label: 'Sleep in a code path: holds a worker or connection while waiting',
    text: /\b(time\.sleep\(|Thread\.sleep\(|await\s+sleep\(|await\s+new Promise\(\s*\(?\w*\)?\s*=>\s*setTimeout)/,
  },
]

// A loop header, and an I/O-ish call: together they are the classic N+1 and
// per-item cost multiplier.
const LOOP_HEADER =
  /^\s*(for\b|for\s*\(|while\b|foreach\b|.*\.forEach\(|.*\.(map|flatMap|filter|reduce)\(\s*(async\s*)?(\(|\w+\s*=>)|.*\.each\b|.*\bfor\s+\w+(\s*,\s*\w+)?\s+in\b|.*\bfor await\b)/
const IO_CALL =
  /(\.query\(|\.execute\(|\.exec\(|\.find(One|ById|Unique|First|Many)?\(|\.findBy\w*\(|\.save\(|\.insert\w*\(|\.update(One|Many)?\(|\.upsert\(|\.delete(One|Many)?\(|\.destroy\(|\.where\(|\bfetch\(|axios\.|requests\.|httpx\.|http\.(Get|Post)|\.send\(|\.publish\(|\.invoke\(|\.putItem\(|\.getItem\(|\.get_item\(|\.put_item\(|\bcursor\.|session\.(query|execute|get)|\bprisma\.|\bknex\b|\bredis\.|\.objects\.|\.create\(|\.messages\.|\.completions\.|getObject|putObject)/
const AWAIT = /\bawait\b/
const LOG_CALL = /\b(console\.(log|info|debug)|logger\.(info|debug|trace)|logging\.(info|debug)|log\.(Print|Info|Debug)\w*)\(/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

export function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1
  }
  return n
}

/** Indexes (0-based) of the lines of `after` that are not in `before`: what the change added. */
export function freshLines(before: string, after: string): Set<number> {
  const old = new Map<string, number>()
  for (const line of before.split('\n')) {
    const key = line.trim()
    old.set(key, (old.get(key) ?? 0) + 1)
  }
  const fresh = new Set<number>()
  after.split('\n').forEach((line, i) => {
    const key = line.trim()
    const left = old.get(key) ?? 0
    if (left > 0) old.set(key, left - 1)
    else if (key !== '') fresh.add(i)
  })
  return fresh
}

function snippetOf(line: string): string {
  const s = line.trim()
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

export function isDocOrTest(file: string): boolean {
  return DOC_OR_TEST.test(file)
}

export function pathSignals(file: string): Signal[] {
  return PATH_RULES.filter(r => r.path.test(file)).map(r => ({
    rule: r.id,
    lens: r.lens,
    label: r.label,
    weight: r.weight,
    file,
    snippet: '',
  }))
}

export type ScanOptions = {
  /** The file's text just above `text`, so a call added inside an existing loop is seen in it. */
  context?: string
  /** The file line `text` starts at, when known. */
  firstLine?: number
  /** Which lines of `text` (0-based) the change added; absent, all of them. */
  fresh?: ReadonlySet<number>
}

/** Scans one snippet of a change, reporting only what lands on lines the change added. */
export function textSignals(file: string, text: string, options: ScanOptions = {}): Signal[] {
  const isQuiet = isDocOrTest(file)
  const found: Signal[] = []
  const lines = text.split('\n')
  const { firstLine, fresh } = options
  const isFresh = (n: number) => fresh === undefined || fresh.has(n - 1)
  const at = (n: number) => (firstLine === undefined ? undefined : firstLine + n - 1)

  for (const rule of TEXT_RULES) {
    if (isQuiet && !rule.evenInTests) continue
    if (rule.only && !rule.only.test(file)) continue
    const flags = rule.text.flags.includes('g') ? rule.text.flags : `${rule.text.flags}g`
    const re = new RegExp(rule.text.source, flags)
    for (const m of text.matchAll(re)) {
      const n = lineAt(text, m.index ?? 0)
      const line = lines[n - 1] ?? ''
      if (!isFresh(n)) continue
      if (rule.id !== 'secret' && rule.id !== 'todo' && COMMENT.test(line)) continue
      found.push({ rule: rule.id, lens: rule.lens, label: rule.label, weight: rule.weight, file, line: at(n), snippet: snippetOf(line) })
      break
    }
  }

  if (!isQuiet) found.push(...loopSignals(file, text, options.context ?? '', firstLine, isFresh))
  return found
}

function loopSignals(
  file: string,
  added: string,
  context: string,
  firstLine: number | undefined,
  isFresh: (n: number) => boolean,
): Signal[] {
  const before = context === '' ? [] : context.split('\n')
  const all = [...before, ...added.split('\n')]
  const startOfAdded = before.length
  const found: Signal[] = []
  const seen = new Set<string>()
  const at = (i: number) => (firstLine === undefined ? undefined : firstLine + i - startOfAdded)

  for (let i = 0; i < all.length; i += 1) {
    const header = all[i] ?? ''
    if (!LOOP_HEADER.test(header) || COMMENT.test(header)) continue
    const base = indentOf(header)
    const isOneLiner = /=>\s*[^{\s]/.test(header) || /\)\s*\.\w+\(/.test(header)
    for (let j = i + (isOneLiner ? 0 : 1); j < Math.min(all.length, i + 40); j += 1) {
      const line = all[j] ?? ''
      if (j > i && line.trim() !== '' && indentOf(line) <= base && !/^\s*[)}\]]/.test(line)) break
      if (j < startOfAdded || !isFresh(j - startOfAdded + 1) || COMMENT.test(line)) continue
      const body = j === i ? header.slice(header.search(/=>|\bdo\b|:/) + 1) : line
      const kind = IO_CALL.test(body)
        ? 'loop-io'
        : AWAIT.test(body)
          ? 'loop-await'
          : LOG_CALL.test(body)
            ? 'loop-log'
            : j > i && LOOP_HEADER.test(line)
              ? 'nested-loop'
              : undefined
      if (kind === undefined || seen.has(`${kind}:${i}`)) continue
      seen.add(`${kind}:${i}`)
      const meta = LOOP_KINDS[kind]
      found.push({ rule: kind, lens: meta.lens, label: meta.label, weight: meta.weight, file, line: at(j), snippet: snippetOf(line) })
    }
  }
  return found
}

type LoopKind = 'loop-io' | 'loop-await' | 'loop-log' | 'nested-loop'

const LOOP_KINDS: Record<LoopKind, { lens: Lens; weight: number; label: string }> = {
  'loop-io': {
    lens: 'cost',
    weight: 3,
    label: 'Call inside a loop: one round-trip per item (N+1, a cost multiplier)',
  },
  'loop-await': {
    lens: 'efficiency',
    weight: 2,
    label: 'await inside a loop: serial round-trips, latency grows with items',
  },
  'loop-log': {
    lens: 'cost',
    weight: 1,
    label: 'Logging inside a loop: log ingest grows with items',
  },
  'nested-loop': {
    lens: 'efficiency',
    weight: 1,
    label: 'Nested loop: O(n²) as data grows',
  },
}

const INSTALL =
  /\b(npm\s+(i|install|add)|yarn\s+add|pnpm\s+(add|install)|bun\s+add|pip3?\s+install|poetry\s+add|uv\s+(add|pip\s+install)|go\s+get|cargo\s+add|gem\s+install|bundle\s+add|composer\s+require|dotnet\s+add\s+package)\b\s+\S/
const INFRA_CMD =
  /\b(terraform\s+(apply|destroy|import)|pulumi\s+up|cdk\s+deploy|kubectl\s+(apply|scale|delete|set|patch|rollout)|helm\s+(install|upgrade|uninstall)|serverless\s+deploy|sls\s+deploy|fly\s+(deploy|scale)|gcloud\s+\S+\s+(deploy|create|update)|aws\s+\S+\s+(create|put|update|delete)-|docker\s+push)\b/
const MIGRATE_CMD =
  /\b(prisma\s+migrate|alembic\s+upgrade|rails\s+db:migrate|manage\.py\s+migrate|knex\s+migrate|sequelize\s+db:migrate|flyway\s+migrate|goose\s+up|typeorm\s+migration:run)\b/

export function commandSignals(command: string): Signal[] {
  const found: Signal[] = []
  const snippet = snippetOf(command)
  if (INSTALL.test(command)) {
    found.push({ rule: 'dep-install', lens: 'stack', weight: 2, label: 'New dependency installed: footprint, licence, CVEs and every consumer', file: '(shell)', snippet })
  }
  if (INFRA_CMD.test(command)) {
    found.push({ rule: 'infra-command', lens: 'cost', weight: 3, label: 'Infrastructure changed from the shell: capacity and the bill moved', file: '(shell)', snippet })
  }
  if (MIGRATE_CMD.test(command)) {
    found.push({ rule: 'migrate-command', lens: 'stack', weight: 2, label: 'Migration run: schema moved under running services', file: '(shell)', snippet })
  }
  return found
}

export type Sensitivity = 'relaxed' | 'balanced' | 'eager'

/** Whether the pending changes earn a model review in smart mode, and why. */
export function shouldReview(
  changes: readonly { added: number; signals: readonly Signal[]; isDocOrTest: boolean; file: string }[],
  sensitivity: Sensitivity,
): { review: boolean; why: string } {
  const code = changes.filter(c => !c.isDocOrTest)
  const signals = changes.flatMap(c => c.signals)
  if (code.length === 0 && signals.length === 0) return { review: false, why: 'docs and tests only' }
  const maxWeight = signals.reduce((m, s) => Math.max(m, s.weight), 0)
  const sum = signals.reduce((t, s) => t + s.weight, 0)
  const lines = code.reduce((t, c) => t + c.added, 0)
  const files = new Set(code.map(c => c.file)).size
  const bar = {
    relaxed: { weight: 3, sum: 5, lines: 150, files: 8 },
    balanced: { weight: 2, sum: 3, lines: 60, files: 4 },
    eager: { weight: 1, sum: 1, lines: 15, files: 2 },
  }[sensitivity]
  if (maxWeight >= bar.weight) return { review: true, why: 'a risky-looking signal' }
  if (sum >= bar.sum) return { review: true, why: 'several small signals' }
  if (lines >= bar.lines) return { review: true, why: `${lines} lines changed` }
  if (files >= bar.files) return { review: true, why: `${files} files changed` }
  return { review: false, why: signals.length === 0 ? 'small change, nothing flagged' : 'only minor hints' }
}
