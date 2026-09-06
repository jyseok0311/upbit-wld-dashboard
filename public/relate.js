// 연관도 분석 탭: 월드코인(WLD)과 OpenAI 의 관계를 실시간 데이터로 살펴본다.
//  1) OpenAI·올트먼 헤드라인 발생 후 30분·60분 WLD 가격 반응 (비트코인 대비 초과 반응 포함)
//  2) WLD 5분봉 수익률과 비트코인·AI 테마 코인의 상관계수·베타 (시장 요인을 뺀 WLD 고유 움직임)
//  3) 정규화 가격 비교 차트 + OpenAI 뉴스 마커
// OpenAI 는 비상장이라 주가가 없으므로 위 세 가지는 모두 간접 지표이며 인과관계를 뜻하지 않는다.

const D = window.dash;
const { state, MARKET, BASE, BASKET, KST, restJson, mergeCandles, toCandle, fmt, fmtKRW, kstTime } = D;
const $ = id => document.getElementById(id);
const REST = 'https://api.upbit.com';
const NEWS_RE = /openai|altman|올트먼|chatgpt|gpt-?\d|sora|o\d\b/i;

let news = null, events = [], lastRender = 0, chart = null, series = {}, loadingStarted = false;

// ---------- 바스켓 5분봉 REST 로딩 (페이지 로드 60초 이후, 15초 간격 — 분당 6회 제한 준수) ----------
async function loadBasket() {
  if (loadingStarted) return; loadingStarted = true;
  const wait = Math.max(0, 60000 - (Date.now() - state.loadedAt));
  setStatus(`비교 종목 캔들은 요청 제한을 지키기 위해 ${Math.ceil(wait / 1000)}초 후부터 15초 간격으로 받습니다…`);
  await new Promise(r => setTimeout(r, wait));
  for (const b of BASKET) {
    const slot = state.basket[b.code];
    try {
      const c5 = (await restJson(`/v1/candles/minutes/5?market=${b.code}&count=200`, 3)).reverse().map(toCandle);
      slot.candles5m = mergeCandles(c5, slot.candles5m, 200); slot.loaded = true;
      setStatus(`${b.label} 캔들 수신 완료`);
    } catch { setStatus(`${b.label} 캔들 수신 실패 · WebSocket 으로 누적 중`); }
    D.markDirty();
    await new Promise(r => setTimeout(r, 15000));
  }
  setStatus('');
}
function setStatus(msg) { const el = $('rel-status'); el.hidden = !msg; el.textContent = msg; }

