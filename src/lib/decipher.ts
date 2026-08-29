import { classifyPage, type PageKind } from './classify'
import { scrapePage, type ScrapeResult } from './firecrawl'
import type { Logger } from './logger'
import { resolveSourceUrl, samePage, stripTrackingParams } from './resolveUrl'

const MAX_PAGE_HOPS = 4

export type DecipherKind = PageKind | 'hop_limit'

export class DecipherError extends Error {
  readonly kind: Exclude<DecipherKind, 'posting' | 'apply_form' | 'gateway'>
  readonly url: string
  readonly hops: string[]

  constructor(
    kind: Exclude<DecipherKind, 'posting' | 'apply_form' | 'gateway'>,
    message: string,
    url: string,
    hops: string[],
  ) {
    super(message)
    this.name = 'DecipherError'
    this.kind = kind
    this.url = url
    this.hops = hops
  }
}

export type DecipheredPosting = {
  kind: 'posting' | 'apply_form'
  page: ScrapeResult
  hops: string[]
  reason: string
}

export async function decipherToPosting(inputUrl: string, log: Logger): Promise<DecipheredPosting> {
  const httpResolved = await resolveSourceUrl(inputUrl, log.child('url'))
  const hops = [httpResolved.requested]
  if (!samePage(httpResolved.requested, httpResolved.canonical)) {
    hops.push(httpResolved.canonical)
  }

  let currentUrl = httpResolved.canonical
  const visited = new Set<string>(hops.map(stripTrackingParams))

  log.section('follow redirects')
  log.info(
    'Starting the decipherer loop. Each iteration scrapes one page, classifies it, and either stops on a posting or follows one in-page hop.',
    {
      start_url: currentUrl,
      http_redirect_hops: httpResolved.hops.length,
      max_page_hops: MAX_PAGE_HOPS,
    },
  )

  for (let i = 0; i < MAX_PAGE_HOPS; i++) {
    log.section(`scrape ${i + 1} of ${MAX_PAGE_HOPS}`)
    log.info('Decipherer scrape iteration.', {
      iteration: i + 1,
      url: currentUrl,
      visited_count: visited.size,
    })

    const page = await scrapePage(currentUrl, log.child('firecrawl'))
    const classification = await classifyPage(page, log.child('classify'))

    if (classification.kind === 'posting' || classification.kind === 'apply_form') {
      log.section('posting found — stop hopping')
      log.info('Decipherer found a page that contains a job description. Stopping hops and moving to extraction.', {
        kind: classification.kind,
        reason: classification.reason,
        url: page.url,
        hop_count: hops.length,
      })
      return {
        kind: classification.kind,
        page,
        hops,
        reason: classification.reason,
      }
    }

    if (classification.kind === 'listing') {
      throw new DecipherError(
        'listing',
        `This URL is a job listing or search page, not a single posting. ${classification.reason}`,
        page.url,
        hops,
      )
    }

    if (classification.kind === 'blocked') {
      throw new DecipherError(
        'blocked',
        `The page could not be read as a job posting. ${classification.reason}`,
        page.url,
        hops,
      )
    }

    const nextUrl = classification.nextUrl
    if (!nextUrl || samePage(nextUrl, currentUrl) || visited.has(stripTrackingParams(nextUrl))) {
      log.warn('Gateway hop was missing, circular, or already visited. Treating the current page as a posting.', {
        next_url: nextUrl,
        current_url: currentUrl,
      })
      return {
        kind: 'posting',
        page,
        hops,
        reason: classification.reason,
      }
    }

    log.section('in-page hop')
    log.info('Following an in-page hop to a better candidate URL.', {
      from: currentUrl,
      to: nextUrl,
      reason: classification.reason,
    })
    hops.push(nextUrl)
    visited.add(stripTrackingParams(nextUrl))
    currentUrl = nextUrl
  }

  throw new DecipherError(
    'hop_limit',
    `Stopped after ${MAX_PAGE_HOPS} page scrapes without finding a single job posting.`,
    currentUrl,
    hops,
  )
}
