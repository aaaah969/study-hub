# Study Hub: notes for Claude Code

## What this is
A single-user study app. A zero-dependency Node server (`server.js`) serves one page (`public/index.html`), stores data in `data/db.json`, and proxies AI calls to the Anthropic Messages API with the key from `.env`.

## Run
- `npm start` (or `npm run dev` to restart on server changes), then open http://localhost:3000
- Needs `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). Without it the app runs but AI features show an "AI is off" banner.
- `npm test` runs `test/server.test.js` with Node's built-in runner against a fake Anthropic API (no key, no cost). `DATA_DIR` and `ANTHROPIC_BASE_URL` env vars let tests use a temp folder and the fake API.

## Layout
- `server.js`: routes
  - `GET /api/health` returns `{ai, models}`
  - `GET /api/state` returns `{docs: [...]}` (every stored document)
  - `PUT /api/doc/:id` and `DELETE /api/doc/:id` (ids are `[A-Za-z0-9_-]`)
  - `POST /api/ai` takes `{messages, images:[{media_type,data(base64)}], tier: quick|default|complex}` and streams the plain text back. If the reply stops early the stream ends with a marker line `[[studyhub:cut_off]]`, `[[studyhub:refusal]]` or `[[studyhub:error]] msg`; `cleanAI()` in the frontend splits it off.
  - Tiers map to model, `max_tokens` (16k/32k/64k: thinking counts toward it) and `output_config.effort` (low/medium/high). Sonnet and Opus tiers send the server-side refusal fallback beta (`fallbacks: "default"`); set `DISABLE_FALLBACK=1` to turn it off.
  - Every request is checked by `allowed()`: the Host must be localhost (unless `HOST` is changed), a cross-site `Origin` is refused, and writes must be `Content-Type: application/json`. This stops other websites from spending the API key or changing data. Keep it when adding routes.
  - If `data/db.json` cannot be parsed, it is copied to `db.json.broken-<time>` before anything overwrites it.
- `public/index.html`: the whole frontend (vanilla JS, no build step). Sections are marked with `/* ---------- name ---------- */` comments: storage, AI, file reading, markdown + math, AI tasks (prompts), plan, demo, render, actions.
- Libraries load from jsDelivr at runtime: marked, DOMPurify, MathJax, and lazily pdf.js, mammoth (docx), JSZip (pptx). SheetJS (xlsx) loads from cdn.sheetjs.com because the npm copy (0.18.5) has known security bugs.
- `md()` only renders HTML when DOMPurify loaded; otherwise it shows escaped text. AI output can echo uploaded files, so never put it in the page without `md()` or `esc()`.

## Data model
Every entity is one document with `id` and `kind`:
- `course`: name, examDate, color
- `material`: courseId, summary, text (first 30k chars), studied
- `sheet`: courseId, profile, text
- `quiz`: courseId, pct, weak, questions
- `assignment`: courseId, text, solution, chat, understood
- `meta` (id `meta`): plan, planEnd, hours, activity

## Conventions
- AI prompts that return data ask for JSON and are parsed by `parseJSON` (it tolerates code fences). Then coerce the shape (`normSummary`, `normProfile`, the question mapping in `genQuiz`, `mcqIndex`) before storing: render code assumes arrays of strings.
- Uploads keep only the first 30k characters in `text`, but the full file is passed to the AI once through the transient `_full` field (never saved, like `_images`).
- The plan (`genPlan`) spreads each course up to the day before its exam, keeps a course's tasks in order and fills days up to `meta.hours`; courses whose exam has passed get no tasks.
- Export/Import backup (sidebar) writes/reads `{app:'study-hub',version:1,docs:[...]}`. Import replaces everything and cleans fields that are put into HTML unescaped (colour, dates, ids, numbers).
- Math is written as `$...$` / `$$...$$` and rendered by MathJax; `md()` protects math from the markdown parser.
- Keep the frontend dependency-free and build-free unless there is a strong reason.
- Never commit `.env` or `data/`.
