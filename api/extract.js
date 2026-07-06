/**
 * api/extract.js — Vercel serverless function (Node.js runtime)
 *
 * Holds the OpenRouter API key in the server environment (OPENROUTER_API_KEY)
 * so it is NEVER shipped to the browser. The client (engine.js) POSTs the image
 * here and gets back extracted words.
 *
 * Request:  POST { image: "<data URI or base64>", maxTokens?: number }
 * Response: 200 { words: PartialWord[], modelUsed: string }
 *           4xx/5xx { error: string }
 *
 * Set OPENROUTER_API_KEY in: Vercel → Project → Settings → Environment Variables.
 */

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Tried in order. Free vision models are heavily rate-limited (429), so we keep
// several working fallbacks. Keep in sync with engine.js (VISION_MODELS).
// nemotron is a dedicated vision model and the most reliable free one; the
// Gemma "free" models are frequently 429-throttled upstream, so they sit
// behind it as higher-quality-but-flaky fallbacks.
const VISION_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

const SYSTEM_PROMPT = `You are a vocabulary extraction assistant for children's English word books.
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

const norm = (s) => (s || '').trim().toLowerCase();

// --- Retry / backoff tuning -------------------------------------------------
// Free vision models get throttled a lot (429) or return an empty "[]" when
// they punt. Instead of one pass over the chain, sweep it several times with
// exponential backoff, but stay inside the 60s Vercel function budget.
const PER_TRY_TIMEOUT_MS = 22000; // abort a single upstream call
const GLOBAL_DEADLINE_MS = 55000; // overall budget (function maxDuration is 60s)
const MAX_PASSES = 3;             // sweeps over the whole model chain
const BASE_BACKOFF_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How to treat a failed attempt:
//  transient → worth retrying (rate limit, upstream 5xx, timeout, no words)
//  permanent → this model won't work for this request; drop it, try the others
//  fatal     → auth problem; stop everything, retrying can't help
function classify(status) {
  if (status === 401 || status === 403) return 'fatal';
  if (status === 429 || status === 408) return 'transient';
  if (status && status >= 400 && status < 500) return 'permanent';
  return 'transient'; // 5xx, timeouts, network/parse/empty → retry
}

/** One attempt against a single model. Throws Error with .status on failure. */
async function callOnce(model, apiKey, userMessage, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_TRY_TIMEOUT_MS);
  try {
    const resp = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'SnapQuiz',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      const e = new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
      e.status = resp.status;
      throw e;
    }

    const json = await resp.json();
    if (json.error) {
      const e = new Error(JSON.stringify(json.error).slice(0, 200));
      e.status = (json.error && json.error.code) || undefined;
      throw e;
    }

    const raw = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
    if (!raw) throw new Error('Empty response from model');

    const words = parseWordArray(raw);
    if (!words) throw new Error('Could not parse word array from model response');
    // Empty array from a word-list photo almost always means the model punted
    // (throttled) — treat as a transient failure so we retry / fall through.
    if (words.length === 0) throw new Error('Model returned no words (likely throttled)');

    return words;
  } finally {
    clearTimeout(timer);
  }
}

/** Robustly parse the model's text into a words array. Mirrors engine.js. */
function parseWordArray(raw) {
  let text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
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

  return parsed
    .filter((item) => item && typeof item === 'object' && item.word)
    .map((item) => ({
      word: norm(item.word),
      pos: (item.pos || '').trim(),
      meaning: (item.meaning || '').trim(),
      example: (item.example || '').trim(),
      syn: (item.syn || '').trim(),
      ant: (item.ant || '').trim(),
    }))
    .filter((item) => item.word.length > 0);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: '서버에 OPENROUTER_API_KEY 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 추가해 주세요.',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const image = body && body.image;
  const maxTokens = (body && body.maxTokens) || 1200;

  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'image 필드(데이터 URI 또는 base64)가 필요해요.' });
    return;
  }

  const userMessage = [
    {
      type: 'text',
      text: 'Extract all English vocabulary words from this image and return them as a JSON array following the system instructions.',
    },
    { type: 'image_url', image_url: { url: image } },
  ];

  // Sweep the model chain up to MAX_PASSES times, backing off between attempts
  // on transient failures, until one succeeds or the time budget runs out.
  const started = Date.now();
  const errors = [];
  const dead = new Set(); // models that failed permanently — skip on later passes
  let attempts = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (dead.size === VISION_MODELS.length) break;

    for (const model of VISION_MODELS) {
      if (dead.has(model)) continue;
      if (Date.now() - started > GLOBAL_DEADLINE_MS) {
        res.status(504).json({
          error: `시간 안에 추출을 끝내지 못했어요 (${attempts}회 시도). 무료 모델이 몰려서 느린 상태예요. 잠시 후 다시 시도해 주세요.`,
        });
        return;
      }

      attempts++;
      try {
        const words = await callOnce(model, apiKey, userMessage, maxTokens);
        res.status(200).json({ words, modelUsed: model, attempts });
        return;
      } catch (err) {
        const kind = err.name === 'AbortError' ? 'transient' : classify(err.status);
        errors.push(`${model} p${pass + 1}: ${err.message}`);

        if (kind === 'fatal') {
          res.status(502).json({
            error: 'OpenRouter 인증 오류로 추출을 중단했어요. 서버 API 키를 확인해 주세요. ' + err.message,
          });
          return;
        }
        if (kind === 'permanent') {
          dead.add(model);
          continue;
        }
        // transient — wait (exponential backoff + jitter) before the next try
        const backoff = Math.min(4000, BASE_BACKOFF_MS * Math.pow(2, pass)) + Math.floor(Math.random() * 250);
        if (Date.now() - started + backoff < GLOBAL_DEADLINE_MS) await sleep(backoff);
      }
    }
  }

  res.status(502).json({
    error: `모든 모델에서 추출에 실패했어요 (${attempts}회 시도). 무료 모델이 과부하 상태일 수 있어요. ` + errors.slice(-6).join(' | '),
  });
};
