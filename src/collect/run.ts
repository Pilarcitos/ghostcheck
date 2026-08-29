import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { elapsedMs, rootLogger, type Logger } from '../lib/logger'
import {
  extractCandidateUrls,
  extractInstagramPosts,
  extractLinksFromHtmlDump,
  type FoundPost,
} from './parseHtml'
import {
  captionTextsFromMedia,
  fetchInstagramPost,
  mediaFromResponse,
} from './scrapecreators'

export type CollectedLink = {
  url: string
  from: string
  postUrl: string | null
}

export type PostResult = {
  postUrl: string
  shortcode: string
  kind: 'p' | 'reel'
  caption: string | null
  links: CollectedLink[]
  error: string | null
}

export type CollectedFile = {
  collected_at: string
  inputs: string[]
  dry_run: boolean
  post_count: number
  posts: PostResult[]
  links: CollectedLink[]
}

function printUsage(): never {
  console.log(`Usage:
  bun run scripts/collect-links.ts <html-file-or-instagram-url> [--out data/collected-links.json] [--dry-run]

This is a link collector only. It does not call Ghostcheck extract.

1. Pass an Instagram HTML dump or a single post/reel URL. The dump is input only; it is not stored.
2. The script finds instagram.com/p/... and /reel/... URLs.
3. Each item is fetched with ScrapeCreators for caption and accessibility/alt text. Reel video is not downloaded or transcribed.
4. Destination links are merged into one JSON at --out (default data/collected-links.json). Re-runs append into that same file.

Examples:
  bun run collect:links -- data/ig-dump.html
  bun run collect:links -- https://www.instagram.com/reel/SHORTCODE/
  bun run collect:links -- data/ig-dump.html --dry-run
`)
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : 'data/collected-links.json'
  const dryRun = argv.includes('--dry-run')
  const positional = argv.filter((arg, i) => {
    if (arg === '--dry-run') return false
    if (arg === '--out') return false
    if (outIndex >= 0 && i === outIndex + 1) return false
    return true
  })
  const input = positional[0]
  return { input, outPath, dryRun }
}

async function loadInput(input: string, log: Logger): Promise<{ html: string; directPosts: FoundPost[] }> {
  if (/^https?:\/\//i.test(input) && /instagram\.com\/(p|reel|reels|tv)\//i.test(input)) {
    log.info('Input is a single Instagram post URL. Skipping HTML parse.', { input })
    const posts = extractInstagramPosts(input)
    return { html: '', directPosts: posts }
  }

  const path = resolve(input)
  if (!existsSync(path)) {
    log.error('The HTML dump file does not exist.', { path })
    printUsage()
  }

  log.info('Reading the input file. Post URLs will be parsed from HTML hrefs and raw text.', { path })
  const html = await readFile(path, 'utf8')
  log.info('Finished reading the input file.', { path, bytes: html.length })
  return { html, directPosts: [] }
}

const SOURCE_RANK: Record<string, number> = {
  caption: 0,
  accessibility_caption: 1,
  img_alt: 2,
  html_dump: 3,
}

function sourceRank(from: string): number {
  if (from in SOURCE_RANK) return SOURCE_RANK[from]
  if (from.startsWith('carousel')) return 1
  return 9
}

function stripInvisible(value: string): string {
  return value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
}

