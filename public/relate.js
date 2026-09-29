// 연관도 분석 탭: 종목의 핵심 인물·기관(markets.js 프로필)과 가격의 관계를 실시간 데이터로 살펴본다.
//  1) 핵심 인물·기관 헤드라인 발생 후 30분·60분 가격 반응 (시장 요인 코인 대비 초과 반응 포함)
//  2) 5분봉 수익률과 시장 요인 코인·테마 코인의 상관계수·베타 (시장 요인을 뺀 고유 움직임)
//  3) 정규화 가격 비교 차트 + 헤드라인 마커
//  4) 주요 인물·기관 목록과 인물별 최근 기사 수·최신 헤드라인
// 위 지표는 모두 간접 지표이며 인과관계를 뜻하지 않는다.

const D = window.dash;
const { state, MARKET, BASE, BASKET, PROFILE, KST, restJson, mergeCandles, toCandle, fmt, fmtKRW, kstTime } = D;
const R = PROFILE.relate;
const $ = id => document.getElementById(id);
const FACTOR = BASKET.find(b => b.market) || null;                 // 시장 요인 코인 (예: BTC)
const FACTOR_SHORT = FACTOR ? FACTOR.code.slice(4) : 'BTC';
const THEME = BASKET.filter(b => b.theme);
const NEWS_KEYS = PROFILE.news.map(c => c.key);
const COIN_CAT = PROFILE.news[0]?.key || null;                     // 종목 자체 기사 분류 (뉴스 결합도 계산용)

let news = null, events = [], lastRender = 0, chart = null, series = {}, loadingStarted = false;

