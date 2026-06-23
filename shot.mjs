import { chromium } from 'playwright';

const url = 'file:///C:/dev/spellingbee/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); // phone portrait

await page.goto(url);
await page.waitForFunction(() => window.SnapEngine && window.__ready !== false);
await page.waitForTimeout(400);

// Seed some words so home + quiz look real
await page.evaluate(async () => {
  await window.SnapEngine.clearAll();
  await window.SnapEngine.addWords([
    { word: 'apple', pos: 'n.', meaning: '사과', example: 'I eat an apple.', syn: '', ant: '' },
    { word: 'brave', pos: 'adj.', meaning: '용감한', example: 'A brave boy.', syn: 'bold', ant: 'timid' },
    { word: 'garden', pos: 'n.', meaning: '정원', example: 'A big garden.', syn: '', ant: '' },
    { word: 'quickly', pos: 'adv.', meaning: '빠르게', example: 'She ran quickly.', syn: 'fast', ant: 'slow' },
    { word: 'happy', pos: 'adj.', meaning: '행복한', example: 'A happy dog.', syn: 'glad', ant: 'sad' },
    { word: 'river', pos: 'n.', meaning: '강', example: 'A long river.', syn: '', ant: '' },
  ], 'Chapter 11');
});
await page.reload();
await page.waitForTimeout(600);
await page.screenshot({ path: 'shot-home.png' });

// Navigate into a quiz and answer to capture the play screen
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => /퀴즈/.test(x.textContent));
  if (b) b.click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  const start = [...document.querySelectorAll('button')].find(x => /시작/.test(x.textContent));
  if (start) start.click();
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'shot-quiz.png' });

await browser.close();
console.log('wrote shot-home.png and shot-quiz.png');
