import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DecipherError, extractJob } from './lib/extract'
import { elapsedMs, newRequestId, rootLogger } from './lib/logger'
import { ensureAbsoluteUrl } from './lib/resolveUrl'

type Variables = { requestId: string }

const app = new Hono<{ Variables: Variables }>()

app.use('*', cors())

app.use('*', async (c, next) => {
  const requestId = newRequestId()
  const startedAt = performance.now()
  c.set('requestId', requestId)

  const log = rootLogger.child('http', { request_id: requestId })
  if (c.req.path !== '/health') {
    log.banner(`${c.req.method} ${c.req.path}`, `started ${new Date().toISOString()}`)
  }
  log.info('Incoming HTTP request.', {
    method: c.req.method,
    path: c.req.path,
    user_agent: c.req.header('user-agent') ?? null,
    content_type: c.req.header('content-type') ?? null,
  })

  await next()

  const status = c.res.status
  if (c.req.path !== '/health') {
    log.banner(
      `${status}  ${c.req.method} ${c.req.path}`,
      `${elapsedMs(startedAt)}ms  request_id=${requestId}`,
    )
  }
  log.info('HTTP request completed.', {
    method: c.req.method,
    path: c.req.path,
    status,
    elapsed_ms: elapsedMs(startedAt),
  })
})

app.get('/health', (c) => {
  rootLogger.child('health', { request_id: c.get('requestId') }).info(
    'Health check requested. Returning ok without touching Firecrawl or Gemini.',
  )
  return c.json({ ok: true })
})

app.post('/extract', async (c) => {
  const requestId = c.get('requestId') ?? newRequestId()
  const log = rootLogger.child('extract', { request_id: requestId })

  const body = await c.req.json().catch((err) => {
    log.warn('Request body was not valid JSON.', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  })
  const rawUrl = body?.url

  if (!rawUrl || typeof rawUrl !== 'string') {
    log.warn('Rejected extract request because the JSON body did not include a string "url" field.', {
      body_type: body === null ? 'null' : typeof body,
    })
    return c.json({ error: 'Missing "url" in request body' }, 400)
  }

  let absolute: string
  try {
    absolute = ensureAbsoluteUrl(rawUrl)
    const parsed = new URL(absolute)
    log.section('accept url')
    log.info('Accepted the extract request and parsed the URL.', {
      client_url: rawUrl,
      absolute_url: absolute,
      host: parsed.hostname,
    })
  } catch {
    log.warn('Rejected extract request because the URL could not be parsed even after adding an https scheme.', {
      client_url: rawUrl,
    })
    return c.json({ error: 'Invalid URL' }, 400)
  }

  try {
    const { job, decipher } = await extractJob(rawUrl, log)
    log.info('Returning a successful extraction payload to the client.', {
      title: job.title,
      company: job.company,
      source_platform: job.source_platform,
      url: job.url,
      page_kind: decipher.kind,
      hops: decipher.hops,
    })
    return c.json({ job, decipher, request_id: requestId })
  } catch (err) {
    if (err instanceof DecipherError) {
      log.section('stopped — not a posting')
      log.warn('Decipherer stopped without a posting. Returning that outcome to the client instead of a fake job object.', {
        kind: err.kind,
        url: err.url,
        hops: err.hops,
        error_message: err.message,
        likely_cause: `Page classified as ${err.kind}. Ghostcheck will not invent a job object from a listing, block, or hop limit.`,
      })
      return c.json(
        {
          error: 'Not a job posting',
          kind: err.kind,
          detail: err.message,
          url: err.url,
          hops: err.hops,
          request_id: requestId,
        },
        422,
      )
    }

    log.section('failed — 502')
    log.error('Extraction pipeline failed. Returning 502 to the client.', {
      error_name: err instanceof Error ? err.name : 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      likely_cause:
        err instanceof Error && err.message.includes('non-JSON')
          ? 'Gemini returned truncated or invalid JSON. Check finish_reason (MAX_TOKENS means the output budget ran out, often on thinking tokens).'
          : 'An upstream scrape, classify, or extract step threw. Read the ERROR block above this line for the first failure.',
    })
    return c.json(
      {
        error: 'Extraction failed',
        detail: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      },
      502,
    )
  }
})

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
}