// ---------- 뉴스 이벤트 ----------
async function loadNews() {
  try {
    const r = await fetch(`./news.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) news = await r.json();
  } catch { /* 없음 */ }
  buildEvents();
}
function buildEvents() {
  if (!news) { events = []; return; }
  const seen = new Set();
  events = news.categories.flatMap(c => c.items.map(it => ({ ...it, cat: c.key })))
    .filter(it => it.cat === 'openai' || NEWS_RE.test(it.title))
    .filter(it => { if (seen.has(it.link)) return false; seen.add(it.link); return true; })
    .map(it => ({ ...it, ts: Date.parse(it.publishedAt) / 1000 }))
    .sort((a, b) => b.ts - a.ts);
}

// ---------- 통계 ----------
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 8) return null;
  const mx = mean(x.slice(-n)), my = mean(y.slice(-n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[x.length - n + i] - mx, b = y[y.length - n + i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function betaOf(x, y) { // x = WLD, y = 기준(BTC)
  const n = Math.min(x.length, y.length); if (n < 8) return null;
  const mx = mean(x.slice(-n)), my = mean(y.slice(-n));
  let sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[x.length - n + i] - mx, b = y[y.length - n + i] - my; sxy += a * b; syy += b * b; }
  return syy ? sxy / syy : null;
}
function alignedReturns(a, b) {
  const mb = new Map(b.map(c => [c.time, c.close]));
  const pts = a.filter(c => mb.has(c.time)).map(c => ({ t: c.time, x: c.close, y: mb.get(c.time) }));
  const rx = [], ry = [];
  for (let i = 1; i < pts.length; i++) { rx.push(Math.log(pts[i].x / pts[i - 1].x)); ry.push(Math.log(pts[i].y / pts[i - 1].y)); }
  return { rx, ry };
}
const priceAt = (candles, t) => { let p = null; for (const c of candles) { if (c.time <= t) p = c.close; else break; } return p; };
const openAt = (candles, t) => { // 헤드라인 직전 가격: t 이전 마지막 종가, 없으면 첫 시가
  let p = null; for (const c of candles) { if (c.time + 300 <= t) p = c.close; else break; } return p ?? (candles[0] && candles[0].time <= t ? candles[0].open : null);
};

function analyze() {
  const w = state.candles5m, btc = state.basket['KRW-BTC']?.candles5m || [];
  const ai = BASKET.filter(b => b.kind === 'ai').map(b => state.basket[b.code]).filter(s => s.candles5m.length > 20);
  const out = { ready: w.length > 20, corr: [], beta4h: null, beta12h: null, events: [], baseline30: null, reactionRatio: null, aiVsBtc: null };
  if (!out.ready) return out;

  // 상관계수·베타
  const rows = [{ label: '비트코인 (시장 요인)', candles: btc, kind: 'market' }, ...ai.map(s => ({ label: s.label, candles: s.candles5m, kind: 'ai' }))];
  for (const r of rows) {
    const { rx, ry } = alignedReturns(w, r.candles);
    r.c4h = pearson(rx.slice(-48), ry.slice(-48)); r.c12h = pearson(rx.slice(-144), ry.slice(-144)); r.n = rx.length;
    if (r.kind === 'market') { out.beta4h = betaOf(rx.slice(-48), ry.slice(-48)); out.beta12h = betaOf(rx.slice(-144), ry.slice(-144)); }
    out.corr.push(r);
  }
  const aiCorrs = out.corr.filter(r => r.kind === 'ai' && r.c4h !== null).map(r => r.c4h);
  const btcCorr = out.corr.find(r => r.kind === 'market')?.c4h ?? null;
  out.aiCorrMean = aiCorrs.length ? mean(aiCorrs) : null;
  out.aiVsBtc = out.aiCorrMean !== null && btcCorr !== null ? out.aiCorrMean - btcCorr : null;
  out.btcCorr = btcCorr;

  // 뉴스 반응: 헤드라인 시각 기준 30분·60분 후 WLD 변동, BTC 대비 초과 변동
  const now = Date.now() / 1000, first = w[0].time;
  const abs30 = [];
  for (let i = 6; i < w.length; i++) abs30.push(Math.abs(w[i].close / w[i - 6].close - 1) * 100);
  out.baseline30 = abs30.length ? mean(abs30) : null;
  for (const ev of events) {
    if (ev.ts < first || ev.ts > now) { out.events.push({ ...ev, outOfRange: true }); continue; }
    const p0 = openAt(w, ev.ts), b0 = openAt(btc, ev.ts);
    const r = { ...ev, p0 };
    for (const [k, mins] of [['r30', 30], ['r60', 60]]) {
      const t = ev.ts + mins * 60;
      if (t > now) { r[k] = null; r[k + 'pending'] = true; continue; }
      const p = priceAt(w, t), b = priceAt(btc, t);
      r[k] = p0 && p ? (p / p0 - 1) * 100 : null;
      r[k + 'x'] = r[k] !== null && b0 && b ? r[k] - (b / b0 - 1) * 100 : null;
    }
    // 진행 중 이벤트는 현재가 기준 반응도 표시
    if (r.r60 === null && p0 && state.ticker) r.rNow = (state.ticker.price / p0 - 1) * 100;
    out.events.push(r);
  }
  const done = out.events.filter(e => e.r30 !== null && e.r30 !== undefined);
  out.reactionRatio = done.length >= 3 && out.baseline30 ? mean(done.map(e => Math.abs(e.r30))) / out.baseline30 : null;
  out.reactionN = done.length;
  out.excessMean = done.filter(e => e.r30x !== null && e.r30x !== undefined).length ? mean(done.filter(e => e.r30x !== null && e.r30x !== undefined).map(e => e.r30x)) : null;
  // 뉴스 결합도: WLD 기사 중 OpenAI·올트먼 언급 비율
  const wldItems = news?.categories.find(c => c.key === 'wld')?.items || [];
  out.newsShare = wldItems.length ? wldItems.filter(it => NEWS_RE.test(it.title)).length / wldItems.length : null;
  out.wldNewsN = wldItems.length;
  return out;
}

// ---------- 해석 문장 ----------
function interpret(a) {
  const lines = [];
  if (a.btcCorr !== null) {
    const c = a.btcCorr;
    lines.push(`최근 4시간 WLD와 비트코인의 5분봉 수익률 상관계수는 ${c.toFixed(2)} 입니다. ${c >= 0.6 ? '시장 전체 흐름이 WLD 가격을 크게 좌우하는 구간입니다.' : c >= 0.3 ? '시장 흐름의 영향이 중간 정도이며 WLD 고유 요인도 함께 작용하고 있습니다.' : '시장 흐름과 따로 움직이는 편이어서 WLD 고유 재료(OpenAI 관련 뉴스 등)의 영향이 상대적으로 큽니다.'}`);
  }
  if (a.beta4h !== null) lines.push(`비트코인 대비 베타는 ${a.beta4h.toFixed(2)} 로, 비트코인이 1% 움직일 때 WLD는 평균 ${a.beta4h.toFixed(2)}% 움직였습니다.`);
  if (a.aiVsBtc !== null) lines.push(`AI 테마 코인과의 평균 상관(${a.aiCorrMean.toFixed(2)})이 비트코인과의 상관보다 ${a.aiVsBtc >= 0.1 ? '높아 "AI 테마"로 묶여 거래되는 성격이 두드러집니다.' : a.aiVsBtc <= -0.1 ? '낮아 AI 테마보다 시장 전체 흐름을 따르고 있습니다.' : '비슷해 뚜렷한 테마 동조는 보이지 않습니다.'}`);
  if (a.reactionRatio !== null) lines.push(`OpenAI·올트먼 헤드라인 ${a.reactionN}건 이후 30분 평균 변동폭은 평상시 30분 변동폭의 ${a.reactionRatio.toFixed(1)}배${a.excessMean !== null ? `, 비트코인 대비 초과 변동은 평균 ${a.excessMean >= 0 ? '+' : ''}${a.excessMean.toFixed(2)}%p` : ''} 입니다. ${a.reactionRatio >= 1.5 ? '뉴스 직후 가격 반응이 평소보다 뚜렷합니다.' : a.reactionRatio >= 1 ? '뉴스 직후 반응이 평소 수준을 약간 웃도는 정도입니다.' : '뉴스 직후 반응이 평소와 구분되지 않습니다.'}`);
  else if (a.reactionN !== undefined) lines.push(`OpenAI 헤드라인 이후 반응을 계산할 표본이 ${a.reactionN}건으로 아직 부족합니다(5분봉 데이터 범위 약 16시간).`);
  if (a.newsShare !== null) lines.push(`최근 월드코인 해외 기사 ${a.wldNewsN}건 중 ${(a.newsShare * 100).toFixed(0)}% 가 OpenAI·올트먼을 함께 언급합니다.`);
  lines.push('참고: 월드코인(World)은 샘 올트먼이 공동 창업한 Tools for Humanity 가 만든 프로젝트이며, OpenAI 가 WLD 를 보유하거나 운영하는 것은 아닙니다. 위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.');
  return lines;
}

// ---------- 렌더 ----------
function ensureChart() {
  if (chart) return;
  const LWC = window.LightweightCharts;
  chart = LWC.createChart($('rel-chart'), {
    autoSize: true, layout: { background: { color: '#121826' }, textColor: '#8b95ad', fontSize: 11 },
    grid: { vertLines: { color: '#1b2336' }, horzLines: { color: '#1b2336' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232c42', rightOffset: 3 },
    rightPriceScale: { borderColor: '#232c42' }, crosshair: { mode: 0 }, localization: { locale: 'ko-KR', priceFormatter: v => v.toFixed(1) + '%' },
  });
  series.wld = chart.addLineSeries({ color: '#7c9cff', lineWidth: 2, title: BASE, priceLineVisible: false });
  series.btc = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'BTC', priceLineVisible: false, lastValueVisible: true });
  series.ai = chart.addLineSeries({ color: '#22c55e', lineWidth: 1, title: 'AI 평균', priceLineVisible: false, lastValueVisible: true });
  series.wld.createPriceLine({ price: 0, color: 'rgba(230,234,242,.35)', lineStyle: 2, lineWidth: 1, title: '0%' });
}
function normalized(candles, times, base) {
  const m = new Map(candles.map(c => [c.time, c.close]));
  const out = []; let first = null;
  for (const t of times) { const v = m.get(t); if (v === undefined) continue; if (first === null) first = v; out.push({ time: t + KST, value: (v / first - 1) * 100 }); }
  return out;
}
function renderChart(a) {
  ensureChart();
  const w = state.candles5m.slice(-144); if (!w.length) return;
  const times = w.map(c => c.time);
  series.wld.setData(normalized(w, times));
  const btc = state.basket['KRW-BTC']?.candles5m || [];
  series.btc.setData(btc.length ? normalized(btc, times) : []);
  const ais = BASKET.filter(b => b.kind === 'ai').map(b => normalized(state.basket[b.code].candles5m, times)).filter(s => s.length > 5);
  if (ais.length) {
    const acc = new Map();
    for (const s of ais) for (const p of s) { const e = acc.get(p.time) || { sum: 0, n: 0 }; e.sum += p.value; e.n++; acc.set(p.time, e); }
    series.ai.setData([...acc.entries()].filter(([, e]) => e.n === ais.length).map(([time, e]) => ({ time, value: e.sum / e.n })).sort((x, y) => x.time - y.time));
  } else series.ai.setData([]);
  // OpenAI 뉴스 마커
  const first = w[0].time, last = w[w.length - 1].time + 300;
  const markers = a.events.filter(e => !e.outOfRange && e.ts >= first && e.ts <= last).map(e => {
    const bar = w.reduce((best, c) => (c.time <= e.ts ? c : best), w[0]);
    return { time: bar.time + KST, position: 'aboveBar', color: e.cat === 'openai' ? '#ff5b6e' : '#facc15', shape: 'arrowDown', text: 'AI', size: 1 };
  });
  const byTime = new Map(); for (const m of markers) byTime.set(m.time, m);
  series.wld.setMarkers([...byTime.values()].sort((x, y) => x.time - y.time));
}
const pct = (v, d = 2) => v === null || v === undefined ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const cls = v => v === null || v === undefined ? '' : v >= 0 ? 'chg up' : 'chg down';

function render() {
  if ($('view-relate').hidden) return;
  const a = analyze();
  const kp = [];
  kp.push(['BTC 상관 (4h / 12h)', a.btcCorr !== null ? `${a.btcCorr.toFixed(2)} / ${(a.corr[0]?.c12h ?? 0).toFixed(2)}` : '–', '5분봉 수익률 피어슨 상관계수']);
  kp.push(['BTC 베타 (4h)', a.beta4h !== null ? a.beta4h.toFixed(2) : '–', a.beta12h !== null ? `12h ${a.beta12h.toFixed(2)}` : '비트코인 캔들 대기']);
  kp.push(['AI 테마 상관 (4h)', a.aiCorrMean !== null && a.aiCorrMean !== undefined ? a.aiCorrMean.toFixed(2) : '–', a.aiVsBtc !== null ? `BTC 상관 대비 ${a.aiVsBtc >= 0 ? '+' : ''}${a.aiVsBtc.toFixed(2)}` : 'AI 코인 캔들 대기']);
  kp.push(['OpenAI 뉴스 반응 배수', a.reactionRatio !== null ? `${a.reactionRatio.toFixed(1)}배` : '–', a.reactionN !== undefined ? `헤드라인 ${a.reactionN}건 · 30분 변동폭 / 평상시 ${a.baseline30 ? a.baseline30.toFixed(2) + '%' : ''}` : '']);
  kp.push(['BTC 대비 초과 반응 (30분 평균)', a.excessMean !== null && a.excessMean !== undefined ? `<span class="${cls(a.excessMean)}">${pct(a.excessMean)}p</span>` : '–', '헤드라인 뒤 WLD 변동 − BTC 변동']);
  kp.push(['뉴스 결합도', a.newsShare !== null && a.newsShare !== undefined ? `${(a.newsShare * 100).toFixed(0)}%` : '–', `월드코인 해외 기사 ${a.wldNewsN ?? 0}건 중 OpenAI·올트먼 언급`]);
  $('rel-kpis').innerHTML = kp.map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  // 상관 표
  $('rel-corr').innerHTML = `<tr><th style="text-align:left">비교 종목</th><th>상관 4h</th><th>상관 12h</th><th>표본</th></tr>` +
    (a.corr.length ? a.corr.map(r => `<tr><td style="text-align:left">${r.label}</td><td>${r.c4h === null ? '–' : r.c4h.toFixed(2)}</td><td>${r.c12h === null ? '–' : r.c12h.toFixed(2)}</td><td>${r.n}봉</td></tr>`).join('') : '<tr><td colspan="4" class="hold-empty">비교 종목 캔들 수신 대기…</td></tr>');

  // 실시간 시세 비교
  const rows = [{ code: MARKET, label: `${BASE} (월드코인)`, t: state.ticker, c: state.candles5m }, ...BASKET.map(b => ({ code: b.code, label: b.label, t: state.basket[b.code].ticker, c: state.basket[b.code].candles5m }))];
  $('rel-tickers').innerHTML = `<tr><th style="text-align:left">종목</th><th>현재가</th><th>전일 대비</th><th>1시간</th><th>4시간</th></tr>` + rows.map(r => {
    const h1 = r.c.length > 12 ? (r.c[r.c.length - 1].close / r.c[r.c.length - 13].close - 1) * 100 : null;
    const h4 = r.c.length > 48 ? (r.c[r.c.length - 1].close / r.c[r.c.length - 49].close - 1) * 100 : null;
    const cr = r.t ? r.t.changeRate * 100 : null;
    return `<tr><td style="text-align:left">${r.label}</td><td>${r.t ? fmtKRW(r.t.price) : '–'}</td><td class="${cls(cr)}">${pct(cr)}</td><td class="${cls(h1)}">${pct(h1)}</td><td class="${cls(h4)}">${pct(h4)}</td></tr>`;
  }).join('');

  // 뉴스 이벤트 반응 표
  const evs = a.events.slice(0, 25);
  $('rel-events').innerHTML = evs.length ? evs.map(e => {
    const when = new Date(e.ts * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    let react;
    if (e.outOfRange) react = '<span class="hold-empty">5분봉 범위 밖</span>';
    else react = `<span>30분 <b class="${cls(e.r30)}">${e.r30pending ? '진행 중' : pct(e.r30)}</b>${e.r30x !== null && e.r30x !== undefined ? ` <small>(BTC 대비 ${pct(e.r30x)}p)</small>` : ''}</span>
                  <span>60분 <b class="${cls(e.r60)}">${e.r60pending ? '진행 중' : pct(e.r60)}</b>${e.r60x !== null && e.r60x !== undefined ? ` <small>(BTC 대비 ${pct(e.r60x)}p)</small>` : ''}</span>
                  ${e.rNow !== undefined ? `<span>현재 <b class="${cls(e.rNow)}">${pct(e.rNow)}</b></span>` : ''}`;
    return `<a class="news-item" href="${e.link}" target="_blank" rel="noopener noreferrer">
      <div class="ko">${e.titleKo || e.title}</div>
      <div class="src"><b>${e.source || ''}</b><span>${when}</span>${e.p0 ? `<span>헤드라인 시점 ${fmtKRW(e.p0)}</span>` : ''}</div>
      <div class="react">${react}</div></a>`;
  }).join('') : '<div class="hold-empty">뉴스 데이터 대기…</div>';

  $('rel-text').innerHTML = interpret(a).map(l => `<p>${l}</p>`).join('');
  if (a.ready) renderChart(a);
  $('rel-meta').textContent = `갱신 ${kstTime(Date.now())} · WLD 5분봉 ${state.candles5m.length}봉 · 비교 종목 ${BASKET.filter(b => state.basket[b.code].candles5m.length > 20).length}/${BASKET.length} 수신`;
}

// ---------- 시작 ----------
D.subscribe(() => { if (!$('view-relate').hidden && Date.now() - lastRender > 3000) { lastRender = Date.now(); render(); } });
window.addEventListener('hashchange', () => { if (location.hash === '#relate') { loadBasket(); lastRender = Date.now(); render(); } });
if (location.hash === '#relate') { loadBasket(); }
setTimeout(loadBasket, 60000);  // 탭을 열지 않아도 60초 뒤부터 비교 종목 캔들을 받아 둔다
loadNews();
setInterval(loadNews, 5 * 60 * 1000);
