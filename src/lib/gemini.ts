import { elapsedMs, type Logger } from './logger'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

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

export async function generateJson(args: {
  prompt: string
  schema: unknown
  maxOutputTokens: number
  log: Logger
}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    args.log.error('Cannot call Gemini because GEMINI_API_KEY is missing from the environment.')
    throw new Error('GEMINI_API_KEY is not set')
  }

  args.log.info('Calling Gemini generateContent with a JSON response schema.', {
    model: GEMINI_MODEL,
    endpoint: GEMINI_API_URL,
    prompt_chars: args.prompt.length,
    max_output_tokens: args.maxOutputTokens,
  })

  const startedAt = performance.now()
  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: args.schema,
        maxOutputTokens: args.maxOutputTokens,
      },
    }),
  })

  const rawBody = await res.text()
  args.log.info('Received an HTTP response from Gemini.', {
    status: res.status,
    status_text: res.statusText,
    elapsed_ms: elapsedMs(startedAt),
    body_bytes: rawBody.length,
  })

  if (!res.ok) {
    args.log.error('Gemini rejected the generateContent request.', {
      status: res.status,
      body: rawBody,
    })
    throw new Error(`Gemini API request failed (${res.status}): ${rawBody}`)
  }

  let data: GeminiGenerateResponse
  try {
    data = JSON.parse(rawBody) as GeminiGenerateResponse
  } catch (err) {
    args.log.error('Gemini returned a non-JSON HTTP body.', {
      parse_error: err instanceof Error ? err.message : String(err),
      body: rawBody,
    })
    throw new Error('Gemini returned invalid JSON')
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  args.log.info('Parsed the Gemini generateContent payload.', {
    finish_reason: data.candidates?.[0]?.finishReason ?? null,
    has_text: Boolean(text),
    text_chars: text?.length ?? 0,
    prompt_tokens: data.usageMetadata?.promptTokenCount ?? null,
    output_tokens: data.usageMetadata?.candidatesTokenCount ?? null,
    total_tokens: data.usageMetadata?.totalTokenCount ?? null,
    api_error: data.error?.message ?? null,
  })

  if (!text) {
    args.log.error('Gemini did not return a text part containing JSON.')
    throw new Error('Gemini did not return JSON')
  }

  try {
    return JSON.parse(text)
  } catch (err) {
    args.log.error('Gemini text part was not valid JSON.', {
      parse_error: err instanceof Error ? err.message : String(err),
      text,
    })
    throw new Error('Gemini returned non-JSON structured output')
  }
}
