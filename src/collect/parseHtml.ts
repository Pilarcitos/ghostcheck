const IG_POST_RE =
  /(?:https?:\/\/(?:www\.)?)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/gi

const IG_RELATIVE_POST_RE = /(?:href=["']|["'])?\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/gi

const HTTP_URL_RE = /https?:\/\/[^\s<>"'`\\]+/gi

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

const BARE_WEB_RE =
  /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z]{2,})+(?:\/[a-z0-9._~/-]*)?/gi

const SKIP_HOST =
  /(^|\.)instagram\.com$|(^|\.)cdninstagram\.com$|(^|\.)facebook\.com$|(^|\.)fbcdn\.net$|(^|\.)threads\.net$|(^|\.)fb\.com$/i

export type FoundPost = {
  shortcode: string
  postUrl: string
  kind: 'p' | 'reel'
}

export type DumpLink = {
  url: string
  from: string
  postUrl: string | null
}

export function canonicalPostUrl(kind: 'p' | 'reel', shortcode: string): string {
  const path = kind === 'reel' ? 'reel' : 'p'
  return `https://www.instagram.com/${path}/${shortcode}/`
}

const RESERVED_SHORTCODES = new Set([
  'audio',
  'comments',
  'embed',
  'highlights',
  'insights',
  'liked_by',
  'share',
  'stories',
  'tagged',
])

function isRealShortcode(shortcode: string): boolean {
  if (shortcode.length < 8) return false
  return !RESERVED_SHORTCODES.has(shortcode.toLowerCase())
}

export function extractInstagramPosts(html: string): FoundPost[] {
  const byCode = new Map<string, FoundPost>()

  const add = (rawKind: string, shortcode: string) => {
    if (!isRealShortcode(shortcode)) return
    const kind: 'p' | 'reel' = rawKind.toLowerCase() === 'p' ? 'p' : 'reel'
    const existing = byCode.get(shortcode)
    if (!existing) {
      byCode.set(shortcode, {
        shortcode,
        kind,
        postUrl: canonicalPostUrl(kind, shortcode),
      })
      return
    }
    // Instagram often lists both /p/SHORTCODE and /reels/SHORTCODE. Prefer reel.
    if (existing.kind === 'p' && kind === 'reel') {
      byCode.set(shortcode, {
        shortcode,
        kind: 'reel',
        postUrl: canonicalPostUrl('reel', shortcode),
      })
    }
  }

  for (const match of html.matchAll(IG_POST_RE)) {
    add(match[1], match[2])
  }
  for (const match of html.matchAll(IG_RELATIVE_POST_RE)) {
    add(match[1], match[2])
  }

  return [...byCode.values()]
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.;:!?]+$/g, '')
}

function shouldSkipHost(host: string): boolean {
  return SKIP_HOST.test(host.replace(/^www\./, ''))
}

function normalizeCandidate(raw: string): string | null {
  let href = stripTrailingPunctuation(decodeHtmlEntities(raw).trim())
  if (!href) return null

  if (href.includes('@') && !href.includes('://') && !href.startsWith('mailto:')) {
    href = `mailto:${href.toLowerCase()}`
  }

  if (!/^https?:\/\//i.test(href) && !href.startsWith('mailto:')) {
    href = `https://${href}`
  }

  try {
    const parsed = new URL(href)
    if (parsed.protocol === 'mailto:') {
      return parsed.toString()
    }
    if (!/^https?:$/i.test(parsed.protocol)) return null
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    const host = parsed.hostname.replace(/^www\./, '')
    if (shouldSkipHost(host)) return null
    if (!/\.(com|org|net|edu|gov|io|ly|co)(?:$|\.)/i.test(host)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function extractCandidateUrls(text: string): string[] {
  const decoded = decodeHtmlEntities(text)
  const seen = new Set<string>()
  const urls: string[] = []

  const add = (raw: string) => {
    const normalized = normalizeCandidate(raw)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    urls.push(normalized)
  }

  for (const match of decoded.matchAll(HTTP_URL_RE)) add(match[0])
  for (const match of decoded.matchAll(EMAIL_RE)) add(match[0])
  for (const match of decoded.matchAll(BARE_WEB_RE)) {
    if (match[0].includes('@')) continue
    add(match[0])
  }

  return urls
}

export function extractHttpUrls(text: string): string[] {
  const decoded = decodeHtmlEntities(text)
  const seen = new Set<string>()
  const urls: string[] = []
  for (const match of decoded.matchAll(HTTP_URL_RE)) {
    const normalized = normalizeCandidate(match[0])
    if (!normalized || !normalized.startsWith('http') || seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }
  return urls
}

export function extractImgAltTexts(html: string): string[] {
  const alts: string[] = []
  for (const match of html.matchAll(/<img\b[^>]*\balt="([^"]*)"/gi)) {
    const alt = decodeHtmlEntities(match[1]).trim()
    if (alt) alts.push(alt)
  }
  return alts
}

export function extractLinksFromHtmlDump(html: string): DumpLink[] {
  const chunks = html.includes('<article') ? html.split(/<article\b/i) : [html]
  const links: DumpLink[] = []

  for (const chunk of chunks) {
    const posts = extractInstagramPosts(chunk)
    const postUrl = posts[0]?.postUrl ?? null

    for (const url of extractHttpUrls(chunk)) {
      links.push({ url, from: 'html_dump', postUrl })
    }
    for (const alt of extractImgAltTexts(chunk)) {
      for (const url of extractCandidateUrls(alt)) {
        links.push({ url, from: 'img_alt', postUrl })
      }
    }
  }

  return links
}