// ---------- 바스켓 5분봉 REST 로딩 (app.js 의 REST 큐가 11초 간격을 지켜 준다) ----------
async function loadBasket() {
  if (loadingStarted) return; loadingStarted = true;
  setStatus('비교 종목 캔들을 요청 제한(약 10초당 1회)에 맞춰 차례로 받는 중…');
  for (const b of BASKET) {
    const slot = state.basket[b.code];
    // 캐시가 직전 5분봉까지 담고 있으면 REST 를 건너뛴다 (WebSocket 이 현재 봉을 채운다)
    if (slot.candles5m.length > 50 && slot.candles5m[slot.candles5m.length - 1].time >= Math.floor(Date.now() / 1000 / 300) * 300 - 300) { slot.loaded = true; continue; }
    try {
      const c5 = (await restJson(`/v1/candles/minutes/5?market=${b.code}&count=200`, 3)).reverse().map(toCandle);
      slot.candles5m = mergeCandles(c5, slot.candles5m, 200); slot.loaded = true;
      setStatus(`${b.label} 캔들 수신 완료`);
    } catch { setStatus(`${b.label} 캔들 수신 실패 · WebSocket 으로 누적 중`); }
    D.markDirty();
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
function myItems() { return news ? news.categories.filter(c => NEWS_KEYS.includes(c.key)).flatMap(c => c.items.map(it => ({ ...it, cat: c.key }))) : []; }
function buildEvents() {
  const seen = new Set();
  events = myItems()
    .filter(it => it.cat === R.entityCat || R.entityRe.test(it.title))
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
function betaOf(x, y) { // x = 종목, y = 시장 요인
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
  const w = state.candles5m, fc = FACTOR ? (state.basket[FACTOR.code]?.candles5m || []) : [];
  const themes = THEME.map(b => state.basket[b.code]).filter(s => s && s.candles5m.length > 20);
  const out = { ready: w.length > 20, corr: [], beta4h: null, beta12h: null, events: [], baseline30: null, reactionRatio: null, themeVsFactor: null, factorCorr: null, themeCorrMean: null, newsShare: null };
  if (!out.ready) { out.events = events.map(e => ({ ...e, outOfRange: true })); return out; }

  // 상관계수·베타
  const rows = [...(FACTOR ? [{ label: `${FACTOR.label} (시장 요인)`, candles: fc, kind: 'market' }] : []), ...themes.map(s => ({ label: s.label, candles: s.candles5m, kind: 'theme' }))];
  for (const r of rows) {
    const { rx, ry } = alignedReturns(w, r.candles);
    r.c4h = pearson(rx.slice(-48), ry.slice(-48)); r.c12h = pearson(rx.slice(-144), ry.slice(-144)); r.n = rx.length;
    if (r.kind === 'market') { out.beta4h = betaOf(rx.slice(-48), ry.slice(-48)); out.beta12h = betaOf(rx.slice(-144), ry.slice(-144)); }
    out.corr.push(r);
  }
  const themeCorrs = out.corr.filter(r => r.kind === 'theme' && r.c4h !== null).map(r => r.c4h);
  out.factorCorr = out.corr.find(r => r.kind === 'market')?.c4h ?? null;
  out.themeCorrMean = themeCorrs.length ? mean(themeCorrs) : null;
  out.themeVsFactor = out.themeCorrMean !== null && out.factorCorr !== null ? out.themeCorrMean - out.factorCorr : null;

  // 뉴스 반응: 헤드라인 시각 기준 30분·60분 후 변동, 시장 요인 대비 초과 변동
  const now = Date.now() / 1000, first = w[0].time;
  const abs30 = [];
  for (let i = 6; i < w.length; i++) abs30.push(Math.abs(w[i].close / w[i - 6].close - 1) * 100);
  out.baseline30 = abs30.length ? mean(abs30) : null;
  for (const ev of events) {
    if (ev.ts < first || ev.ts > now) { out.events.push({ ...ev, outOfRange: true }); continue; }
    const p0 = openAt(w, ev.ts), b0 = openAt(fc, ev.ts);
    const r = { ...ev, p0 };
    for (const [k, mins] of [['r30', 30], ['r60', 60]]) {
      const t = ev.ts + mins * 60;
      if (t > now) { r[k] = null; r[k + 'pending'] = true; continue; }
      const p = priceAt(w, t), b = priceAt(fc, t);
      r[k] = p0 && p ? (p / p0 - 1) * 100 : null;
      r[k + 'x'] = r[k] !== null && b0 && b ? r[k] - (b / b0 - 1) * 100 : null;
    }
    if (r.r60 === null && p0 && state.ticker) r.rNow = (state.ticker.price / p0 - 1) * 100;
    out.events.push(r);
  }
  const done = out.events.filter(e => e.r30 !== null && e.r30 !== undefined);
  out.reactionRatio = done.length >= 3 && out.baseline30 ? mean(done.map(e => Math.abs(e.r30))) / out.baseline30 : null;
  out.reactionN = done.length;
  const withX = done.filter(e => e.r30x !== null && e.r30x !== undefined);
  out.excessMean = withX.length ? mean(withX.map(e => e.r30x)) : null;
  // 뉴스 결합도: 종목 기사 중 핵심 인물·기관 언급 비율
  const coinItems = news?.categories.find(c => c.key === COIN_CAT)?.items || [];
  out.newsShare = coinItems.length ? coinItems.filter(it => R.entityRe.test(it.title)).length / coinItems.length : null;
  out.coinNewsN = coinItems.length;
  return out;
}

// ---------- 해석 문장 ----------
function interpret(a) {
  const lines = [];
  if (a.factorCorr !== null) {
    const c = a.factorCorr;
    lines.push(`최근 4시간 ${BASE}와 ${FACTOR_SHORT}의 5분봉 수익률 상관계수는 ${c.toFixed(2)} 입니다. ${c >= 0.6 ? '시장 전체 흐름이 가격을 크게 좌우하는 구간입니다.' : c >= 0.3 ? `시장 흐름의 영향이 중간 정도이며 ${BASE} 고유 요인도 함께 작용하고 있습니다.` : `시장 흐름과 따로 움직이는 편이어서 ${BASE} 고유 재료(${R.entity} 관련 뉴스 등)의 영향이 상대적으로 큽니다.`}`);
  }
  if (a.beta4h !== null) lines.push(`${FACTOR_SHORT} 대비 베타는 ${a.beta4h.toFixed(2)} 로, ${FACTOR_SHORT}가 1% 움직일 때 ${BASE}는 평균 ${a.beta4h.toFixed(2)}% 움직였습니다.`);
  if (a.themeVsFactor !== null) lines.push(`${R.theme.label} 코인과의 평균 상관(${a.themeCorrMean.toFixed(2)})이 ${FACTOR_SHORT}와의 상관보다 ${a.themeVsFactor >= 0.1 ? `높아 "${R.theme.label}"로 묶여 거래되는 성격이 두드러집니다.` : a.themeVsFactor <= -0.1 ? '낮아 테마보다 시장 전체 흐름을 따르고 있습니다.' : '비슷해 뚜렷한 테마 동조는 보이지 않습니다.'}`);
  if (a.reactionRatio !== null) lines.push(`${R.entity} 헤드라인 ${a.reactionN}건 이후 30분 평균 변동폭은 평상시 30분 변동폭의 ${a.reactionRatio.toFixed(1)}배${a.excessMean !== null ? `, ${FACTOR_SHORT} 대비 초과 변동은 평균 ${a.excessMean >= 0 ? '+' : ''}${a.excessMean.toFixed(2)}%p` : ''} 입니다. ${a.reactionRatio >= 1.5 ? '뉴스 직후 가격 반응이 평소보다 뚜렷합니다.' : a.reactionRatio >= 1 ? '뉴스 직후 반응이 평소 수준을 약간 웃도는 정도입니다.' : '뉴스 직후 반응이 평소와 구분되지 않습니다.'}`);
  else if (a.reactionN !== undefined) lines.push(`${R.entity} 헤드라인 이후 반응을 계산할 표본이 ${a.reactionN}건으로 아직 부족합니다(5분봉 데이터 범위 약 16시간).`);
  if (a.newsShare !== null) lines.push(`최근 ${PROFILE.name} 해외 기사 ${a.coinNewsN}건 중 ${(a.newsShare * 100).toFixed(0)}% 가 ${R.entity}을 함께 언급합니다.`);
  lines.push(R.note);
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
    handleScroll: { vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });
  series.me = chart.addLineSeries({ color: '#7c9cff', lineWidth: 2, title: BASE, priceLineVisible: false });
  series.factor = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: FACTOR_SHORT, priceLineVisible: false, lastValueVisible: true });
  series.theme = chart.addLineSeries({ color: '#22c55e', lineWidth: 1, title: `${R.theme.label} 평균`, priceLineVisible: false, lastValueVisible: true });
  series.me.createPriceLine({ price: 0, color: 'rgba(230,234,242,.35)', lineStyle: 2, lineWidth: 1, title: '0%' });
}
function normalized(candles, times) {
  const m = new Map(candles.map(c => [c.time, c.close]));
  const out = []; let first = null;
  for (const t of times) { const v = m.get(t); if (v === undefined) continue; if (first === null) first = v; out.push({ time: t + KST, value: (v / first - 1) * 100 }); }
  return out;
}
function renderChart(a) {
  ensureChart();
  const w = state.candles5m.slice(-144); if (!w.length) return;
  const times = w.map(c => c.time);
  series.me.setData(normalized(w, times));
  const fc = FACTOR ? (state.basket[FACTOR.code]?.candles5m || []) : [];
  series.factor.setData(fc.length ? normalized(fc, times) : []);
  const ths = THEME.map(b => normalized(state.basket[b.code]?.candles5m || [], times)).filter(s => s.length > 5);
  if (ths.length) {
    const acc = new Map();
    for (const s of ths) for (const p of s) { const e = acc.get(p.time) || { sum: 0, n: 0 }; e.sum += p.value; e.n++; acc.set(p.time, e); }
    series.theme.setData([...acc.entries()].filter(([, e]) => e.n === ths.length).map(([time, e]) => ({ time, value: e.sum / e.n })).sort((x, y) => x.time - y.time));
  } else series.theme.setData([]);
  // 헤드라인 마커
  const first = w[0].time, last = w[w.length - 1].time + 300;
  const markers = a.events.filter(e => !e.outOfRange && e.ts >= first && e.ts <= last).map(e => {
    const bar = w.reduce((best, c) => (c.time <= e.ts ? c : best), w[0]);
    return { time: bar.time + KST, position: 'aboveBar', color: e.cat === R.entityCat ? '#ff5b6e' : '#facc15', shape: 'arrowDown', text: '뉴스', size: 1 };
  });
  const byTime = new Map(); for (const m of markers) byTime.set(m.time, m);
  series.me.setMarkers([...byTime.values()].sort((x, y) => x.time - y.time));
}
const pct = (v, d = 2) => v === null || v === undefined ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const cls = v => v === null || v === undefined ? '' : v >= 0 ? 'chg up' : 'chg down';
const when = ts => new Date(ts * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// 주요 인물·기관 카드: 이름·역할, 수집된 헤드라인 중 언급 건수, 최신 헤드라인 1건
function renderPeople() {
  const items = myItems().map(it => ({ ...it, ts: Date.parse(it.publishedAt) })).sort((a, b) => b.ts - a.ts);
  $('rel-people').innerHTML = R.people.length ? R.people.map(p => {
    const hits = items.filter(it => p.re.test(it.title) || (it.titleKo && p.re.test(it.titleKo)));
    const latest = hits[0];
    return `<div class="person"><div class="pn">${p.name}<span class="cnt ${hits.length ? '' : 'zero'}">${hits.length ? `기사 ${hits.length}건` : '최근 기사 없음'}</span></div>
      <div class="pr">${p.role}</div>
      ${latest ? `<div class="pl"><a href="${latest.link}" target="_blank" rel="noopener noreferrer">${latest.titleKo || latest.title}</a><small>${latest.source || ''} · ${when(latest.ts / 1000)}</small></div>` : ''}</div>`;
  }).join('') : '<div class="hold-empty">이 종목은 주요 인물·기관 목록이 없습니다.</div>';
}

function render() {
  if ($('view-relate').hidden) return;
  const a = analyze();
  renderPeople();
  const kp = [];
  kp.push([`${FACTOR_SHORT} 상관 (4h / 12h)`, a.factorCorr !== null ? `${a.factorCorr.toFixed(2)} / ${(a.corr[0]?.c12h ?? 0).toFixed(2)}` : '–', '5분봉 수익률 피어슨 상관계수']);
  kp.push([`${FACTOR_SHORT} 베타 (4h)`, a.beta4h !== null ? a.beta4h.toFixed(2) : '–', a.beta12h !== null ? `12h ${a.beta12h.toFixed(2)}` : `${FACTOR_SHORT} 캔들 대기`]);
  kp.push([`${R.theme.label} 상관 (4h)`, a.themeCorrMean !== null ? a.themeCorrMean.toFixed(2) : '–', a.themeVsFactor !== null ? `${FACTOR_SHORT} 상관 대비 ${a.themeVsFactor >= 0 ? '+' : ''}${a.themeVsFactor.toFixed(2)}` : '테마 코인 캔들 대기']);
  kp.push([`${R.entity} 뉴스 반응 배수`, a.reactionRatio !== null ? `${a.reactionRatio.toFixed(1)}배` : '–', a.reactionN !== undefined ? `헤드라인 ${a.reactionN}건 · 30분 변동폭 / 평상시 ${a.baseline30 ? a.baseline30.toFixed(2) + '%' : ''}` : '']);
  kp.push([`${FACTOR_SHORT} 대비 초과 반응 (30분 평균)`, a.excessMean !== null && a.excessMean !== undefined ? `<span class="${cls(a.excessMean)}">${pct(a.excessMean)}p</span>` : '–', `헤드라인 뒤 ${BASE} 변동 − ${FACTOR_SHORT} 변동`]);
  kp.push(['뉴스 결합도', a.newsShare !== null ? `${(a.newsShare * 100).toFixed(0)}%` : '–', `${PROFILE.name} 해외 기사 ${a.coinNewsN ?? 0}건 중 ${R.entity} 언급`]);
  $('rel-kpis').innerHTML = kp.map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  // 상관 표
  $('rel-corr').innerHTML = `<tr><th style="text-align:left">비교 종목</th><th>상관 4h</th><th>상관 12h</th><th>표본</th></tr>` +
    (a.corr.length ? a.corr.map(r => `<tr><td style="text-align:left">${r.label}</td><td>${r.c4h === null ? '–' : r.c4h.toFixed(2)}</td><td>${r.c12h === null ? '–' : r.c12h.toFixed(2)}</td><td>${r.n}봉</td></tr>`).join('') : '<tr><td colspan="4" class="hold-empty">비교 종목 캔들 수신 대기…</td></tr>');

  // 실시간 시세 비교
  const rows = [{ code: MARKET, label: `${BASE} (보는 중)`, t: state.ticker, c: state.candles5m }, ...BASKET.map(b => ({ code: b.code, label: b.label + (b.market ? ' · 시장 요인' : b.theme ? ` · ${R.theme.label}` : ''), t: state.basket[b.code].ticker, c: state.basket[b.code].candles5m }))];
  $('rel-tickers').innerHTML = `<tr><th style="text-align:left">종목</th><th>현재가</th><th>전일 대비</th><th>1시간</th><th>4시간</th></tr>` + rows.map(r => {
    const h1 = r.c.length > 12 ? (r.c[r.c.length - 1].close / r.c[r.c.length - 13].close - 1) * 100 : null;
    const h4 = r.c.length > 48 ? (r.c[r.c.length - 1].close / r.c[r.c.length - 49].close - 1) * 100 : null;
    const cr = r.t ? r.t.changeRate * 100 : null;
    return `<tr><td style="text-align:left">${r.label}</td><td>${r.t ? fmtKRW(r.t.price) : '–'}</td><td class="${cls(cr)}">${pct(cr)}</td><td class="${cls(h1)}">${pct(h1)}</td><td class="${cls(h4)}">${pct(h4)}</td></tr>`;
  }).join('');

  // 뉴스 이벤트 반응 표
  const evs = a.events.slice(0, 25);
  $('rel-events').innerHTML = evs.length ? evs.map(e => {
    let react;
    if (e.outOfRange) react = `<span class="hold-empty">${a.ready ? '5분봉 범위 밖' : `${BASE} 캔들 수신 대기`}</span>`;
    else react = `<span>30분 <b class="${cls(e.r30)}">${e.r30pending ? '진행 중' : pct(e.r30)}</b>${e.r30x !== null && e.r30x !== undefined ? ` <small>(${FACTOR_SHORT} 대비 ${pct(e.r30x)}p)</small>` : ''}</span>
                  <span>60분 <b class="${cls(e.r60)}">${e.r60pending ? '진행 중' : pct(e.r60)}</b>${e.r60x !== null && e.r60x !== undefined ? ` <small>(${FACTOR_SHORT} 대비 ${pct(e.r60x)}p)</small>` : ''}</span>
                  ${e.rNow !== undefined ? `<span>현재 <b class="${cls(e.rNow)}">${pct(e.rNow)}</b></span>` : ''}`;
    return `<a class="news-item" href="${e.link}" target="_blank" rel="noopener noreferrer">
      <div class="ko">${e.titleKo || e.title}</div>
      <div class="src"><b>${e.source || ''}</b><span>${when(e.ts)}</span>${e.p0 ? `<span>헤드라인 시점 ${fmtKRW(e.p0)}</span>` : ''}</div>
      <div class="react">${react}</div></a>`;
  }).join('') : `<div class="hold-empty">${NEWS_KEYS.length ? '뉴스 데이터 대기…' : '이 종목은 뉴스 분류가 없어 헤드라인 반응을 계산하지 않습니다.'}</div>`;

  $('rel-text').innerHTML = interpret(a).map(l => `<p>${l}</p>`).join('');
  if (a.ready) renderChart(a);
  $('rel-meta').textContent = `갱신 ${kstTime(Date.now())} · ${BASE} 5분봉 ${state.candles5m.length}봉 · 비교 종목 ${BASKET.filter(b => state.basket[b.code].candles5m.length > 20).length}/${BASKET.length} 수신`;
}

// ---------- 시작 ----------
$('rel-title').textContent = R.title;
$('rel-subtitle').textContent = R.subtitle;
$('rel-chart-title').textContent = `최근 12시간 정규화 가격 비교 · ▼ 표시는 ${R.entity} 헤드라인`;
$('rel-events-title').textContent = `${R.entity} 헤드라인 이후 ${BASE} 가격 반응`;
D.subscribe(() => { if (!$('view-relate').hidden && Date.now() - lastRender > 3000) { lastRender = Date.now(); render(); } });
window.addEventListener('hashchange', () => { if (location.hash === '#relate') { loadBasket(); lastRender = Date.now(); render(); } });
// 초기 캔들 뒤에 이어서 받는다. 연관도 탭으로 바로 들어왔으면 비교 종목이 먼저, 관심 종목 1분봉은 그 다음
(D.queueReady || Promise.resolve()).then(loadBasket).then(() => D.loadWatch1m && D.loadWatch1m());
loadNews();
setInterval(loadNews, 5 * 60 * 1000);
