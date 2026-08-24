import { elapsedMs, type Logger } from './logger'

const USER_AGENT =
  'Mozilla/5.0 (compatible; Ghostcheck/0.1; job-extraction; +https://localhost)'

const MAX_REDIRECTS = 8

export type ResolvedUrl = {
  requested: string
  canonical: string
  hops: Array<{ status: number; from: string; to: string }>
}

export function ensureAbsoluteUrl(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function stripTrackingParams(url: string): string {
  const parsed = new URL(url)
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|gbraid|wbraid|mc_|igshid)/i.test(key)) {
      parsed.searchParams.delete(key)
    }
  }
  parsed.hash = ''
  return parsed.toString()
}

export function samePage(a: string, b: string): boolean {
  try {
    return stripTrackingParams(a) === stripTrackingParams(b)
  } catch {
    return a === b
  }
}

export async function resolveSourceUrl(input: string, log: Logger): Promise<ResolvedUrl> {
  const requested = ensureAbsoluteUrl(input)
  const parsed = new URL(requested)

  log.info(
    'Normalized the client URL. If a scheme was missing it was assumed to be https. Next the server will follow HTTP redirects so shorteners like loom.ly resolve to the real posting.',
    {
      original_input: input,
      requested,
      host: parsed.hostname,
      path: parsed.pathname,
    },
  )

  const hops: ResolvedUrl['hops'] = []
  let current = requested

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const startedAt = performance.now()
    let res: Response

    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
    } catch (err) {
      log.warn(
        'Direct fetch used to resolve redirects failed. Firecrawl will be asked to scrape this URL and follow redirects itself.',
        {
          url: current,
          elapsed_ms: elapsedMs(startedAt),
          error: err instanceof Error ? err.message : String(err),
        },
      )
      break
    }

    void res.body?.cancel()

    const location = res.headers.get('location')
    log.info('Inspected the HTTP response while resolving the source URL.', {
      url: current,
      status: res.status,
      status_text: res.statusText,
      location: location ?? null,
      content_type: res.headers.get('content-type'),
      elapsed_ms: elapsedMs(startedAt),
      hop_index: i,
    })

    if (location && res.status >= 300 && res.status < 400) {
      const next = new URL(location, current).href
      hops.push({ status: res.status, from: current, to: next })
      log.info('Following an HTTP redirect to the next location.', {
        status: res.status,
        from: current,
        to: next,
      })
      current = next
      continue
    }

    break
  }

  if (hops.length > 0) {
    log.info('Redirect chain finished. Later scrape and platform detection will use the canonical URL, not the short link.', {
      hop_count: hops.length,
      requested,
      canonical: current,
      hops,
    })
  } else {
    log.info('No HTTP redirects were returned. Scraping the requested URL as given.', {
      canonical: current,
    })
  }

  const canonical = stripTrackingParams(current)
  if (canonical !== current) {
    log.info('Removed tracking query parameters from the canonical URL.', {
      before: current,
      after: canonical,
    })
  }

  return { requested, canonical, hops }
}
