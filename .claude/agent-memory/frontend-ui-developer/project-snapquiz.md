---
name: project-snapquiz
description: SnapQuiz — kids English vocabulary quiz app, single static HTML, mobile-first Korean UI
metadata:
  type: project
---

SnapQuiz is a single-file (`index.template.html`) static web app for elementary school kids learning English vocabulary.

**Why:** Parent photographs word book pages → AI extracts words → child does 4-choice quizzes. Target user is Korean elementary school children using phone/tablet in portrait.

**Key constraints:**
- ONE static `index.template.html` — no server, no build step, no CDN, no frameworks
- All CSS and JS inline; only `engine.js` is a separate `<script src>` tag (build step inlines it later)
- `window.SNAP_CONFIG = { apiKey: "__OPENROUTER_API_KEY__" }` must come BEFORE `<script src="engine.js">`
- Build step replaces `__OPENROUTER_API_KEY__` with the real key from .env

**Deliverable:** `C:\dev\spellingbee\index.template.html`

**How to apply:** Any future UI changes go into this single file. Never add external network requests (no Google Fonts, no CDN). Keep state in the `State` controller object.
