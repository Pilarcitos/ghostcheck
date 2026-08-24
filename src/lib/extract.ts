import { createHash } from 'node:crypto'
import { detectPlatform } from './platform'
import { fetchMarkdown } from './firecrawl'
import { extractedFieldsSchema, jobSchema, type Job } from '../schema'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

// Gemini structured-output schema (OpenAPI-style). `nullable: true` is how
// Gemini represents optional/unknown fields instead of type: ['string', 'null'].
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
        period: { type: 'STRING', nullable: true, enum: ['year', 'hour'] },
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

async function extractFields(markdown: string, sourceUrl: string) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Extract structured job posting fields from this page content. Source URL: ${sourceUrl}\n\n${markdown}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
        maxOutputTokens: 4096,
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini API request failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    throw new Error('Gemini did not return a structured extraction')
  }

  return extractedFieldsSchema.parse(JSON.parse(text))
}

export async function extractJob(url: string): Promise<Job> {
  const markdown = await fetchMarkdown(url)
  const fields = await extractFields(markdown, url)

  const job: Job = {
    ...fields,
    url,
    source_platform: detectPlatform(url),
    scraped_at: new Date().toISOString(),
    raw_description_hash: createHash('sha256').update(markdown).digest('hex'),
  }

  return jobSchema.parse(job)
}
