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
  log.info('Incoming HTTP request.', {
    method: c.req.method,
    path: c.req.path,
    user_agent: c.req.header('user-agent') ?? null,
    content_type: c.req.header('content-type') ?? null,
  })

  await next()

  log.info('HTTP request completed.', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
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
      log.warn('Decipherer stopped without a posting. Returning that outcome to the client instead of a fake job object.', {
        kind: err.kind,
        url: err.url,
        hops: err.hops,
        error_message: err.message,
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

    log.error('Extraction pipeline failed. Returning 502 to the client.', {
      error_name: err instanceof Error ? err.name : 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
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
