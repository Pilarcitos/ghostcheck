import { createHash } from 'node:crypto'
import { detectPlatform } from './platform'
import { extractedFieldsSchema, jobSchema, type ExtractedFields, type Job } from '../schema'
import { elapsedMs, type Logger } from './logger'
import { generateJson } from './gemini'
import { DecipherError, decipherToPosting } from './decipher'
import type { PageKind } from './classify'

const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    company: { type: 'STRING' },
    description: { type: 'STRING' },
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
    'description',
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

function extractionPrompt(pageKind: PageKind | 'posting' | 'apply_form'): string {
  const formNote =
    pageKind === 'apply_form'
      ? '- This page mixes an application form with a job description. Use only the description. Ignore form fields, EEO self-ID, and "fetching LinkedIn" widgets.\n'
      : ''

  return `Extract structured fields from this job posting page.

Rules:
${formNote}- description is the posting's own writeup of the role: what the work is and what you would do. Plain prose, 1-4 paragraphs. Do not copy navigation, application questions, or EEO boilerplate.
- Do not invent requirements, pay, benefits, or duties that are not on the page.
- If pay is listed per week, set compensation.period to "week". Per month -> "month". Per hour -> "hour". Salary / per year -> "year".
- application_deadline must be YYYY-MM-DD when a due date is stated, otherwise null.
- apply_url must be an absolute http(s) URL. If the page only has a relative apply link, use the source URL.
- For internships, employment_type is "internship" and seniority is "intern" unless the posting clearly says otherwise.
- Eligibility rules (citizenship, age range, driver's license, background check) belong in requirements.required.`
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
      description_chars: first.data.description.length,
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

async function extractFields(
  markdown: string,
  sourceUrl: string,
  pageKind: 'posting' | 'apply_form',
  log: Logger,
): Promise<ExtractedFields> {
  const prompt = `${extractionPrompt(pageKind)}\n\nSource URL: ${sourceUrl}\n\nPage markdown:\n${markdown}`

  log.info('Calling Gemini to map the deciphered posting onto the job schema.', {
    page_kind: pageKind,
    prompt_chars: prompt.length,
    markdown_chars: markdown.length,
  })

  const parsedJson = await generateJson({
    prompt,
    schema: EXTRACTION_SCHEMA,
    maxOutputTokens: 4096,
    log,
  })

  log.info('Gemini returned JSON. Validating it against the Zod extraction schema.', {
    top_level_keys: parsedJson && typeof parsedJson === 'object' ? Object.keys(parsedJson as object) : [],
  })

  return parseExtractedFields(parsedJson, sourceUrl, log)
}

export type ExtractResult = {
  job: Job
  decipher: {
    kind: 'posting' | 'apply_form'
    hops: string[]
    reason: string
  }
}

export async function extractJob(url: string, log: Logger): Promise<ExtractResult> {
  const pipelineStartedAt = performance.now()
  log.section('pipeline')
  log.info(
    'Starting job extraction. Steps: decipher the link to a posting, extract fields with Gemini, validate the job object.',
    { client_url: url },
  )

  const posting = await decipherToPosting(url, log.child('decipher'))
  const scrapeUrl = posting.page.url
  const platform = detectPlatform(scrapeUrl)
  const markdown = posting.page.markdown
  const hash = createHash('sha256').update(markdown).digest('hex')

  log.info('Detected the hiring platform from the canonical hostname. This value is set by our code, not by Gemini.', {
    canonical_url: scrapeUrl,
    source_platform: platform,
    page_kind: posting.kind,
    hops: posting.hops,
  })
  log.info('Computed a SHA-256 hash of the scraped markdown so identical page bodies can be compared later.', {
    raw_description_hash: hash,
  })

  log.section('extract fields')
  const fields = await extractFields(markdown, scrapeUrl, posting.kind, log.child('gemini'))

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
    description_chars: job.description.length,
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

  return {
    job: parsed,
    decipher: {
      kind: posting.kind,
      hops: posting.hops,
      reason: posting.reason,
    },
  }
}

export { DecipherError }
