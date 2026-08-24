import { elapsedMs, type Logger } from './logger'

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape'

type FirecrawlScrapeResponse = {
  success?: boolean
  error?: string
  data?: {
    markdown?: string
    metadata?: {
      title?: string
      description?: string
      sourceURL?: string
      statusCode?: number
      language?: string
    }
  }
}

function previewMarkdown(markdown: string): string {
  const firstHeading = markdown.split('\n').find((line) => line.trim().startsWith('#'))
  const firstText = markdown.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstHeading?.trim() || firstText.trim()
}

/**
 * Fetches a URL through Firecrawl and returns clean markdown.
 * Firecrawl handles JS rendering, anti-bot, and proxying server-side.
 */
export async function fetchMarkdown(url: string, log: Logger): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    log.error('Cannot scrape because FIRECRAWL_API_KEY is missing from the environment.')
    throw new Error('FIRECRAWL_API_KEY is not set')
  }

  log.info(
    'Sending a scrape request to Firecrawl. Firecrawl will render JavaScript, follow site-level redirects, and return markdown instead of raw HTML.',
    { scrape_url: url, firecrawl_endpoint: FIRECRAWL_SCRAPE_URL, formats: ['markdown'] },
  )

  const startedAt = performance.now()
  const res = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
    }),
  })

  const rawBody = await res.text()
  const elapsed_ms = elapsedMs(startedAt)

  log.info('Received an HTTP response from Firecrawl.', {
    status: res.status,
    status_text: res.statusText,
    elapsed_ms,
    body_bytes: rawBody.length,
  })

  if (!res.ok) {
    log.error('Firecrawl rejected the scrape request. Extraction cannot continue without page content.', {
      status: res.status,
      body: rawBody,
    })
    throw new Error(`Firecrawl request failed (${res.status}): ${rawBody}`)
  }

  let data: FirecrawlScrapeResponse
  try {
    data = JSON.parse(rawBody) as FirecrawlScrapeResponse
  } catch (err) {
    log.error('Firecrawl returned a non-JSON body even though the HTTP status was successful.', {
      parse_error: err instanceof Error ? err.message : String(err),
      body: rawBody,
    })
    throw new Error('Firecrawl returned invalid JSON')
  }

  const markdown = data?.data?.markdown
  const metadata = data?.data?.metadata

  log.info('Parsed the Firecrawl JSON payload.', {
    success: data.success ?? null,
    error: data.error ?? null,
    has_markdown: Boolean(markdown),
    markdown_chars: markdown?.length ?? 0,
    page_title: metadata?.title ?? null,
    page_status_code: metadata?.statusCode ?? null,
    source_url: metadata?.sourceURL ?? null,
    language: metadata?.language ?? null,
  })

  if (!markdown) {
    log.error('Firecrawl JSON did not include markdown. The page may have blocked the scrape or returned an empty body.')
    throw new Error('Firecrawl returned no markdown content for this URL')
  }

  log.info('Scrape complete. Markdown will be sent to Gemini for structured extraction.', {
    markdown_chars: markdown.length,
    opening_line: previewMarkdown(markdown),
  })

  return markdown
}
