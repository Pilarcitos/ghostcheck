import { generateJson } from './gemini'
import type { ScrapeResult } from './firecrawl'
import type { Logger } from './logger'
import { samePage, stripTrackingParams } from './resolveUrl'

export const PAGE_KINDS = ['posting', 'listing', 'apply_form', 'gateway', 'blocked'] as const
export type PageKind = (typeof PAGE_KINDS)[number]

export type PageClassification = {
  kind: PageKind
  reason: string
  nextUrl: string | null
}

const CLASSIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: {
      type: 'STRING',
      enum: ['posting', 'listing', 'apply_form', 'gateway', 'blocked'],
    },
    reason: { type: 'STRING' },
    next_url: { type: 'STRING', nullable: true },
  },
  required: ['kind', 'reason', 'next_url'],
} as const

const BLOCKED_STATUS = new Set([401, 403, 404, 410, 451])
const BLOCKED_TEXT =
  /\b(sign in|log in|login|access denied|not found|page not found|403|401|captcha|verify you are human|enable javascript)\b/i

function heuristicBlocked(page: ScrapeResult): PageClassification | null {
  if (page.statusCode !== null && BLOCKED_STATUS.has(page.statusCode)) {
    return {
      kind: 'blocked',
      reason: `The scrape reported HTTP ${page.statusCode}, which is not a readable job posting.`,
      nextUrl: null,
    }
  }

  if (page.markdown.trim().length < 160 && BLOCKED_TEXT.test(page.markdown)) {
    return {
      kind: 'blocked',
      reason: 'The page body is too short and looks like a login wall, 404, or bot check.',
      nextUrl: null,
    }
  }

  return null
}

function normalizeNextUrl(candidate: string | null, pageUrl: string, links: string[]): string | null {
  if (!candidate || !candidate.trim()) return null

  let absolute: string
  try {
    absolute = stripTrackingParams(new URL(candidate.trim(), pageUrl).href)
  } catch {
    return null
  }

  if (!/^https?:\/\//i.test(absolute)) return null
  if (samePage(absolute, pageUrl)) return null

  const match = links.find((link) => {
    try {
      return samePage(link, absolute)
    } catch {
      return false
    }
  })

  return match ? stripTrackingParams(match) : absolute
}

export async function classifyPage(page: ScrapeResult, log: Logger): Promise<PageClassification> {
  const blocked = heuristicBlocked(page)
  if (blocked) {
    log.info('Classified the page with a local heuristic before calling Gemini.', {
      kind: blocked.kind,
      reason: blocked.reason,
      status_code: page.statusCode,
      markdown_chars: page.markdown.length,
    })
    return blocked
  }

  const linkSample = page.links.slice(0, 40)
  const prompt = `Classify this fetched page. It was reached from a URL that might or might not already be a job posting.

kind must be exactly one of:
- posting: the main content is a single job description (duties, qualifications, pay, location).
- listing: a job board, search results, or company careers index with multiple jobs. Do not pick one of them.
- apply_form: an application form is prominent, but a job description is also on the page.
- gateway: this is not the posting. It points at one job URL (share card, "view job", "apply on company site", interstitial). Set next_url to that absolute http(s) URL.
- blocked: login wall, 404, empty shell, captcha. next_url must be null.

Rules:
- If many job links are present and there is no single detailed description, kind is listing and next_url is null.
- If kind is gateway, next_url must be an absolute URL from the page or the link list. Do not invent hosts.
- Do not use kind=gateway just because the page has an Apply button on a real posting.

Page URL: ${page.url}
Page title: ${page.title ?? '(none)'}
HTTP status from scrape: ${page.statusCode ?? '(unknown)'}
Outbound links (sample): ${JSON.stringify(linkSample)}

Page markdown:
${page.markdown}`

  log.info('Asking Gemini to classify the page kind so the pipeline can hop or stop.', {
    url: page.url,
    markdown_chars: page.markdown.length,
    link_count: page.links.length,
  })

  const raw = await generateJson({
    prompt,
    schema: CLASSIFY_SCHEMA,
    maxOutputTokens: 512,
    log: log.child('gemini'),
  })

  const parsed = raw as { kind?: string; reason?: string; next_url?: string | null }
  const kind = PAGE_KINDS.includes(parsed.kind as PageKind) ? (parsed.kind as PageKind) : 'posting'
  const nextUrl = kind === 'gateway' ? normalizeNextUrl(parsed.next_url ?? null, page.url, page.links) : null

  if (kind === 'gateway' && !nextUrl) {
    log.warn(
      'Gemini labeled the page as a gateway but did not provide a usable next URL. Treating it as a posting so extraction can still run if the description is on this page.',
      { claimed_next_url: parsed.next_url ?? null },
    )
    return {
      kind: 'posting',
      reason: `${parsed.reason ?? 'gateway without next_url'}; falling back to posting because no followable URL was found.`,
      nextUrl: null,
    }
  }

  const result: PageClassification = {
    kind,
    reason: parsed.reason?.trim() || 'Gemini returned no reason.',
    nextUrl,
  }

  log.info('Page classification finished.', {
    kind: result.kind,
    reason: result.reason,
    next_url: result.nextUrl,
  })

  return result
}
