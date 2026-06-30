/**
 * engine.js — SnapQuiz client-side engine
 *
 * Exposes a single global: window.SnapEngine
 * Runs as plain ES2020 browser JS (no bundler, no Node server).
 * Designed to be testable in Node 24 via engine.test.mjs:
 *   - all quiz logic is pure (no DOM / IndexedDB dependencies)
 *   - the persistence layer is swapped at init() time:
 *       browser  → IndexedDB (falls back to localStorage)
 *       Node/test → in-memory Map (when indexedDB is not defined)
 *
 * API contract (see PRD §4, §8 and the task spec):
 *   SnapEngine.init()
 *   SnapEngine.setApiKey(key)
 *   SnapEngine.getAllWords()
 *   SnapEngine.getGroups()
 *   SnapEngine.addWords(words, group)
 *   SnapEngine.updateWord(id, patch)
 *   SnapEngine.deleteWord(id)
 *   SnapEngine.clearAll()
 *   SnapEngine.exportJSON()
 *   SnapEngine.importJSON(json)
 *   SnapEngine.extractWordsFromImage(dataUrlOrBase64, opts?)
 *   SnapEngine.buildQuiz({scope, group, count, types})
 *   SnapEngine.recordAnswer(wordId, correct)
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DB_NAME    = 'SnapQuizDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'words';

  const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  // Tried in order. Free vision models are heavily rate-limited (429), so we
  // keep several working fallbacks — if the first is throttled we try the next.
  // NOTE: keep this list in sync with api/extract.js (VISION_MODELS).
  // nemotron is a dedicated vision model and the most reliable free one;
  // the Gemma "free" models are frequently 429-throttled upstream, so they
  // sit behind it as higher-quality-but-flaky fallbacks.
  const VISION_MODELS = [
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
  ];
  const PRIMARY_MODEL   = VISION_MODELS[0]; // kept for backwards-compat refs
  const TIMEOUT_MS      = 60_000; // 60 s per model attempt

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  let _apiKey  = (global.SNAP_CONFIG && global.SNAP_CONFIG.apiKey) || '';
  let _db      = null;   // IDBDatabase | null
  let _useSB   = false;  // true when a Supabase project is configured
  let _useIDB  = false;  // true when IndexedDB is available and opened
  let _useLST  = false;  // true when falling back to localStorage
  let _memStore = null;  // Map<id, Word> | null — used in Node / no-storage env

  // Supabase (PostgREST) config — public project URL + publishable/anon key.
  // Safe to ship to the browser; the database is protected by RLS policies.
  const _sbUrl = (global.SNAP_CONFIG && global.SNAP_CONFIG.supabaseUrl) || '';
  const _sbKey = (global.SNAP_CONFIG && global.SNAP_CONFIG.supabaseKey) || '';
  const SB_TABLE = 'english_words';

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /** Generate a random id like "w_a3f9b2". */
  function _newId() {
    return 'w_' + Math.random().toString(36).slice(2, 8);
  }

  /** Fisher-Yates in-place shuffle. Returns the same array. */
  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Case-insensitive trim. */
  function _norm(s) {
    return (s || '').trim().toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Persistence layer — three interchangeable backends
  // ---------------------------------------------------------------------------

  // --- In-memory (Node test / no storage) ---

  function _memInit() {
    _memStore = _memStore || new Map();
  }

  function _memGetAll() {
    return Array.from(_memStore.values());
  }

  function _memPut(word) {
    _memStore.set(word.id, word);
  }

  function _memDelete(id) {
    _memStore.delete(id);
  }

  function _memClear() {
    _memStore.clear();
  }

  // --- localStorage fallback ---

  const LST_KEY = 'snapquiz_words';

  function _lstRead() {
    try {
      return JSON.parse(global.localStorage.getItem(LST_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function _lstWrite(words) {
    global.localStorage.setItem(LST_KEY, JSON.stringify(words));
  }

  function _lstGetAll() {
    return _lstRead();
  }

  function _lstPut(word) {
    const words = _lstRead();
    const idx   = words.findIndex(w => w.id === word.id);
    if (idx >= 0) words[idx] = word;
    else words.push(word);
    _lstWrite(words);
  }

  function _lstDelete(id) {
    _lstWrite(_lstRead().filter(w => w.id !== id));
  }

  function _lstClear() {
    _lstWrite([]);
  }

  // --- IndexedDB ---

  function _idbGetAll() {
    return new Promise((resolve, reject) => {
      const tx  = _db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function _idbPut(word) {
    return new Promise((resolve, reject) => {
      const tx  = _db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(word);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  function _idbDelete(id) {
    return new Promise((resolve, reject) => {
      const tx  = _db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  function _idbClear() {
    return new Promise((resolve, reject) => {
      const tx  = _db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  // --- Supabase (PostgREST REST API) ---

  /** Map a DB row (snake_case) to the in-app Word shape. */
  function _sbRowToWord(row) {
    return {
      id:      row.id,
      word:    row.word    || '',
      pos:     row.pos     || '',
      meaning: row.meaning || '',
      example: row.example || '',
      syn:     row.syn     || '',
      ant:     row.ant     || '',
      group:   row.group_name || '',
      addedAt: row.added_at    || '',
      stats:   row.stats || { seen: 0, correct: 0, wrong: 0 },
    };
  }

  /** Map an in-app Word to a DB row (snake_case). */
  function _sbWordToRow(word) {
    return {
      id:         word.id,
      word:       word.word    || '',
      pos:        word.pos     || '',
      meaning:    word.meaning || '',
      example:    word.example || '',
      syn:        word.syn     || '',
      ant:        word.ant     || '',
      group_name: word.group   || '',
      added_at:   word.addedAt || new Date().toISOString(),
      stats:      word.stats   || { seen: 0, correct: 0, wrong: 0 },
    };
  }

  async function _sbFetch(path, options = {}) {
    const resp = await fetch(`${_sbUrl}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey':        _sbKey,
        'Authorization': `Bearer ${_sbKey}`,
        'Content-Type':  'application/json',
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`[SnapEngine] Supabase ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp;
  }

  async function _sbGetAll() {
    const resp = await _sbFetch(`${SB_TABLE}?select=*`);
    const rows = await resp.json();
    return Array.isArray(rows) ? rows.map(_sbRowToWord) : [];
  }

  async function _sbPut(word) {
    // Upsert on the primary key so add/update share one path.
    await _sbFetch(SB_TABLE, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(_sbWordToRow(word)),
    });
  }

  async function _sbDelete(id) {
    await _sbFetch(`${SB_TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' },
    });
  }

  async function _sbClear() {
    // PostgREST requires a filter for DELETE; match every row.
    await _sbFetch(`${SB_TABLE}?id=not.is.null`, {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' },
    });
  }

  // --- Dispatch to the active backend ---

  async function _getAll()     { if (_useSB) return _sbGetAll(); if (_useIDB) return _idbGetAll(); if (_useLST) return _lstGetAll(); return _memGetAll(); }
  async function _put(word)    { if (_useSB) return _sbPut(word); if (_useIDB) return _idbPut(word); if (_useLST) return _lstPut(word); return _memPut(word); }
  async function _del(id)      { if (_useSB) return _sbDelete(id); if (_useIDB) return _idbDelete(id); if (_useLST) return _lstDelete(id); return _memDelete(id); }
  async function _clearStore() { if (_useSB) return _sbClear(); if (_useIDB) return _idbClear(); if (_useLST) return _lstClear(); return _memClear(); }

  // ---------------------------------------------------------------------------
  // init() — opens the right storage backend
  // ---------------------------------------------------------------------------

  async function init() {
    // Supabase configured → use it as the source of truth (works in both
    // browser and Node, as long as fetch is available).
    if (_sbUrl && _sbKey && typeof fetch !== 'undefined') {
      _useSB = true;
      return;
    }

    // Node environment (no indexedDB global) → in-memory
    if (typeof indexedDB === 'undefined') {
      _memInit();
      return;
    }

    // Try IndexedDB first
    try {
      _db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
      });
      _useIDB = true;
      return;
    } catch (err) {
      console.warn('[SnapEngine] IndexedDB unavailable, trying localStorage:', err);
    }

    // Fall back to localStorage
    if (typeof global.localStorage !== 'undefined') {
      _useLST = true;
      return;
    }

    // Last resort: in-memory (won't survive page reload)
    console.warn('[SnapEngine] No persistent storage available; using in-memory store.');
    _memInit();
  }

  // ---------------------------------------------------------------------------
  // setApiKey
  // ---------------------------------------------------------------------------

  function setApiKey(key) {
    _apiKey = key || '';
  }

  // ---------------------------------------------------------------------------
  // getAllWords / getGroups
  // ---------------------------------------------------------------------------

  async function getAllWords() {
    return _getAll();
  }

  async function getGroups() {
    const words = await _getAll();
    const counts = new Map();
    for (const w of words) {
      counts.set(w.group, (counts.get(w.group) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  }

  // ---------------------------------------------------------------------------
  // renameGroup — rename a group, or merge it into an existing one
  // ---------------------------------------------------------------------------

  /**
   * Move every word in group `oldName` to `newName`. If `newName` is a group
   * that already exists, the two merge (and words duplicated by name are
   * de-duplicated, keeping the existing copy in the target group).
   *
   * Groups are derived from each word's `group` field — there is no separate
   * group record — so this is the one operation behind both "rename" and "merge".
   *
   * @returns {Promise<{moved:number, deletedDuplicates:number, merged:boolean}>}
   */
  async function renameGroup(oldName, newName) {
    const from = (oldName || '').trim();
    const to   = (newName || '').trim();
    if (!from) throw new Error('[SnapEngine] renameGroup: source group is required.');
    if (!to)   throw new Error('[SnapEngine] renameGroup: new group name is required.');
    if (from === to) return { moved: 0, deletedDuplicates: 0, merged: false };

    const all     = await _getAll();
    const targets = all.filter(w => w.group === from);
    if (targets.length === 0) {
      throw new Error(`[SnapEngine] renameGroup: group "${from}" not found.`);
    }

    // Words already in the destination — used to detect a merge and to dedup.
    const destWords = new Set(all.filter(w => w.group === to).map(w => _norm(w.word)));
    const merged    = destWords.size > 0;

    // Source words whose name already lives in the destination would become
    // duplicates after the move, so drop those source copies instead.
    const dupes = targets.filter(w => destWords.has(_norm(w.word)));
    const movers = targets.filter(w => !destWords.has(_norm(w.word)));

    if (_useSB) {
      for (const w of dupes) await _sbDelete(w.id);
      if (movers.length > 0) {
        // One bulk PATCH for everything that actually moves.
        const moverIds = movers.map(w => `"${w.id}"`).join(',');
        await _sbFetch(`${SB_TABLE}?id=in.(${encodeURIComponent(moverIds)})`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ group_name: to }),
        });
      }
    } else {
      for (const w of dupes) await _del(w.id);
      for (const w of movers) {
        w.group = to;
        await _put(w);
      }
    }

    return { moved: movers.length, deletedDuplicates: dupes.length, merged };
  }

  // ---------------------------------------------------------------------------
  // addWords — dedupes by (word + group), case-insensitive
  // ---------------------------------------------------------------------------

  async function addWords(partials, group) {
    const existing = await _getAll();
    // Build a set of "word|group" keys for dedup check
    const seen = new Set(existing.map(w => `${_norm(w.word)}|${_norm(w.group)}`));

    const now   = new Date().toISOString();
    const added = [];

    for (const p of partials) {
      const key = `${_norm(p.word)}|${_norm(group)}`;
      if (seen.has(key)) continue; // duplicate — skip

      const word = {
        id:      _newId(),
        word:    (p.word    || '').trim(),
        pos:     (p.pos     || '').trim(),
        meaning: (p.meaning || '').trim(),
        example: (p.example || '').trim(),
        syn:     (p.syn     || '').trim(),
        ant:     (p.ant     || '').trim(),
        group:   group,
        addedAt: now,
        stats:   { seen: 0, correct: 0, wrong: 0 },
      };

      await _put(word);
      seen.add(key);
      added.push(word);
    }

    return added;
  }

  // ---------------------------------------------------------------------------
  // updateWord
  // ---------------------------------------------------------------------------

  async function updateWord(id, patch) {
    const words = await _getAll();
    const word  = words.find(w => w.id === id);
    if (!word) throw new Error(`[SnapEngine] Word not found: ${id}`);

    // Merge patch — do not allow overwriting id or addedAt
    const { id: _i, addedAt: _a, stats: patchStats, ...rest } = patch;
    Object.assign(word, rest);

    if (patchStats) {
      word.stats = { ...word.stats, ...patchStats };
    }

    await _put(word);
    return word;
  }

  // ---------------------------------------------------------------------------
  // deleteWord
  // ---------------------------------------------------------------------------

  async function deleteWord(id) {
    await _del(id);
  }

  // ---------------------------------------------------------------------------
  // clearAll
  // ---------------------------------------------------------------------------

  async function clearAll() {
    await _clearStore();
  }

  // ---------------------------------------------------------------------------
  // exportJSON / importJSON
  // ---------------------------------------------------------------------------

  async function exportJSON() {
    const words = await _getAll();
    return JSON.stringify({ words, exportedAt: new Date().toISOString() }, null, 2);
  }

  async function importJSON(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch (err) {
      throw new Error('[SnapEngine] importJSON: invalid JSON');
    }

    const incoming = Array.isArray(data) ? data : (data.words || []);
    if (!Array.isArray(incoming)) throw new Error('[SnapEngine] importJSON: expected { words: [] }');

    let count = 0;
    for (const w of incoming) {
      if (!w || !w.id || !w.word) continue; // malformed
      await _put({
        id:      w.id,
        word:    (w.word    || '').trim(),
        pos:     (w.pos     || '').trim(),
        meaning: (w.meaning || '').trim(),
        example: (w.example || '').trim(),
        syn:     (w.syn     || '').trim(),
        ant:     (w.ant     || '').trim(),
        group:   (w.group   || 'Imported'),
        addedAt: w.addedAt  || new Date().toISOString(),
        stats:   w.stats    || { seen: 0, correct: 0, wrong: 0 },
      });
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // extractWordsFromImage — calls OpenRouter with primary/fallback model
  // ---------------------------------------------------------------------------

  /**
   * @param {string} dataUrlOrBase64
   *   Either a full data URI ("data:image/png;base64,...") or raw base64.
   * @param {object} [opts]
   *   opts.maxTokens  — override token cap (default 1200)
   * @returns {Promise<{words: PartialWord[], modelUsed: string, raw?: string}>}
   */
  async function extractWordsFromImage(dataUrlOrBase64, opts = {}) {
    const maxTokens = opts.maxTokens || 1200;

    // Normalise to a proper data URI so the model gets a valid image_url
    let imageUrl = dataUrlOrBase64;
    if (!imageUrl.startsWith('data:')) {
      imageUrl = `data:image/png;base64,${imageUrl}`;
    }

    // No client-side key configured → call the serverless proxy so the key
    // stays on the server (e.g. Vercel env var). The local single-file build
    // (build.py) embeds a key and keeps calling OpenRouter directly below.
    if (!_apiKey) {
      return _extractViaServer(imageUrl, maxTokens);
    }

    const systemPrompt = `You are a vocabulary extraction assistant for children's English word books.
Extract ONLY real English vocabulary words visible in the image (skip page numbers, headers, decorations).
Return STRICT JSON ONLY — a JSON array, nothing else, no markdown fences, no prose before or after.
Each element must have exactly these fields:
  word     — the English word (lowercase, trimmed)
  pos      — part of speech abbreviation like "n." "v." "adj." "adv." "prep." (empty string if unknown)
  meaning  — Korean meaning (한글 뜻), concise
  example  — one short English sentence using the word
  syn      — a synonym (English word), empty string if none
  ant      — an antonym (English word), empty string if none
If there are no vocabulary words in the image, return an empty array: []`;

    const userMessage = [
      {
        type: 'text',
        text: 'Extract all English vocabulary words from this image and return them as a JSON array following the system instructions.',
      },
      {
        type: 'image_url',
        image_url: { url: imageUrl },
      },
    ];

    const errors = [];

    for (const model of VISION_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const resp = await fetch(OPENROUTER_ENDPOINT, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${_apiKey}`,
            'HTTP-Referer':  'https://snapquiz.local',
            'X-Title':       'SnapQuiz',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userMessage },
            ],
          }),
        });

        clearTimeout(timer);

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }

        const json = await resp.json();

        // Defensive: some free models return an error field instead of choices
        if (json.error) {
          throw new Error(`Model error: ${JSON.stringify(json.error).slice(0, 200)}`);
        }

        const raw = (json.choices?.[0]?.message?.content || '').trim();
        if (!raw) throw new Error('Empty response from model');

        const words = _parseWordArray(raw);
        if (!words) throw new Error('Could not parse word array from model response');
        // A word-list photo that parses to zero words almost always means the
        // model punted — throttled free models often return "[]" in ~2s instead
        // of doing the work. Treat empty as a soft failure and fall through.
        if (words.length === 0) throw new Error('Model returned no words (likely throttled)');

        return { words, modelUsed: model, raw };

      } catch (err) {
        clearTimeout(timer);
        const msg = err.name === 'AbortError' ? 'Timeout after 60 s' : err.message;
        console.warn(`[SnapEngine] extractWordsFromImage: ${model} failed — ${msg}`);
        errors.push(`${model}: ${msg}`);
        // continue to fallback
      }
    }

    throw new Error(`[SnapEngine] extractWordsFromImage: all models failed.\n${errors.join('\n')}`);
  }

  /**
   * Server-side extraction path (no key on the client).
   * POSTs the image to /api/extract, which holds OPENROUTER_API_KEY in its env.
   * @returns {Promise<{words: PartialWord[], modelUsed: string}>}
   */
  async function _extractViaServer(imageUrl, maxTokens) {
    const endpoint = (global.SNAP_CONFIG && global.SNAP_CONFIG.apiBase) || '/api/extract';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageUrl, maxTokens }),
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`서버 추출 실패 (HTTP ${resp.status}): ${body.slice(0, 200)}`);
      }
      const json = await resp.json();
      if (json.error) throw new Error(json.error);
      return { words: json.words || [], modelUsed: json.modelUsed || 'server' };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('서버 응답 시간 초과 (60초)');
      throw err;
    }
  }

  /**
   * Robustly parse the model's text into PartialWord[].
   * Handles: markdown fences, prose before/after the array, truncated JSON.
   */
  function _parseWordArray(raw) {
    // Strip common markdown code fences
    let text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

    // Find the first '[' and last ']'
    const start = text.indexOf('[');
    const end   = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) {
      // Model might have returned a single object — wrap it
      const objStart = text.indexOf('{');
      const objEnd   = text.lastIndexOf('}');
      if (objStart !== -1 && objEnd !== -1) {
        text = `[${text.slice(objStart, objEnd + 1)}]`;
      } else {
        return null;
      }
    } else {
      text = text.slice(start, end + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return null;
    }

    if (!Array.isArray(parsed)) return null;

    // Normalise each item — be lenient about missing fields
    return parsed
      .filter(item => item && typeof item === 'object' && item.word)
      .map(item => ({
        word:    _norm(item.word),
        pos:     (item.pos     || '').trim(),
        meaning: (item.meaning || '').trim(),
        example: (item.example || '').trim(),
        syn:     (item.syn     || '').trim(),
        ant:     (item.ant     || '').trim(),
      }))
      .filter(item => item.word.length > 0);
  }

  // ---------------------------------------------------------------------------
  // verifyExtraction — second-pass check that extracted words match the image
  // ---------------------------------------------------------------------------

  const VERIFY_SYSTEM_PROMPT = `You are an OCR verifier for children's English word books.
You are given an image of a word-book page and a JSON array of words that were extracted from it.
Check each extracted word AGAINST THE IMAGE and report problems.
Return STRICT JSON ONLY — no markdown fences, no prose before or after — an object with exactly:
{
  "checked": [ { "word": "<the extracted word, unchanged>", "status": "ok" | "spelling" | "not_in_image", "suggestion": "<corrected spelling if status is spelling, else empty string>" } ],
  "missing": [ "<english vocabulary words clearly visible in the image but NOT in the extracted list>" ]
}
Rules:
- status "ok": the word appears in the image and is spelled correctly.
- status "spelling": the word appears in the image but is misspelled in the list; put the correct spelling in "suggestion".
- status "not_in_image": you cannot find this word anywhere in the image.
- "checked" MUST contain exactly one entry per extracted word, in the same order as given.
- "missing" lists only clear vocabulary words left out; use an empty array if none.`;

  /**
   * Verify that extracted words actually appear in the image (and are spelled
   * right), and surface any words the extractor missed.
   * @param {string} dataUrlOrBase64 — the same image used for extraction
   * @param {Array<{word:string}>|string[]} words — extracted words (objects or plain strings)
   * @param {object} [opts]
   * @returns {Promise<{checked: Array<{word,status,suggestion}>, missing: string[], modelUsed: string}>}
   */
  async function verifyExtraction(dataUrlOrBase64, words, opts = {}) {
    const maxTokens = opts.maxTokens || 800;

    const wordList = (words || [])
      .map(w => (typeof w === 'string' ? w : (w && w.word) || ''))
      .map(w => String(w).trim())
      .filter(Boolean);

    if (wordList.length === 0) {
      return { checked: [], missing: [], modelUsed: 'none' };
    }

    let imageUrl = dataUrlOrBase64;
    if (!imageUrl.startsWith('data:')) {
      imageUrl = `data:image/png;base64,${imageUrl}`;
    }

    // No client-side key → go through the serverless proxy (same as extraction).
    if (!_apiKey) {
      return _verifyViaServer(imageUrl, wordList, maxTokens);
    }

    const userMessage = [
      {
        type: 'text',
        text: `Verify these extracted words against the image. Extracted words (JSON): ${JSON.stringify(wordList)}`,
      },
      { type: 'image_url', image_url: { url: imageUrl } },
    ];

    const errors = [];

    for (const model of VISION_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const resp = await fetch(OPENROUTER_ENDPOINT, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${_apiKey}`,
            'HTTP-Referer':  'https://snapquiz.local',
            'X-Title':       'SnapQuiz',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: VERIFY_SYSTEM_PROMPT },
              { role: 'user',   content: userMessage },
            ],
          }),
        });

        clearTimeout(timer);

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }

        const json = await resp.json();
        if (json.error) {
          throw new Error(`Model error: ${JSON.stringify(json.error).slice(0, 200)}`);
        }

        const raw = (json.choices?.[0]?.message?.content || '').trim();
        if (!raw) throw new Error('Empty response from model');

        const verdict = _parseVerdict(raw, wordList);
        if (!verdict) throw new Error('Could not parse verdict from model response');

        return { ...verdict, modelUsed: model };

      } catch (err) {
        clearTimeout(timer);
        const msg = err.name === 'AbortError' ? 'Timeout after 60 s' : err.message;
        console.warn(`[SnapEngine] verifyExtraction: ${model} failed — ${msg}`);
        errors.push(`${model}: ${msg}`);
      }
    }

    throw new Error(`[SnapEngine] verifyExtraction: all models failed.\n${errors.join('\n')}`);
  }

  /** Server-side verification path (no key on the client). POSTs to /api/verify. */
  async function _verifyViaServer(imageUrl, wordList, maxTokens) {
    const endpoint = (global.SNAP_CONFIG && global.SNAP_CONFIG.verifyBase) || '/api/verify';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageUrl, words: wordList, maxTokens }),
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`서버 검증 실패 (HTTP ${resp.status}): ${body.slice(0, 200)}`);
      }
      const json = await resp.json();
      if (json.error) throw new Error(json.error);
      return {
        checked: json.checked || [],
        missing: json.missing || [],
        modelUsed: json.modelUsed || 'server',
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('서버 응답 시간 초과 (60초)');
      throw err;
    }
  }

  /**
   * Parse the verifier's JSON object into a normalised verdict.
   * Aligns the "checked" list back to the words we asked about so the caller can
   * trust there is exactly one entry per input word, in order.
   */
  function _parseVerdict(raw, wordList) {
    let text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    text = text.slice(start, end + 1);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const VALID = new Set(['ok', 'spelling', 'not_in_image']);
    const rawChecked = Array.isArray(parsed.checked) ? parsed.checked : [];

    // Index the model's verdicts by normalised word so we can realign to our list.
    const byWord = new Map();
    for (const item of rawChecked) {
      if (!item || typeof item !== 'object') continue;
      const key = _norm(item.word);
      if (key) byWord.set(key, item);
    }

    const checked = wordList.map(w => {
      const hit = byWord.get(_norm(w));
      const status = hit && VALID.has(hit.status) ? hit.status : 'ok';
      return {
        word: w,
        status,
        suggestion: status === 'spelling' && hit && hit.suggestion
          ? String(hit.suggestion).trim()
          : '',
      };
    });

    const inputSet = new Set(wordList.map(_norm));
    const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
      .map(m => String(m || '').trim())
      .filter(m => m && !inputSet.has(_norm(m)));

    return { checked, missing };
  }

  // ---------------------------------------------------------------------------
  // buildQuiz
  // ---------------------------------------------------------------------------

  /**
   * @param {object} opts
   *   scope  — 'all' | 'group' | 'new' | 'review'
   *   group  — group name (used when scope === 'group')
   *   count  — number of questions
   *   types  — array of 'A'|'B'|'C'|'D' (default: ['A','B','C'])
   * @returns {Promise<Question[]>}
   */
  async function buildQuiz({ scope = 'all', group = null, count = 10, types = ['A', 'B', 'C'] } = {}) {
    const allWords = await _getAll();

    if (allWords.length < 4) {
      throw new Error('[SnapEngine] Not enough words to build a quiz. Please add at least 4 words.');
    }

    // --- Select the pool for this scope ---
    let pool = _selectPool(allWords, scope, group);

    if (pool.length < 4) {
      throw new Error(`[SnapEngine] Not enough words in the selected scope ("${scope}"). Need at least 4.`);
    }

    // --- Clamp count ---
    const n = Math.min(count, pool.length);

    // Shuffle pool and take first n words as quiz candidates
    const candidates = _shuffle([...pool]).slice(0, n);

    // --- Build one question per candidate ---
    const questions = [];
    for (const word of candidates) {
      const type = _pickType(word, types);
      if (!type) continue;

      const q = _makeQuestion(word, type, allWords);
      if (q) questions.push(q);
    }

    if (questions.length === 0) {
      throw new Error('[SnapEngine] Could not generate any questions. Check that words have meaning/example fields.');
    }

    // Shuffle final question order
    return _shuffle(questions);
  }

  /** Select the word pool according to scope. */
  function _selectPool(allWords, scope, group) {
    switch (scope) {
      case 'group':
        return allWords.filter(w => w.group === group);

      case 'new': {
        // 'new' = the most recently added batch (same addedAt date or same group)
        // We use the most-recently-added group
        if (allWords.length === 0) return [];
        const sorted = [...allWords].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        const latestGroup = sorted[0].group;
        return allWords.filter(w => w.group === latestGroup);
      }

      case 'review':
        // Words that have been answered wrong at least once
        return allWords.filter(w => w.stats.wrong > 0);

      case 'all':
      default:
        return allWords;
    }
  }

  /** Pick a question type for the given word, respecting the allowed types list. */
  function _pickType(word, types) {
    const allowed = [...types];

    // Type C requires an example sentence
    const cIdx = allowed.indexOf('C');
    if (cIdx !== -1 && !word.example) allowed.splice(cIdx, 1);

    // Type D requires syn or ant
    const dIdx = allowed.indexOf('D');
    if (dIdx !== -1 && !word.syn && !word.ant) allowed.splice(dIdx, 1);

    if (allowed.length === 0) return null;

    return allowed[Math.floor(Math.random() * allowed.length)];
  }

  /**
   * Build a single Question object.
   * allWords is the full wordbook (used to source distractors).
   */
  function _makeQuestion(word, type, allWords) {
    // Build distractor pool: other words, preferring same group
    const others = allWords.filter(w => w.id !== word.id);
    const sameGroup  = others.filter(w => w.group === word.group);
    const otherGroup = others.filter(w => w.group !== word.group);
    // Prefer same-group distractors, pad with cross-group if needed
    const distPool = _shuffle([...sameGroup, ...otherGroup]);

    let promptText;
    let promptLabel;
    let correctChoice;
    let getDistractorChoice; // (w: Word) => string

    switch (type) {
      case 'A':
        // Show meaning, pick the WORD
        promptText        = word.meaning;
        promptLabel       = '다음 뜻에 맞는 단어를 고르세요:';
        correctChoice     = word.word;
        getDistractorChoice = w => w.word;
        break;

      case 'B':
        // Show word, pick the MEANING
        promptText        = word.word;
        promptLabel       = '다음 단어의 뜻을 고르세요:';
        correctChoice     = word.meaning;
        getDistractorChoice = w => w.meaning;
        break;

      case 'C': {
        // Blank the word in the example sentence, pick the WORD.
        // Match inflected forms too (invested/investing/...), longest first
        // so the whole word is blanked rather than leaving a stray suffix.
        const blank = '____';
        const variants = _inflections(word.word)
          .sort((a, b) => b.length - a.length)
          .map(_escapeRegex);
        const re     = new RegExp(`\\b(?:${variants.join('|')})\\b`, 'gi');
        const filled = word.example.replace(re, blank);
        promptText        = filled || `${blank}: ${word.meaning}`;
        promptLabel       = '빈칸에 알맞은 단어를 고르세요:';
        correctChoice     = word.word;
        getDistractorChoice = w => w.word;
        break;
      }

      case 'D': {
        // Synonym or antonym question — pick the WORD
        const useSyn  = word.syn && (!word.ant || Math.random() < 0.5);
        const relRaw  = useSyn ? word.syn : word.ant;
        // syn/ant may hold several comma-separated words (e.g. "crevice, split").
        // Show only one so the prompt reads naturally.
        const relOpts = relRaw.split(',').map(s => s.trim()).filter(Boolean);
        const relWord = relOpts.length
          ? relOpts[Math.floor(Math.random() * relOpts.length)]
          : relRaw.trim();
        const relLabel = useSyn ? '유의어(synonym)' : '반의어(antonym)';
        promptText        = `"${relWord}"의 ${relLabel}`;
        promptLabel       = '다음에 맞는 단어를 고르세요:';
        correctChoice     = word.word;
        getDistractorChoice = w => w.word;
        break;
      }

      default:
        return null;
    }

    // Collect up to 3 unique distractors whose choice text differs from the correct choice
    const distractors = [];
    const usedChoices = new Set([_norm(correctChoice)]);

    for (const d of distPool) {
      if (distractors.length >= 3) break;
      const choice = getDistractorChoice(d);
      if (!choice) continue;
      const normChoice = _norm(choice);
      if (usedChoices.has(normChoice)) continue;
      usedChoices.add(normChoice);
      distractors.push(choice);
    }

    if (distractors.length < 3) {
      // Not enough unique distractors — skip this question
      return null;
    }

    // Assemble and shuffle the 4 choices
    const choices = _shuffle([correctChoice, ...distractors]);
    const answerIndex = choices.findIndex(c => _norm(c) === _norm(correctChoice));

    return {
      id:          _newId(),
      type,
      wordId:      word.id,
      promptText,
      promptLabel,
      choices,
      answerIndex,
      word,
    };
  }

  function _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Surface forms of a base word so the C-type blank also matches inflected
  // forms in the example (invest -> invested/investing/invests, etc.).
  function _inflections(base) {
    const w = (base || '').trim();
    if (!w) return [];
    const lower = w.toLowerCase();
    const forms = new Set([w]);
    const add = s => { if (s && s.length > 1) forms.add(s); };
    const isVowel = c => 'aeiou'.includes(c);
    const last = lower[lower.length - 1];
    const prev = lower[lower.length - 2];

    add(w + 's');
    add(w + 'es');
    add(w + 'ed');
    add(w + 'd');
    add(w + 'ing');

    if (last === 'e') {                       // use -> using/used
      const stem = w.slice(0, -1);
      add(stem + 'ing');
      add(stem + 'ed');
    }
    if (last === 'y' && prev && !isVowel(prev)) {  // try -> tries/tried
      const stem = w.slice(0, -1);
      add(stem + 'ies');
      add(stem + 'ied');
    }
    if (lower.length >= 3) {                   // stop -> stopped/stopping
      const c1 = lower[lower.length - 3];
      const v  = lower[lower.length - 2];
      const c2 = lower[lower.length - 1];
      if (!isVowel(c1) && isVowel(v) && !isVowel(c2) && !'wxy'.includes(c2)) {
        add(w + c2 + 'ed');
        add(w + c2 + 'ing');
      }
    }
    return Array.from(forms);
  }

  // ---------------------------------------------------------------------------
  // recordAnswer — updates stats and persists
  // ---------------------------------------------------------------------------

  async function recordAnswer(wordId, correct) {
    const words = await _getAll();
    const word  = words.find(w => w.id === wordId);
    if (!word) return; // silently ignore unknown ids

    word.stats.seen   += 1;
    if (correct) word.stats.correct += 1;
    else         word.stats.wrong   += 1;

    await _put(word);
  }

  // ---------------------------------------------------------------------------
  // Public API surface
  // ---------------------------------------------------------------------------

  const SnapEngine = {
    init,
    setApiKey,
    getAllWords,
    getGroups,
    renameGroup,
    addWords,
    updateWord,
    deleteWord,
    clearAll,
    exportJSON,
    importJSON,
    extractWordsFromImage,
    verifyExtraction,
    buildQuiz,
    recordAnswer,
  };

  // Attach to global (window in browser, global in Node when loaded via require/import shim)
  if (typeof global !== 'undefined') {
    global.SnapEngine = SnapEngine;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SnapEngine;
  }

}(typeof globalThis !== 'undefined' ? globalThis : this));
