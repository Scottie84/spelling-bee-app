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

// NOTE: use function replacements so `$`-sequences inside engine.js (e.g. the
// `'\\$&'` in _escapeRegex) are inserted literally and NOT interpreted as
// special String.replace patterns ($&, $1, ...). A string replacement here
// would expand `$&` to the matched <script> tag and inject a stray </script>,
// closing the tag early and dumping the rest of the code as visible text.
let html = template
  .replace(SCRIPT_TAG, () => `<script>\n${engine}\n</script>`)
  .replace(PLACEHOLDER, () => ''); // no client-side key → uses /api/extract

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log(`Built dist/index.html (${html.length} bytes, no API key — uses /api/extract)`);
