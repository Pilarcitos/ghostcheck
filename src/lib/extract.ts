import { createHash } from 'node:crypto'
import { detectPlatform } from './platform'
import { fetchMarkdown } from './firecrawl'
import { extractedFieldsSchema, jobSchema, type ExtractedFields, type Job } from '../schema'
import { elapsedMs, type Logger } from './logger'
import { resolveSourceUrl } from './resolveUrl'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    company: { type: 'STRING' },
    department_team: { type: 'STRING', nullable: true },
    seniority: {
      type: 'STRING',
      nullable: true,
      enum: ['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director', 'exec'],
    },
    employment_type: {
      type: 'STRING',
      enum: ['full_time', 'part_time', 'contract', 'internship', 'temp'],
    },
    location: {
      type: 'OBJECT',
      properties: {
        raw: { type: 'STRING' },
        city: { type: 'STRING', nullable: true },
        state: { type: 'STRING', nullable: true },
        country: { type: 'STRING', nullable: true },
        remote_type: {
          type: 'STRING',
          enum: ['onsite', 'hybrid', 'remote', 'remote_region_restricted'],
        },
      },
      required: ['raw', 'city', 'state', 'country', 'remote_type'],
    },
    compensation: {
      type: 'OBJECT',
      properties: {
        min: { type: 'NUMBER', nullable: true },
        max: { type: 'NUMBER', nullable: true },
        currency: { type: 'STRING', nullable: true },
        period: { type: 'STRING', nullable: true, enum: ['year', 'month', 'week', 'hour'] },
        raw: { type: 'STRING', nullable: true },
      },
      required: ['min', 'max', 'currency', 'period', 'raw'],
    },
    requirements: {
      type: 'OBJECT',
      properties: {
        required: { type: 'ARRAY', items: { type: 'STRING' } },
        preferred: { type: 'ARRAY', items: { type: 'STRING' } },
        years_experience_min: { type: 'NUMBER', nullable: true },
        degree: {
          type: 'STRING',
          enum: ['none_stated', 'bachelors', 'masters', 'phd', 'equivalent_experience_ok'],
        },
        tech_stack: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['required', 'preferred', 'years_experience_min', 'degree', 'tech_stack'],
    },
    visa_sponsorship: { type: 'STRING', enum: ['yes', 'no', 'unclear'] },
    application_deadline: { type: 'STRING', nullable: true },
    apply_url: { type: 'STRING' },
    benefits: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'title',
    'company',
    'department_team',
    'seniority',
    'employment_type',
    'location',
    'compensation',
    'requirements',
    'visa_sponsorship',
    'application_deadline',
    'apply_url',
    'benefits',
  ],
} as const

const EXTRACTION_PROMPT = `Extract structured job posting fields from this page.

Rules:
- Use only the job posting. Ignore application-form questions, EEO self-identification, cookie banners, and "fetching your LinkedIn profile" widgets.
- Do not invent requirements, pay, or benefits that are not on the page.
- If pay is listed per week, set compensation.period to "week". Per month -> "month". Per hour -> "hour". Salary / per year -> "year".
- application_deadline must be YYYY-MM-DD when a due date is stated, otherwise null.
- apply_url must be an absolute http(s) URL. If the page only has a relative apply link, use the source URL.
- For internships, employment_type is "internship" and seniority is "intern" unless the posting clearly says otherwise.
- Eligibility rules (citizenship, age range, driver's license, background check) belong in requirements.required.`

type GeminiGenerateResponse = {
  candidates?: Array<{
    finishReason?: string
    content?: { parts?: Array<{ text?: string }> }
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string; status?: string }
}

function parseExtractedFields(raw: unknown, fallbackApplyUrl: string, log: Logger): ExtractedFields {
  const first = extractedFieldsSchema.safeParse(raw)
  if (first.success) {
    log.info('Gemini JSON matched the extraction schema on the first parse.', {
      title: first.data.title,
      company: first.data.company,
      employment_type: first.data.employment_type,
      seniority: first.data.seniority,
      apply_url: first.data.apply_url,
    })
    return first.data
  }

  const issues = first.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  log.warn('Gemini JSON did not match the schema. Attempting to replace apply_url with the canonical source URL and parse again.', {
    issue_count: issues.length,
    issues,
  })

  if (raw && typeof raw === 'object') {
    const patched = { ...(raw as Record<string, unknown>), apply_url: fallbackApplyUrl }
    const second = extractedFieldsSchema.safeParse(patched)
    if (second.success) {
      log.info('Schema parse succeeded after substituting the canonical source URL as apply_url.', {
        apply_url: fallbackApplyUrl,
      })
      return second.data
    }

    const retryIssues = second.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    log.error('Schema parse still failed after the apply_url fallback.', {
      issue_count: retryIssues.length,
      issues: retryIssues,
    })
  }

  throw new Error(`Gemini extraction failed schema validation: ${issues.join('; ')}`)
}

