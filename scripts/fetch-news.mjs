// 해외(영문) 뉴스 수집 + 한국어 번역 → public/news.json
// 구글 뉴스 RSS(미국판)에서 월드코인·OpenAI 관련 기사를 모아 제목을 한국어로 번역한다.
// 번역 결과는 .news-cache.json 에 캐시해 다음 실행에서 재사용한다 (GitHub Actions 에서는 actions/cache 로 보존).
//
// 실행: node scripts/fetch-news.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'news.json');
const CACHE = path.join(ROOT, '.news-cache.json');
const MAX_PER_CAT = 40;
const MAX_NEW_TRANSLATIONS = 90;

const CATEGORIES = [
  {
    key: 'wld', label: '월드코인 · World',
    query: '(Worldcoin OR "WLD token" OR "Tools for Humanity" OR ("World Network" (crypto OR token OR Altman OR blockchain)) OR ("World ID" (Altman OR crypto OR iris OR Orb))) when:7d',
    // 제목에 월드코인 관련 단어가 실제로 있어야 함 (Animation World Network 등 오탐 제거)
    mustMatch: /worldcoin|\bwld\b|tools for humanity|world network|world id|world app|\borb\b|altman|iris.?scan|eye.?scan/i,
  },
  { key: 'openai', label: 'OpenAI · 샘 올트먼', query: '(OpenAI OR "Sam Altman" OR ChatGPT) when:1d', mustMatch: /openai|altman|chatgpt|gpt/i },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };
const hasHangul = s => /[ㄱ-ㆎ가-힣]/.test(s);
const norm = s => s.toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();

async function fetchRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (news-fetch; +https://github.com/jyseok0311/upbit-wld-dashboard)' } });
  if (!r.ok) throw new Error(`RSS ${r.status} ${query}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return items.map(it => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const pub = tag(it, 'pubDate');
    return { title, link: tag(it, 'link'), source, publishedAt: pub ? new Date(pub).toISOString() : new Date().toISOString() };
  }).filter(x => x.title && x.link);
}

// ---------- 번역 ----------
async function translateGoogle(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`gtx ${r.status}`);
  const data = await r.json();
  const out = (data[0] || []).map(s => s[0]).join('').trim();
  if (!out) throw new Error('gtx empty');
  return out;
}
async function translateMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en%7Cko`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`mymemory ${r.status}`);
  const data = await r.json();
  const out = data?.responseData?.translatedText || '';
  if (data.responseStatus !== 200 || !out || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory quota/empty');
  return out;
}
let gtxBlocked = false;
async function translate(text) {
  if (!gtxBlocked) {
    try { return await translateGoogle(text); }
    catch (e) { if (String(e.message).includes('429')) gtxBlocked = true; }
  }
  return translateMyMemory(text);
}

async function main() {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* 캐시 없음 */ }
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 이전 결과 없음 */ }

  const categories = [];
  let newTranslations = 0, failures = 0;
  for (const cat of CATEGORIES) {
    let items = [];
    try { items = await fetchRss(cat.query); }
    catch (e) { console.error(`[news] ${cat.key} RSS 실패:`, e.message); items = prev?.categories?.find(c => c.key === cat.key)?.items || []; }
    // 해외 기사 위주: 한글 제목 제외, 중복 제거, 최신순
    const seen = new Set();
    items = items.filter(it => !hasHangul(it.title)).filter(it => !cat.mustMatch || cat.mustMatch.test(it.title))
      .filter(it => { const k = norm(it.title); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, MAX_PER_CAT);
    for (const it of items) {
      if (cache[it.title]) { it.titleKo = cache[it.title]; continue; }
      if (newTranslations >= MAX_NEW_TRANSLATIONS) { it.titleKo = ''; continue; }
      try {
        it.titleKo = await translate(it.title); cache[it.title] = it.titleKo; newTranslations++;
        await sleep(gtxBlocked ? 400 : 150);
      } catch (e) { failures++; it.titleKo = ''; }
    }
    categories.push({ key: cat.key, label: cat.label, items });
  }

  // 캐시 크기 제한 (최근 2000건)
  const keys = Object.keys(cache);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete cache[k];

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), categories }, null, 1), 'utf8');
  await writeFile(CACHE, JSON.stringify(cache), 'utf8');
  const total = categories.reduce((a, c) => a + c.items.length, 0);
  console.log(`[news] ${total}건 저장 (새 번역 ${newTranslations}, 실패 ${failures}${gtxBlocked ? ', gtx 차단→MyMemory' : ''}) → ${path.relative(ROOT, OUT)}`);
}

main().catch(e => { console.error('[news] 실패:', e); process.exit(1); });
