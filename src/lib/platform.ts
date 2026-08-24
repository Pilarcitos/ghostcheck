export type SourcePlatform =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'linkedin'
  | 'indeed'
  | 'generic'

export function detectPlatform(url: string): SourcePlatform {
  const host = new URL(url).hostname.replace(/^www\./, '')

  if (host.includes('greenhouse.io')) return 'greenhouse'
  if (host.includes('lever.co')) return 'lever'
  if (host.includes('ashbyhq.com')) return 'ashby'
  if (host.includes('myworkdayjobs.com') || host.includes('workday.com')) return 'workday'
  if (host.includes('linkedin.com')) return 'linkedin'
  if (host.includes('indeed.com')) return 'indeed'

  return 'generic'
}
