/**
 * api/verify.js — Vercel serverless function (Node.js runtime)
 *
 * Second-pass verification: given the page image and the words that were
 * extracted from it, asks a vision model to confirm each word is really in the
 * image and spelled correctly, and to flag words that were missed.
 *
 * Holds the OpenRouter API key in the server environment (OPENROUTER_API_KEY)
 * so it is NEVER shipped to the browser. Mirrors api/extract.js.
 *
 * Request:  POST { image: "<data URI or base64>", words: string[], maxTokens?: number }
 * Response: 200 { checked: [{word,status,suggestion}], missing: string[], modelUsed: string }
 *           4xx/5xx { error: string }
 */

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Keep in sync with engine.js (VISION_MODELS).
const VISION_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

const SYSTEM_PROMPT = `You are an OCR verifier for children's English word books.
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

const norm = (s) => (s || '').trim().toLowerCase();

/** Parse the verifier's JSON object and realign "checked" to the words asked about. */
function parseVerdict(raw, wordList) {
  let text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
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

  const byWord = new Map();
  for (const item of rawChecked) {
    if (!item || typeof item !== 'object') continue;
    const key = norm(item.word);
    if (key) byWord.set(key, item);
  }

  const checked = wordList.map((w) => {
    const hit = byWord.get(norm(w));
    const status = hit && VALID.has(hit.status) ? hit.status : 'ok';
    return {
      word: w,
      status,
      suggestion:
        status === 'spelling' && hit && hit.suggestion ? String(hit.suggestion).trim() : '',
    };
  });

  const inputSet = new Set(wordList.map(norm));
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .map((m) => String(m || '').trim())
    .filter((m) => m && !inputSet.has(norm(m)));

  return { checked, missing };
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
  const maxTokens = (body && body.maxTokens) || 800;
  const wordList = ((body && body.words) || [])
    .map((w) => (typeof w === 'string' ? w : (w && w.word) || ''))
    .map((w) => String(w).trim())
    .filter(Boolean);

  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'image 필드(데이터 URI 또는 base64)가 필요해요.' });
    return;
  }
  if (wordList.length === 0) {
    res.status(200).json({ checked: [], missing: [], modelUsed: 'none' });
    return;
  }

  const userMessage = [
    {
      type: 'text',
      text: `Verify these extracted words against the image. Extracted words (JSON): ${JSON.stringify(wordList)}`,
    },
    { type: 'image_url', image_url: { url: image } },
  ];

  const errors = [];
  for (const model of VISION_MODELS) {
    try {
      const resp = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
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
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
      }

      const json = await resp.json();
      if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));

      const raw = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
      if (!raw) throw new Error('Empty response from model');

      const verdict = parseVerdict(raw, wordList);
      if (!verdict) throw new Error('Could not parse verdict from model response');

      res.status(200).json({ ...verdict, modelUsed: model });
      return;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  res.status(502).json({ error: '모든 모델에서 검증에 실패했어요. ' + errors.join(' | ') });
};
