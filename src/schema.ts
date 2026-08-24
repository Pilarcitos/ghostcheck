import { z } from 'zod'

export const jobSchema = z.object({
  url: z.string().url(),
  source_platform: z.enum([
    'greenhouse',
    'lever',
    'ashby',
    'workday',
    'linkedin',
    'indeed',
    'generic',
  ]),
  scraped_at: z.string(),

  title: z.string(),
  company: z.string(),
  department_team: z.string().nullable(),
  seniority: z
    .enum(['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director', 'exec'])
    .nullable(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'internship', 'temp']),

  location: z.object({
    raw: z.string(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    remote_type: z.enum(['onsite', 'hybrid', 'remote', 'remote_region_restricted']),
  }),

  compensation: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.string().nullable(),
    period: z.enum(['year', 'hour']).nullable(),
    raw: z.string().nullable(),
  }),

  requirements: z.object({
    required: z.array(z.string()),
    preferred: z.array(z.string()),
    years_experience_min: z.number().nullable(),
    degree: z.enum(['none_stated', 'bachelors', 'masters', 'phd', 'equivalent_experience_ok']),
    tech_stack: z.array(z.string()),
  }),

  visa_sponsorship: z.enum(['yes', 'no', 'unclear']),
  application_deadline: z.string().nullable(),
  apply_url: z.string().url(),
  benefits: z.array(z.string()),
  raw_description_hash: z.string(),
})

export type Job = z.infer<typeof jobSchema>

// Everything the LLM/Firecrawl extraction step is responsible for.
// url, source_platform, scraped_at, raw_description_hash get filled in by our own code.
export const extractedFieldsSchema = jobSchema.omit({
  url: true,
  source_platform: true,
  scraped_at: true,
  raw_description_hash: true,
})

export type ExtractedFields = z.infer<typeof extractedFieldsSchema>
