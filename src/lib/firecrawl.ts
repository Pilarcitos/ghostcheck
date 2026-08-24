const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape'

/**
 * Fetches a URL through Firecrawl and returns clean markdown.
 * Firecrawl handles JS rendering, anti-bot, and proxying server-side —
 * this works the same for a Greenhouse posting or a LinkedIn job page.
 */
export async function fetchMarkdown(url: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set')
  }

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

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Firecrawl request failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as { data?: { markdown?: string } }
  const markdown = data?.data?.markdown

  if (!markdown) {
    throw new Error('Firecrawl returned no markdown content for this URL')
  }

  return markdown
}
