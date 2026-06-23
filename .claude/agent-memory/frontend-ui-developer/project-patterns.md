---
name: project-patterns
description: SnapQuiz UI conventions — screen navigation, CSS tokens, engine API wiring
metadata:
  type: project
---

## Screen navigation
- All screens are `<section id="screen-{name}" class="screen">` elements
- Active screen gets `.active` class and `aria-hidden="false"`; others get `aria-hidden="true"`
- Navigation via `showScreen('name')` function — moves focus to first focusable element

## CSS design tokens (`:root`)
- Colors: `--purple` (#6C63FF), `--teal`, `--yellow`, `--red`, `--green`, `--bg` (#F7F6FF)
- Font sizes: `--fs-xs` 14px → `--fs-xxl` 44px
- Primary buttons: `min-height: var(--btn-h)` = 64px (large touch targets)
- Border radius: `--radius` 18px, `--radius-sm` 10px

## Engine API wiring
- `SnapEngine.init()` called once on page load
- `extractWordsFromImage(dataUrl)` → `{ words: PartialWord[], modelUsed, raw }`
- `addWords(partials, group)` dedupes by word+group
- `buildQuiz({ scope, group, count, types })` — scope: 'all'|'group'|'new'|'review'
- `recordAnswer(wordId, correct)` called immediately on each choice tap
- All engine calls are async; wrap in try/catch and show toast on error

## Accessibility patterns
- `aria-live="assertive"` on `#sr-live` for screen-reader announcements
- `aria-live="polite"` on quiz prompt card and wordbook list
- Focus trap in modals via keydown Tab listener
- Settings and edit modal: ESC closes, overlay click closes
- All buttons are `<button>` elements (never `<div onclick>`)

## State management
- Single `State` object: `rewards`, `currentQuiz`, `quizIndex`, `wrongWords`, `correctCount`, `pendingWords`, `editWordId`, `quizScope`, `quizGroup`, `quizCount`
- After engine mutations (addWords, updateWord, deleteWord, clearAll, importJSON), always call `refreshHome()` to sync stat pills

## XSS prevention
- All user-provided strings rendered into innerHTML go through `esc()` helper (HTML entity encode)
