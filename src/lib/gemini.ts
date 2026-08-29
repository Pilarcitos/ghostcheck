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
    thoughtsTokenCount?: number
  }
  error?: { message?: string; status?: string }
}

export async function generateJson(args: {
  prompt: string
  schema: unknown
  maxOutputTokens: number
  log: Logger
  /** Gemini 3.x thinking depth. Classify should stay on "minimal" so thinking cannot eat the JSON budget. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
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
    thinking_level: args.thinkingLevel ?? null,
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
        ...(args.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: args.thinkingLevel } }
          : {}),
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
      status_text: res.statusText,
      elapsed_ms: elapsedMs(startedAt),
      model: GEMINI_MODEL,
      body: rawBody,
      likely_cause:
        res.status === 429
          ? 'Rate limited. Wait and retry.'
          : res.status === 400
            ? 'Request was rejected. thinkingLevel or responseSchema may be invalid for this model.'
            : res.status === 401 || res.status === 403
              ? 'GEMINI_API_KEY was rejected.'
              : 'Gemini HTTP error. Body is dumped above.',
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
      likely_cause: 'The generateContent HTTP body could not be parsed as JSON. Dump is above.',
    })
    throw new Error('Gemini returned invalid JSON')
  }

  const finishReason = data.candidates?.[0]?.finishReason ?? null
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  const thoughts = data.usageMetadata?.thoughtsTokenCount ?? null
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? null
  args.log.info('Parsed the Gemini generateContent payload.', {
    finish_reason: finishReason,
    has_text: Boolean(text),
    text_chars: text?.length ?? 0,
    prompt_tokens: data.usageMetadata?.promptTokenCount ?? null,
    output_tokens: outputTokens,
    thoughts_tokens: thoughts,
    total_tokens: data.usageMetadata?.totalTokenCount ?? null,
    api_error: data.error?.message ?? null,
  })

  if (!text) {
    args.log.error('Gemini did not return a text part containing JSON.', {
      finish_reason: finishReason,
      thoughts_tokens: thoughts,
      output_tokens: outputTokens,
      max_output_tokens: args.maxOutputTokens,
      candidate_count: data.candidates?.length ?? 0,
      api_error: data.error?.message ?? null,
      body: rawBody,
      likely_cause:
        finishReason === 'MAX_TOKENS'
          ? 'finish_reason is MAX_TOKENS and there is no visible JSON. Thinking tokens likely consumed the entire output budget.'
          : finishReason === 'SAFETY'
            ? 'Gemini blocked the response (SAFETY).'
            : 'No text part in the candidate. Full HTTP body is dumped above.',
    })
    throw new Error('Gemini did not return JSON')
  }

  try {
    return JSON.parse(text)
  } catch (err) {
    args.log.error('Gemini text part was not valid JSON.', {
      parse_error: err instanceof Error ? err.message : String(err),
      finish_reason: finishReason,
      thoughts_tokens: thoughts,
      output_tokens: outputTokens,
      max_output_tokens: args.maxOutputTokens,
      text_chars: text.length,
      truncated_json: text,
      likely_cause:
        finishReason === 'MAX_TOKENS'
          ? 'finish_reason is MAX_TOKENS. The JSON was cut off mid-string. Raise maxOutputTokens and/or lower thinkingLevel.'
          : 'The model returned text that is not parseable JSON even though responseMimeType was application/json.',
    })
    throw new Error('Gemini returned non-JSON structured output')
  }
}
