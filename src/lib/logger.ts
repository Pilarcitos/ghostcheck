export type LogFields = Record<string, unknown>

const SECRET_FIELD = /^(api_key|apikey|access_token|authorization|password|cookie|secret|firecrawl_api_key|gemini_api_key|scrapecreators_api_key)$/i

function serialize(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    if (oneLine.length > 400) {
      return JSON.stringify(`${oneLine.slice(0, 400)}...[truncated ${oneLine.length - 400} chars]`)
    }
    return JSON.stringify(oneLine)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const json = JSON.stringify(value)
    return json.length > 800 ? `${json.slice(0, 800)}...[truncated]` : json
  } catch {
    return '"[unserializable]"'
  }
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : value
  }
  return out
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly fields: LogFields = {},
  ) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(scope, { ...this.fields, ...fields })
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
    const extras = Object.entries(merged)
      .map(([key, value]) => `${key}=${serialize(value)}`)
      .join(' ')
    const line = `${new Date().toISOString()} ${level.padEnd(5)} [${this.scope}] ${message}${extras ? ` | ${extras}` : ''}`
    if (level === 'ERROR') console.error(line)
    else console.log(line)
  }
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

export const rootLogger = new Logger('app')
