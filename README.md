# jobdecode-api

One endpoint: give it a job posting URL, get back a normalized JSON job object.

## Run

```
bun install
cp .env.example .env   # fill in FIRECRAWL_API_KEY and GEMINI_API_KEY
bun run dev
```

## Use

```
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "https://jobs.lever.co/some-company/some-role"}'
```

Returns:

```json
{ "job": { "title": "...", "company": "...", "requirements": { ... }, ... } }
```

Schema is defined in `src/schema.ts`. No auth, no DB, no persistence — this is the extraction core only.