export function canonicalizeLinkUrl(url: string): string {
  try {
    const parsed = new URL(stripInvisible(url))
    if (parsed.protocol === 'mailto:') {
      parsed.pathname = parsed.pathname.toLowerCase()
      return parsed.toString()
    }
    parsed.protocol = 'https:'
    parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase()
    try {
      parsed.pathname = stripInvisible(decodeURIComponent(parsed.pathname))
    } catch {
      parsed.pathname = stripInvisible(parsed.pathname)
    }
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function linkDedupeKey(url: string): string {
  return canonicalizeLinkUrl(url).toLowerCase().replace(/\/$/, '')
}

export function uniqueLinks(links: CollectedLink[]): CollectedLink[] {
  const best = new Map<string, CollectedLink>()
  for (const link of links) {
    const canonical = canonicalizeLinkUrl(link.url)
    const key = linkDedupeKey(canonical)
    const candidate: CollectedLink = { ...link, url: canonical }
    const existing = best.get(key)
    if (!existing || sourceRank(candidate.from) < sourceRank(existing.from)) {
      best.set(key, candidate)
    }
  }
  return [...best.values()]
}

function asPostResult(post: Partial<PostResult> & { shortcode: string; postUrl: string }): PostResult {
  return {
    postUrl: post.postUrl,
    shortcode: post.shortcode,
    kind: post.kind === 'reel' ? 'reel' : 'p',
    caption: post.caption ?? null,
    links: post.links ?? [],
    error: post.error ?? null,
  }
}

export function mergePosts(existing: PostResult[], incoming: PostResult[]): PostResult[] {
  const byCode = new Map<string, PostResult>()
  for (const post of existing) byCode.set(post.shortcode, asPostResult(post))

  for (const raw of incoming) {
    const post = asPostResult(raw)
    const prev = byCode.get(post.shortcode)
    if (!prev) {
      byCode.set(post.shortcode, post)
      continue
    }
    if (post.error && !prev.error) {
      byCode.set(post.shortcode, {
        ...prev,
        kind: prev.kind === 'reel' || post.kind === 'reel' ? 'reel' : prev.kind,
        links: uniqueLinks([...prev.links, ...post.links]),
      })
      continue
    }
    byCode.set(post.shortcode, {
      ...post,
      kind: prev.kind === 'reel' || post.kind === 'reel' ? 'reel' : post.kind,
      caption: post.caption ?? prev.caption,
      links: uniqueLinks([...prev.links, ...post.links]),
      error: post.error ?? prev.error,
    })
  }

  return [...byCode.values()]
}

export function mergeCollectedFiles(base: CollectedFile | null, next: CollectedFile): CollectedFile {
  const posts = mergePosts(base?.posts ?? [], next.posts)
  const links = uniqueLinks([...(base?.links ?? []), ...next.links, ...posts.flatMap((post) => post.links)])
  const inputs = [...new Set([...(base?.inputs ?? []), ...next.inputs])]
  return {
    collected_at: next.collected_at,
    inputs,
    dry_run: Boolean(base?.dry_run && next.dry_run),
    post_count: posts.length,
    posts,
    links,
  }
}

async function loadExisting(outPath: string): Promise<CollectedFile | null> {
  const resolved = resolve(outPath)
  if (!existsSync(resolved)) return null
  try {
    const raw = JSON.parse(await readFile(resolved, 'utf8')) as CollectedFile & { input?: string }
    const inputs = raw.inputs ?? (raw.input ? [raw.input] : [])
    return {
      collected_at: raw.collected_at,
      inputs,
      dry_run: Boolean(raw.dry_run),
      post_count: raw.posts?.length ?? 0,
      posts: (raw.posts ?? []).map(asPostResult),
      links: raw.links ?? [],
    }
  } catch {
    return null
  }
}

export async function collectLinks(argv: string[]) {
  const { input, outPath, dryRun } = parseArgs(argv)
  if (!input) printUsage()

  const log = rootLogger.child('collect')
  log.banner('collect links', `${input}${dryRun ? '  (dry-run)' : ''}`)
  const startedAt = performance.now()
  const { html, directPosts } = await loadInput(input, log)

  const postsFromHtml = html ? extractInstagramPosts(html) : []
  const posts = [...directPosts, ...postsFromHtml].filter(
    (post, index, all) => all.findIndex((other) => other.shortcode === post.shortcode) === index,
  )

  const htmlLinks = html ? extractLinksFromHtmlDump(html) : []

  log.info('Parsed Instagram post URLs from the input.', {
    post_count: posts.length,
    reel_count: posts.filter((post) => post.kind === 'reel').length,
    html_outbound_link_count: htmlLinks.length,
    dry_run: dryRun,
  })

  if (posts.length === 0 && htmlLinks.length === 0) {
    log.error('No Instagram post URLs or outbound http(s) links were found in the input.')
    process.exit(1)
  }

  const postResults: PostResult[] = []
  const collected: CollectedLink[] = [...htmlLinks]
  const apiKey = process.env.SCRAPECREATORS_API_KEY

  if (dryRun) {
    log.info('Dry run. Not calling ScrapeCreators. Reporting post URLs found in the dump only.', {
      post_urls: posts.map((post) => post.postUrl),
    })
    for (const post of posts) {
      postResults.push({
        postUrl: post.postUrl,
        shortcode: post.shortcode,
        kind: post.kind,
        caption: null,
        links: [],
        error: null,
      })
    }
  } else if (!apiKey) {
    log.warn(
      'SCRAPECREATORS_API_KEY is not set. Post captions will not be fetched. Add the key to .env and re-run to collect links from descriptions.',
    )
  } else {
    for (const [index, post] of posts.entries()) {
      const postLog = log.child('post', {
        post_url: post.postUrl,
        kind: post.kind,
        index: index + 1,
        of: posts.length,
      })
      postLog.section(`post ${index + 1} of ${posts.length}  ${post.kind}  ${post.shortcode}`)
      if (post.kind === 'reel') {
        postLog.info(
          'This is a reel. Collecting caption and accessibility text only. The video is not downloaded, played, or transcribed.',
        )
      } else {
        postLog.info('Collecting destination links from this Instagram post.')
      }
      try {
        const data = await fetchInstagramPost(post.postUrl, apiKey, postLog)
        const media = mediaFromResponse(data)
        if (!media) {
          postLog.warn('ScrapeCreators JSON did not include xdt_shortcode_media. Skipping caption parse.', {
            post_url: post.postUrl,
            likely_cause: 'The lookup succeeded but the payload had no media object. The shortcode may be private, deleted, or an unsupported reel/audio URL.',
          })
          postResults.push({
            postUrl: post.postUrl,
            shortcode: post.shortcode,
            kind: post.kind,
            caption: null,
            links: [],
            error: 'missing media object',
          })
          continue
        }

        const texts = captionTextsFromMedia(media)
        const caption = texts.find((hit) => hit.source === 'caption')?.text ?? null
        const links: CollectedLink[] = []
        for (const hit of texts) {
          for (const url of extractCandidateUrls(hit.text)) {
            links.push({ url, from: hit.source, postUrl: post.postUrl })
          }
        }

        postLog.info('Finished reading this post.', {
          caption_chars: caption?.length ?? 0,
          text_sources: texts.map((hit) => hit.source),
          link_count: links.length,
          links: links.map((link) => link.url),
        })

        if (links.length === 0) {
          postLog.info(
            'No http(s) links or emails in the caption or accessibility text. A URL printed only as pixels on the photo or spoken only in a reel is still not OCR-read or transcribed; img alt text from the HTML dump is collected separately.',
          )
        }

        if (index < posts.length - 1) {
          await Bun.sleep(300)
        }

        postResults.push({
          postUrl: post.postUrl,
          shortcode: post.shortcode,
          kind: post.kind,
          caption,
          links,
          error: null,
        })
        collected.push(...links)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        postLog.error('Failed to collect links from this post.', {
          error_message: message,
          post_url: post.postUrl,
          shortcode: post.shortcode,
          likely_cause: 'ScrapeCreators lookup or JSON parse failed for this shortcode. Caption and links for this post were skipped; collection continues.',
        })
        postResults.push({
          postUrl: post.postUrl,
          shortcode: post.shortcode,
          kind: post.kind,
          caption: null,
          links: [],
          error: message,
        })
      }
    }
  }

  const incoming: CollectedFile = {
    collected_at: new Date().toISOString(),
    inputs: [input],
    dry_run: dryRun,
    post_count: postResults.length,
    posts: postResults,
    links: uniqueLinks(collected),
  }

  const existing = await loadExisting(outPath)
  const payload = mergeCollectedFiles(existing, incoming)

  const resolvedOut = resolve(outPath)
  await mkdir(resolve(resolvedOut, '..'), { recursive: true })
  await writeFile(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  log.banner(
    'collect done',
    `${payload.links.length} unique links  ·  ${payload.post_count} posts  ·  ${elapsedMs(startedAt)}ms`,
  )
  log.info('Link collection finished. Ghostcheck extract was not called. All links live in this one JSON.', {
    out_path: resolvedOut,
    unique_link_count: payload.links.length,
    post_count: payload.post_count,
    merged_existing: Boolean(existing),
    links: payload.links,
  })
}
