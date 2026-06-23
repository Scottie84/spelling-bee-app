---
name: project-snapquiz-testing
description: SnapQuiz project testing conventions, frameworks, how to run tests, and QA findings
metadata:
  type: project
---

## Project: SnapQuiz (spellingbee)

**Stack:** Single-file HTML/CSS/JS app with `engine.js` (storage + quiz logic) + `index.template.html` (UI). Build step via `build.py` inlines engine.js + injects API key.

**Build rule:** After editing engine.js OR index.template.html, run `./.venv/Scripts/python.exe build.py` to regenerate `index.html`. Never edit index.html directly (gitignored).

**How to apply:** Always rebuild after any source edit. Test index.html, never the template or engine directly in browser.

## Testing Stack
- **Unit tests:** `node engine.test.mjs` — tests pure quiz logic + one live OpenRouter extraction. Run after any engine.js edit.
- **Browser tests:** `node qa.test.mjs` — Playwright Chromium headless, 144 assertions, covers full PRD §12 DoD. Run with `node qa.test.mjs` from project root.
- **Playwright:** installed as devDependency, Chromium at `C:\Users\hongq\AppData\Local\ms-playwright\chromium-1228`.
- **Test image:** `test_vocab.png` (40KB) contains words: apple, brave, garden, quickly, happy. Used for live extraction smoke test.
- **Live API models:** primary=`nvidia/nemotron-nano-12b-v2-vl:free`, fallback=`nex-agi/nex-n2-pro:free`.

## Bug Fixed (2026-06-23)
- "복습만 풀기" button showed misleading toast "복습할 단어가 없어요!" when the actual error was "need at least 4 words with wrong answers". Fixed in `index.template.html` btn-retry-review handler to show more specific message.

## Key Architecture Notes
- `engine.js` auto-detects storage: IndexedDB (preferred) → localStorage → in-memory. File:// origin uses IndexedDB on Chromium.
- Persistence verified: words survive `page.reload()` within same browser context. Cross-context file:// behavior not tested.
- `buildQuiz()` requires minimum 4 words in the scope pool, otherwise throws. UI catches and shows friendly error.
- `extractWordsFromImage()` tries primary model then fallback, 60s timeout each.

## Why: Tracking this for future QA runs so we know what to re-check.
**How to apply:** When any code changes happen, re-run `node engine.test.mjs` + `node qa.test.mjs` (takes ~2 min including live API call).