async function extractFields(markdown: string, sourceUrl: string, log: Logger): Promise<ExtractedFields> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    log.error('Cannot call Gemini because GEMINI_API_KEY is missing from the environment.')
    throw new Error('GEMINI_API_KEY is not set')
  }

  const prompt = `${EXTRACTION_PROMPT}\n\nSource URL: ${sourceUrl}\n\nPage markdown:\n${markdown}`

  log.info(
    'Calling Gemini to map page markdown onto the job schema. The model is forced to return JSON that matches responseSchema.',
    {
      model: GEMINI_MODEL,
      endpoint: GEMINI_API_URL,
      prompt_chars: prompt.length,
      markdown_chars: markdown.length,
      max_output_tokens: 4096,
    },
  )

  const startedAt = performance.now()
  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
        maxOutputTokens: 4096,
      },
    }),
  })

  const rawBody = await res.text()
  log.info('Received an HTTP response from Gemini.', {
    status: res.status,
    status_text: res.statusText,
    elapsed_ms: elapsedMs(startedAt),
    body_bytes: rawBody.length,
  })

  if (!res.ok) {
    log.error('Gemini rejected the generateContent request.', {
      status: res.status,
      body: rawBody,
    })
    throw new Error(`Gemini API request failed (${res.status}): ${rawBody}`)
  }

  let data: GeminiGenerateResponse
  try {
    data = JSON.parse(rawBody) as GeminiGenerateResponse
  } catch (err) {
    log.error('Gemini returned a non-JSON HTTP body.', {
      parse_error: err instanceof Error ? err.message : String(err),
      body: rawBody,
    })
    throw new Error('Gemini returned invalid JSON')
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  const finishReason = data.candidates?.[0]?.finishReason ?? null

  log.info('Parsed the Gemini generateContent payload.', {
    finish_reason: finishReason,
    has_text: Boolean(text),
    text_chars: text?.length ?? 0,
    prompt_tokens: data.usageMetadata?.promptTokenCount ?? null,
    output_tokens: data.usageMetadata?.candidatesTokenCount ?? null,
    total_tokens: data.usageMetadata?.totalTokenCount ?? null,
    api_error: data.error?.message ?? null,
  })

  if (!text) {
    log.error('Gemini did not return a text part containing JSON. Extraction cannot continue.')
    throw new Error('Gemini did not return a structured extraction')
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(text)
  } catch (err) {
    log.error('Gemini text part was not valid JSON.', {
      parse_error: err instanceof Error ? err.message : String(err),
      text,
    })
    throw new Error('Gemini returned non-JSON structured output')
  }

  log.info('Gemini returned JSON. Validating it against the Zod extraction schema.', {
    top_level_keys: parsedJson && typeof parsedJson === 'object' ? Object.keys(parsedJson as object) : [],
  })

  return parseExtractedFields(parsedJson, sourceUrl, log)
}

export async function extractJob(url: string, log: Logger): Promise<Job> {
  const pipelineStartedAt = performance.now()
  log.info(
    'Starting job extraction. Steps: normalize URL, follow redirects, scrape markdown, extract fields with Gemini, validate the final job object.',
    { client_url: url },
  )

  const resolved = await resolveSourceUrl(url, log.child('url'))
  const scrapeUrl = resolved.canonical
  const platform = detectPlatform(scrapeUrl)

  log.info('Detected the hiring platform from the canonical hostname. This value is set by our code, not by Gemini.', {
    canonical_url: scrapeUrl,
    source_platform: platform,
    redirect_hops: resolved.hops.length,
  })

  const markdown = await fetchMarkdown(scrapeUrl, log.child('firecrawl'))
  const hash = createHash('sha256').update(markdown).digest('hex')
  log.info('Computed a SHA-256 hash of the scraped markdown so identical page bodies can be compared later.', {
    raw_description_hash: hash,
  })

  const fields = await extractFields(markdown, scrapeUrl, log.child('gemini'))

  const job: Job = {
    ...fields,
    url: scrapeUrl,
    source_platform: platform,
    scraped_at: new Date().toISOString(),
    raw_description_hash: hash,
  }

  log.info('Assembled the job object. Running a final Zod parse of the full job schema.', {
    title: job.title,
    company: job.company,
    source_platform: job.source_platform,
    employment_type: job.employment_type,
    seniority: job.seniority,
    location: job.location,
    compensation: job.compensation,
    required_count: job.requirements.required.length,
    preferred_count: job.requirements.preferred.length,
    benefits_count: job.benefits.length,
    visa_sponsorship: job.visa_sponsorship,
    application_deadline: job.application_deadline,
  })

  const parsed = jobSchema.parse(job)
  log.info('Extraction pipeline finished successfully.', {
    total_elapsed_ms: elapsedMs(pipelineStartedAt),
    url: parsed.url,
    title: parsed.title,
    company: parsed.company,
  })

  return parsed
}
