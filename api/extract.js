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
const VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
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

      const words = parseWordArray(raw);
      if (!words) throw new Error('Could not parse word array from model response');

      res.status(200).json({ words, modelUsed: model });
      return;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  res.status(502).json({ error: '모든 모델에서 추출에 실패했어요. ' + errors.join(' | ') });
};
