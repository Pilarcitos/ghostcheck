export type LogFields = Record<string, unknown>

const SECRET_FIELD =
  /^(api_key|apikey|access_token|authorization|password|cookie|secret|firecrawl_api_key|gemini_api_key|scrapecreators_api_key)$/i

const MULTILINE_KEYS = new Set([
  'text',
  'body',
  'stack',
  'truncated_json',
  'raw_text',
  'likely_cause',
  'error_message',
  'detail',
])

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const WHITE = '\x1b[37m'

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout?.isTTY)
}

function paint(code: string, value: string): string {
  if (!colorEnabled()) return value
  return `${code}${value}${RESET}`
}

function dim(value: string): string {
  return paint(DIM, value)
}

function bold(value: string): string {
  return paint(BOLD, value)
}

function clock(): string {
  return new Date().toISOString().slice(11, 23)
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : value
  }
  return out
}

function oneLine(value: string, max = 220): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}… [${collapsed.length - max} more chars]`
}

function asLines(value: unknown, maxLines = 36, maxChars = 4000): string[] {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more chars]`
  }
  return text.split('\n').slice(0, maxLines)
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return oneLine(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return oneLine(JSON.stringify(value), 280)
  } catch {
    return '[unserializable]'
  }
}

function levelStyle(level: string): string {
  const label = level.padEnd(5)
  if (level === 'ERROR') return paint(RED + BOLD, label)
  if (level === 'WARN') return paint(YELLOW + BOLD, label)
  if (level === 'DEBUG') return dim(label)
  return paint(CYAN, label)
}

function writeRaw(line: string, error: boolean) {
  if (error) console.error(line)
  else console.log(line)
}

function printPath(from: unknown, to: unknown, error: boolean) {
  writeRaw(`             ${dim('from')}  ${formatValue(from)}`, error)
  writeRaw(`             ${dim('  → ')}  ${formatValue(to)}`, error)
}

function printLinks(links: unknown, error: boolean) {
  if (!Array.isArray(links) || links.length === 0) {
    writeRaw(`             ${dim('links')}  (none)`, error)
    return
  }
  writeRaw(`             ${dim('links')}`, error)
  for (const item of links) {
    if (item && typeof item === 'object' && 'url' in item) {
      const row = item as { url: string; from?: string; postUrl?: string | null }
      const src = row.from ? dim(`  (${row.from})`) : ''
      writeRaw(`               -  ${row.url}${src}`, error)
      continue
    }
    writeRaw(`               -  ${formatValue(item)}`, error)
  }
}

function printHops(hops: unknown, error: boolean) {
  if (!Array.isArray(hops) || hops.length === 0) {
    writeRaw(`             ${dim('hops')}  (none)`, error)
    return
  }
  writeRaw(`             ${dim('path')}`, error)
  hops.forEach((hop, index) => {
    if (hop && typeof hop === 'object' && 'from' in hop && 'to' in hop) {
      const row = hop as { status?: number; from: string; to: string }
      const status = row.status != null ? `  ${dim(`HTTP ${row.status}`)}` : ''
      writeRaw(`               ${dim(`${index + 1}.`)} ${row.from}${status}`, error)
      writeRaw(`                  ${paint(CYAN, '→')}  ${row.to}`, error)
      return
    }
    const prefix = index === 0 ? dim(`${index + 1}.`) : paint(CYAN, '→')
    writeRaw(`               ${prefix}  ${formatValue(hop)}`, error)
  })
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly fields: LogFields = {},
  ) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(scope, { ...this.fields, ...fields })
  }

  banner(title: string, detail?: string) {
    const requestId = this.fields.request_id
    const width = 64
    const rule = dim('─'.repeat(width))
    console.log('')
    console.log(rule)
    const id = requestId ? dim(`  ${String(requestId)}`) : ''
    console.log(`  ${bold(title)}${id}`)
    if (detail) console.log(`  ${dim(detail)}`)
    console.log(rule)
    console.log('')
  }

  section(title: string) {
    console.log('')
    console.log(dim(`── ${title} ${'─'.repeat(Math.max(8, 56 - title.length))}`))
    console.log('')
  }

  debug(message: string, fields?: LogFields) {
    this.write('DEBUG', message, fields)
  }

  info(message: string, fields?: LogFields) {
    this.write('INFO', message, fields)
  }

  warn(message: string, fields?: LogFields) {
    this.write('WARN', message, fields)
  }

  error(message: string, fields?: LogFields) {
    this.write('ERROR', message, fields)
  }

  private write(level: string, message: string, fields?: LogFields) {
    const merged = redact({ ...this.fields, ...fields })
    const requestId = merged.request_id
    delete merged.request_id
    const error = level === 'ERROR'
    const loud = level === 'ERROR' || level === 'WARN'

    if (loud) writeRaw('', error)

    const id = requestId ? dim(String(requestId)) : ''
    writeRaw(`${dim(clock())}  ${levelStyle(level)}  ${paint(WHITE, this.scope.padEnd(12))}  ${id}`, error)
    writeRaw(`             ${loud ? bold(message) : message}`, error)

    const from = merged.from
    const to = merged.to
    const hops = merged.hops
    if (from !== undefined && to !== undefined) {
      printPath(from, to, error)
      delete merged.from
      delete merged.to
    }
    if (hops !== undefined) {
      printHops(hops, error)
      delete merged.hops
    }
    if (merged.links !== undefined && Array.isArray(merged.links)) {
      printLinks(merged.links, error)
      delete merged.links
    }

    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue
      if (MULTILINE_KEYS.has(key) || (typeof value === 'string' && value.includes('\n'))) {
        writeRaw(`             ${dim(key)}`, error)
        for (const line of asLines(value)) {
          writeRaw(`               ${error ? paint(RED, line) : dim(line)}`, error)
        }
        continue
      }
      writeRaw(`             ${dim(key.padEnd(18))}  ${formatValue(value)}`, error)
    }

    if (loud) writeRaw('', error)
  }
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

export const rootLogger = new Logger('app')
