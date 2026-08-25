# Ghostcheck

Ghostcheck turns messy hiring links into one job object — or an honest failure that says what the page actually was.

The current source of those links is Instagram. People post Bandana shorts, bit.ly hops, careers indexes, emails, and flyers. Ghostcheck is two separate steps. They are not wired together yet.

1. **Collect** destination URLs out of an Instagram feed dump.
2. **Extract** one URL into a structured job (`POST /extract`).

It is not a crawler of the whole internet. Collect does not call extract. Extract does not fetch Instagram.

## What we have

### Collect (`bun run collect:links`)

Input is an Instagram HTML dump or a single `/p/` / `/reel/` URL. HTML is not stored. Output is one file: `data/collected-links.json`. Re-runs merge into that same file.

For each post/reel, [ScrapeCreators](https://docs.scrapecreators.com/v1/instagram/post) `GET /v1/instagram/post` returns caption and accessibility/alt text. Destination http(s) links and emails are pulled from that text, plus `img alt` on the dump.

Reels use the same post endpoint. Caption and alt work. The video is not downloaded, played, or transcribed. ScrapeCreators has a separate transcript endpoint (`GET /v2/instagram/media/transcript`, under 2 minutes, 10–30s, AI). We are not calling it.

What collect will miss: a URL that exists only as pixels on a graphic (no caption, no alt), or only spoken in a reel.

### Extract (`POST /extract`)

One URL in. Treat it as a pointer, not as the posting.

1. Normalize and follow HTTP redirects (Bandana `/b/...` → `/jobs/uuid`, `bit.ly` → destination).
2. Scrape with Firecrawl. Classify: `posting`, `listing`, `apply_form`, `gateway`, or `blocked`.
3. Hop in-page if it is a gateway (canonical / `og:url` / JSON-LD / “view this job”). Cap is 4.
4. If it is a single posting or apply form, Gemini maps the page onto `src/schema.ts`. Our code fills `url`, `source_platform`, `scraped_at`, `raw_description_hash`.

Success is `200` with `{ job, decipher }`. If it never becomes a posting, the response is `422` with `kind` of `listing`, `blocked`, or `hop_limit` — not a hollow job object.

## What we actually saw

A live pass of the 14 apply-shaped URLs in `data/collected-links.json`:

- **3 extracted.** Bandana share links that are one job (`/b/pptrainee`, `/b/sjmainasst`, `/b/sanconstr`) hopped to `/jobs/{uuid}` and came back as PG&E PowerPathway Trainee and two City of San Jose roles.
- **4 honest 422s.** Conejo `/apply` and UN Channel were listings. Sonoma `/jobs` was an empty JS shell. `bit.ly/wmswcd-admin` hopped to a blog post that 404'd.
- **7 crashed with 502.** Gemini returned non-JSON structured output. That includes `bandana.com/b/natpsd`, Oakland GovernmentJobs, and several `/careers` pages. Some of those should have been 422 listings, not extract crashes.

Skipped on purpose: `mailto:`, homepage-only URLs, a truncated `/appl` from OCR.

## Run

```
bun install
cp .env.example .env   # FIRECRAWL_API_KEY, GEMINI_API_KEY, SCRAPECREATORS_API_KEY
bun run dev
```

```
bun run collect:links -- path/to/dump.html
bun run collect:links -- https://www.instagram.com/p/SHORTCODE/
bun run collect:links -- path/to/dump.html --dry-run
```

```
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "https://bandana.com/b/sjmainasst"}'
```

Logs are verbose on purpose. Each hop, scrape, and Gemini parse is a timestamped line with a `request_id`.

`data/*.html` and `data/*.json` are gitignored. Keys stay in `.env`.

## Open questions

These are real product choices, not polish.

1. **Wire collect to extract?** Right now you collect, then we pick URLs by hand and hit `/extract`. Should collect auto-extract every http(s) link, only paths that look like jobs (`/b/`, `/jobs`, `/careers`, bit.ly), or stay two-step?
2. **Reels — transcript or not?** Caption+alt already works. Transcript is slow, only under 2 minutes, and costs extra. Worth it when a hiring URL is spoken and never written?
3. **Listings.** Conejo `/apply` had three seasonal roles. Stay 422, return the list of posting URLs, or pick one?
4. **Gemini 502s.** Same failure on 7 URLs: non-JSON structured output. Fix the parser, treat it as `blocked`, or re-classify those pages as listings before Gemini runs?
5. **mailto: and “DM us”.** Collect keeps emails. Extract cannot fetch them. Keep as apply contacts, drop them, or stop at collect?
6. **Non-job posts.** The dump included ASMR, tacos, and a tree-care event. Filter before spending ScrapeCreators credits, or collect everything and sort later?
7. **OCR.** Flyer URLs with no caption and no alt are invisible to us. Add OCR, or accept that miss?

Until those are decided: collect stays a link list. Extract stays one URL in, one job out.
