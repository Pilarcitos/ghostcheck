import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { extractJob } from './lib/extract'

const app = new Hono()

app.use('*', cors())

app.get('/health', (c) => c.json({ ok: true }))

app.post('/extract', async (c) => {
  const body = await c.req.json().catch(() => null)
  const url = body?.url

  if (!url || typeof url !== 'string') {
    return c.json({ error: 'Missing "url" in request body' }, 400)
  }

  try {
    new URL(url)
  } catch {
    return c.json({ error: 'Invalid URL' }, 400)
  }

  try {
    const job = await extractJob(url)
    return c.json({ job })
  } catch (err) {
    console.error(err)
    return c.json(
      { error: 'Extraction failed', detail: err instanceof Error ? err.message : String(err) },
      502,
    )
  }
})

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
}
