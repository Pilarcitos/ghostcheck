# Ghostcheck

Ghostcheck is a **link decipherer** for job postings.

People do not send clean Greenhouse URLs. They send shorteners, social cards, board listings, “apply here” pages, and ATS forms with the description buried underneath. Ghostcheck’s job is to follow that mess until it is looking at an actual job description, then return one normalized JSON object.

It is not a crawler of the whole internet. One link in, one job out — or an honest failure that says what the page actually was.

## The decipherer

Treat the input as a pointer, not as the posting.

1. **Normalize**  
   Make the URL fetchable (scheme, obvious tracking junk). Follow HTTP redirects (`loom.ly` → Trakstar, Bandana share links → `/jobs/...`).

2. **Classify the page**  
   After a scrape, decide what you landed on. Do not assume 200 HTML means “this is the job.”

   | Kind | Meaning | Next move |
   |---|---|---|
   | `posting` | One job description | Stop. Extract. |
   | `listing` | Many jobs / search results | Do not invent a job. Fail or ask for a more specific URL. |
   | `apply_form` | Application UI wrapped around a JD | Isolate the description. Ignore form fields. |
   | `gateway` | Shortener, share card, “view job”, “apply on company site” | Follow the real posting URL and classify again. |
   | `blocked` | Login wall, 404, empty shell | Fail with that reason. Do not hallucinate a title. |

3. **Hop if needed**  
   Use whatever the page itself gives you: `Location`, canonical / `og:url`, JSON-LD `JobPosting`, or a single obvious “view this job” link. Cap the hop count. Hostnames are hints (`lever.co`, `bandana.com`), not a hardcoded script per ATS.

4. **Extract**  
   Once the page is a posting, map it onto the job schema with Gemini. Firecrawl gets markdown (JS-rendered). Our code fills `url`, `source_platform`, `scraped_at`, and `raw_description_hash`. Gemini does not get to invent those.

Platform is a label on the canonical host, not a switch statement the pipeline depends on. Unknown ATS → still extract if it is a posting.

## Output

`POST /extract` with `{ "url": "..." }`.

```json
{
  "job": {
    "url": "https://canonical-posting.example/jobs/123",
    "source_platform": "generic",
    "title": "...",
    "company": "...",
    "employment_type": "full_time",
    "location": { "raw": "...", "remote_type": "hybrid" },
    "compensation": { "min": 640, "max": 640, "period": "week", "raw": "$640/week" },
    "requirements": { "required": [], "preferred": [], "degree": "none_stated", "tech_stack": [] },
    "apply_url": "https://...",
    "benefits": []
  }
}
```

Schema lives in `src/schema.ts`. No auth, no DB, no persistence.

If the decipherer cannot reach a posting, the response should say so (`listing`, `blocked`, hop limit) instead of returning a hollow job object.

## Run

```
bun install
cp .env.example .env   # FIRECRAWL_API_KEY and GEMINI_API_KEY
bun run dev
```

```
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "https://loom.ly/lHwa8zQ"}'
```

Logs are verbose on purpose: each hop, scrape, and Gemini parse is a timestamped line with a `request_id`. No emojis.

## What is built vs next

**Built:** scrape + structured extract, HTTP redirect following, request logging. A direct posting URL (or a shortener that is a plain 301/307) already works.

**Next:** page classification and in-page hops — the actual decipherer. Until that exists, a careers listing or a login wall can still be sent to Gemini as if it were a posting. That is the gap this README is describing.
