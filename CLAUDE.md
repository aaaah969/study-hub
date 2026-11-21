# Study Hub: notes for Claude Code

## What this is
A single-user study app. A zero-dependency Node server (`server.js`) serves one page (`public/index.html`), stores data in `data/db.json`, and proxies AI calls to the Anthropic Messages API with the key from `.env`.

## Run
- `npm start` (or `npm run dev` to restart on server changes), then open http://localhost:3000
- Needs `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). Without it the app runs but AI features show an "AI is off" banner.

## Layout
- `server.js`: routes
  - `GET /api/health` returns `{ai, models}`
  - `GET /api/state` returns `{docs: [...]}` (every stored document)
  - `PUT /api/doc/:id` and `DELETE /api/doc/:id` (ids are `[A-Za-z0-9_-]`)
  - `POST /api/ai` takes `{messages, images:[{media_type,data(base64)}], tier: quick|default|complex}` and streams the plain text back
- `public/index.html`: the whole frontend (vanilla JS, no build step). Sections are marked with `/* ---------- name ---------- */` comments: storage, AI, file reading, markdown + math, AI tasks (prompts), plan, demo, render, actions.
- Libraries load from jsDelivr at runtime: marked, DOMPurify, MathJax, and lazily pdf.js, mammoth (docx), JSZip (pptx), SheetJS (xlsx).

## Data model
Every entity is one document with `id` and `kind`:
- `course`: name, examDate, color
- `material`: courseId, summary, text (first 30k chars), studied
- `sheet`: courseId, profile, text
- `quiz`: courseId, pct, weak, questions
- `assignment`: courseId, text, solution, chat, understood
- `meta` (id `meta`): plan, planEnd, hours, activity

## Conventions
- AI prompts that return data ask for JSON and are parsed by `parseJSON` (it tolerates code fences).
- Math is written as `$...$` / `$$...$$` and rendered by MathJax; `md()` protects math from the markdown parser.
- Keep the frontend dependency-free and build-free unless there is a strong reason.
- Never commit `.env` or `data/`.
