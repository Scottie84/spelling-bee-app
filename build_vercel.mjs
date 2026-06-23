/**
 * build_vercel.mjs — produces the static site for Vercel into dist/.
 *
 * Unlike build.py (which embeds the API key for local file:// use), this build
 * injects an EMPTY key, so engine.js falls back to the /api/extract serverless
 * function. The key therefore never reaches the browser.
 *
 * Run by Vercel via vercel.json "buildCommand": "node build_vercel.mjs".
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SCRIPT_TAG = '<script src="engine.js"></script>';
const PLACEHOLDER = '__OPENROUTER_API_KEY__';
const SB_URL_PLACEHOLDER = '__SUPABASE_URL__';
const SB_KEY_PLACEHOLDER = '__SUPABASE_ANON_KEY__';

// Supabase URL + publishable/anon key are public (RLS protects the data), so
// they are injected into the client. Set these in Vercel → Environment Variables.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const template = readFileSync('index.template.html', 'utf8');
const engine = readFileSync('engine.js', 'utf8');

if (!template.includes(SCRIPT_TAG)) {
  throw new Error(`expected ${SCRIPT_TAG} in index.template.html`);
}
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`expected ${PLACEHOLDER} placeholder in index.template.html`);
}
if (engine.includes('</script>')) {
  throw new Error('engine.js contains a literal </script>; cannot inline safely');
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[build_vercel] SUPABASE_URL / SUPABASE_ANON_KEY not set — the app will fall back to local IndexedDB storage.');
}

// NOTE: use function replacements so `$`-sequences inside engine.js (e.g. the
// `'\\$&'` in _escapeRegex) are inserted literally and NOT interpreted as
// special String.replace patterns ($&, $1, ...). A string replacement here
// would expand `$&` to the matched <script> tag and inject a stray </script>,
// closing the tag early and dumping the rest of the code as visible text.
let html = template
  .replace(SCRIPT_TAG, () => `<script>\n${engine}\n</script>`)
  .replace(PLACEHOLDER, () => '') // no client-side key → uses /api/extract
  .replace(SB_URL_PLACEHOLDER, () => SUPABASE_URL)
  .replace(SB_KEY_PLACEHOLDER, () => SUPABASE_ANON_KEY);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log(`Built dist/index.html (${html.length} bytes, no API key — uses /api/extract; Supabase ${SUPABASE_URL ? 'enabled' : 'disabled'})`);
