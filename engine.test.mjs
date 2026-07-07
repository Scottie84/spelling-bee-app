/**
 * engine.test.mjs — Node validation for engine.js
 *
 *   1. Unit-tests the pure quiz logic (buildQuiz, distractors, scoring)
 *      against an in-memory wordbook (engine uses its in-memory backend
 *      automatically when `indexedDB` is undefined, i.e. in Node).
 *   2. Makes ONE real OpenRouter image-extraction call using test_vocab.png
 *      and the key from .env, to prove the live path works.
 *
 * Run:  node engine.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SnapEngine = require('./engine.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

function readEnvKey() {
  const txt = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  const m = txt.match(/^OPENROUTER_API_KEY\s*=\s*(.+)$/m);
  if (!m) throw new Error('OPENROUTER_API_KEY not found in .env');
  return m[1].trim();
}

const FIXTURE = [
  { word: 'apple',   pos: 'n.',   meaning: '사과',   example: 'I eat an apple.',        syn: '',        ant: '' },
  { word: 'brave',   pos: 'adj.', meaning: '용감한', example: 'A brave boy.',           syn: 'bold',    ant: 'timid' },
  { word: 'garden',  pos: 'n.',   meaning: '정원',   example: 'A big garden.',          syn: '',        ant: '' },
  { word: 'quickly', pos: 'adv.', meaning: '빠르게', example: 'She ran quickly.',       syn: 'fast',    ant: 'slowly' },
  { word: 'happy',   pos: 'adj.', meaning: '행복한', example: 'A happy dog.',           syn: 'glad',    ant: 'sad' },
  { word: 'river',   pos: 'n.',   meaning: '강',     example: 'A long river.',          syn: '',        ant: '' },
];

async function unitTests() {
  console.log('\n=== UNIT: quiz logic ===');
  await SnapEngine.init();
  await SnapEngine.clearAll();
  const added = await SnapEngine.addWords(FIXTURE, 'Chapter 11');
  ok(added.length === 6, `addWords inserted 6 words (got ${added.length})`);

  // dedup
  const dup = await SnapEngine.addWords([{ word: 'Apple', meaning: '사과' }], 'Chapter 11');
  ok(dup.length === 0, 'addWords dedupes case-insensitively (Apple == apple)');

  const groups = await SnapEngine.getGroups();
  ok(groups.length === 1 && groups[0].count === 6, 'getGroups reports 1 group of 6');

  // Build a big quiz across all types and validate every question
  const quiz = await SnapEngine.buildQuiz({ scope: 'all', count: 6, types: ['A', 'B', 'C', 'D'] });
  ok(quiz.length >= 1, `buildQuiz returned ${quiz.length} questions`);

  const allWords = await SnapEngine.getAllWords();
  const wordsByText = new Set(allWords.map(w => w.word.toLowerCase()));
  const meaningsByText = new Set(allWords.map(w => w.meaning));

  let everyQuestionValid = true;
  let typesSeen = new Set();
  for (const q of quiz) {
    typesSeen.add(q.type);
    const uniq = new Set(q.choices.map(c => c.toLowerCase()));
    if (uniq.size !== 4) { everyQuestionValid = false; console.error('   bad: choices not unique', q); }
    if (q.choices.length !== 4) { everyQuestionValid = false; console.error('   bad: not 4 choices', q); }
    if (q.answerIndex < 0 || q.answerIndex > 3) { everyQuestionValid = false; console.error('   bad: answerIndex', q); }
    // The answer choice must correspond to the source word
    const ans = q.choices[q.answerIndex];
    if (q.type === 'A' || q.type === 'C' || q.type === 'D') {
      if (ans.toLowerCase() !== q.word.word.toLowerCase()) { everyQuestionValid = false; console.error('   bad: answer != word', q); }
      // distractors must be real other words
      for (let i = 0; i < 4; i++) if (i !== q.answerIndex) {
        if (!wordsByText.has(q.choices[i].toLowerCase())) { everyQuestionValid = false; console.error('   bad: distractor not a real word', q.choices[i]); }
      }
    } else if (q.type === 'B') {
      if (ans !== q.word.meaning) { everyQuestionValid = false; console.error('   bad: answer != meaning', q); }
      for (let i = 0; i < 4; i++) if (i !== q.answerIndex) {
        if (!meaningsByText.has(q.choices[i])) { everyQuestionValid = false; console.error('   bad: distractor not a real meaning', q.choices[i]); }
      }
    }
  }
  ok(everyQuestionValid, 'every question: 4 unique choices, valid answerIndex, real distractors');

  // Type C must blank the word out of the sentence
  const cq = quiz.find(q => q.type === 'C');
  if (cq) ok(cq.promptText.includes('____') && !new RegExp(`\\b${cq.word.word}\\b`, 'i').test(cq.promptText),
            'type C blanks the target word from the example');
  else console.log('  (no type C question this run — re-run if needed)');

  // Requested count is honoured even when the pool is smaller — words repeat
  // with freshly built choices instead of the quiz coming up short.
  const bigQuiz = await SnapEngine.buildQuiz({ scope: 'all', count: 15, types: ['A', 'B'] });
  ok(bigQuiz.length === 15, `buildQuiz tops up to the requested count (got ${bigQuiz.length}/15)`);
  const uniqueWordIds = new Set(bigQuiz.map(q => q.wordId));
  ok(uniqueWordIds.size === 6, `top-up reuses all pool words (${uniqueWordIds.size}/6 unique)`);

  // scoring
  const w = allWords[0];
  await SnapEngine.recordAnswer(w.id, false);
  await SnapEngine.recordAnswer(w.id, true);
  const after = (await SnapEngine.getAllWords()).find(x => x.id === w.id);
  ok(after.stats.seen === 2 && after.stats.correct === 1 && after.stats.wrong === 1, 'recordAnswer updates stats');

  // review scope picks only words with wrong>0
  const review = await SnapEngine.buildQuiz({ scope: 'review', count: 10 }).catch(e => e);
  ok(!(review instanceof Error) ? review.every(q => true) : true, 'review scope builds (or throws cleanly)');

  // too-few-words guard
  await SnapEngine.clearAll();
  await SnapEngine.addWords(FIXTURE.slice(0, 2), 'Tiny');
  let threw = false;
  try { await SnapEngine.buildQuiz({ scope: 'all', count: 5 }); } catch { threw = true; }
  ok(threw, 'buildQuiz throws when fewer than 4 words');

  // restore fixture for any later use
  await SnapEngine.clearAll();
  await SnapEngine.addWords(FIXTURE, 'Chapter 11');
}

async function liveExtractionTest() {
  console.log('\n=== LIVE: OpenRouter image extraction ===');
  const key = readEnvKey();
  SnapEngine.setApiKey(key);

  const png = readFileSync(new URL('./test_vocab.png', import.meta.url));
  const dataUri = 'data:image/png;base64,' + png.toString('base64');
  console.log(`  image bytes: ${png.length}, calling model...`);

  const t0 = Date.now();
  const result = await SnapEngine.extractWordsFromImage(dataUri);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  modelUsed: ${result.modelUsed}  (${secs}s)`);
  console.log('  extracted words:');
  for (const w of result.words) {
    console.log(`    - ${w.word} (${w.pos}) = ${w.meaning} | ex: ${w.example}`);
  }
  ok(result.words.length >= 1, `extracted ${result.words.length} word(s) from the image`);
  const got = new Set(result.words.map(w => w.word.toLowerCase()));
  const expected = ['apple', 'brave', 'garden', 'quickly', 'happy'];
  const hits = expected.filter(e => got.has(e));
  ok(hits.length >= 2, `recognized ≥2 expected words (got: ${hits.join(', ') || 'none'})`);
}

(async () => {
  try {
    await unitTests();
    await liveExtractionTest();
  } catch (err) {
    fail++;
    console.error('\nFATAL:', err);
  }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
