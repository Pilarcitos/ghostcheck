import type { Logger } from '../lib/logger'
import { elapsedMs } from '../lib/logger'

const POST_INFO_URL = 'https://api.scrapecreators.com/v1/instagram/post'

export type InstagramMedia = {
  shortcode?: string
  accessibility_caption?: string | null
  edge_media_to_caption?: {
    edges?: Array<{ node?: { text?: string } }>
  }
  edge_sidecar_to_children?: {
    edges?: Array<{ node?: InstagramMedia }>
  }
}

export type ScrapeCreatorsPostResponse = {
  data?: {
    xdt_shortcode_media?: InstagramMedia
  }
  xdt_shortcode_media?: InstagramMedia
}

export type CaptionText = {
  source: string
  text: string
}

export async function fetchInstagramPost(
  postUrl: string,
  apiKey: string,
  log: Logger,
): Promise<ScrapeCreatorsPostResponse> {
  const endpoint = `${POST_INFO_URL}?url=${encodeURIComponent(postUrl)}`
  log.info(
    'Requesting public Instagram post details from ScrapeCreators. This call is for caption and alt text only; media is not downloaded.',
    { post_url: postUrl, endpoint: POST_INFO_URL },
  )

  const startedAt = performance.now()
  const res = await fetch(endpoint, {
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
  })
  const rawBody = await res.text()

  log.info('Received an HTTP response from ScrapeCreators.', {
    status: res.status,
    status_text: res.statusText,
    elapsed_ms: elapsedMs(startedAt),
    body_bytes: rawBody.length,
  })

  if (!res.ok) {
    log.error('ScrapeCreators rejected the post lookup.', {
      status: res.status,
      status_text: res.statusText,
      elapsed_ms: elapsedMs(startedAt),
      post_url: postUrl,
      body: rawBody,
      likely_cause:
        res.status === 401 || res.status === 403
          ? 'SCRAPECREATORS_API_KEY was rejected.'
          : res.status === 429
            ? 'ScrapeCreators rate limited this lookup.'
            : 'ScrapeCreators HTTP error. Body is dumped above.',
    })
    throw new Error(`ScrapeCreators request failed (${res.status}): ${rawBody}`)
  }

  try {
    return JSON.parse(rawBody) as ScrapeCreatorsPostResponse
  } catch (err) {
    log.error('ScrapeCreators returned a non-JSON body.', {
      parse_error: err instanceof Error ? err.message : String(err),
      body: rawBody,
    })
    throw new Error('ScrapeCreators returned invalid JSON')
  }
}

export function mediaFromResponse(data: ScrapeCreatorsPostResponse): InstagramMedia | null {
  return data.data?.xdt_shortcode_media ?? data.xdt_shortcode_media ?? null
}

export function captionTextsFromMedia(media: InstagramMedia): CaptionText[] {
  const hits: CaptionText[] = []
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text
  if (caption?.trim()) hits.push({ source: 'caption', text: caption })
  if (media.accessibility_caption?.trim()) {
    hits.push({ source: 'accessibility_caption', text: media.accessibility_caption })
  }

  const children = media.edge_sidecar_to_children?.edges ?? []
  children.forEach((edge, index) => {
    const child = edge.node
    if (!child) return
    if (child.accessibility_caption?.trim()) {
      hits.push({
        source: `carousel[${index}].accessibility_caption`,
        text: child.accessibility_caption,
      })
    }
  })

  return hits
}
