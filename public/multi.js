// "4종목 한눈에" 탭: 관심 종목(WLD·BTC·ETH·SOL)을 같은 점수제(engine.js)로 판정해 카드로 나란히 보여준다.
// 현재 보고 있는 종목은 app.js 가 계산한 결과를 그대로 쓰고, 나머지는 바스켓으로 받은 1분봉·5분봉·호가·체결로 여기서 계산한다.
// 어느 종목이든 강한 타이밍이 뜨면 종목별 5분 간격으로 타이밍 알림을 보낸다 (설정의 "타이밍 알림"을 따른다).
import { computeAll } from './engine.js';

const D = window.dash;
const { state, MARKET, WATCH, KST, fmt, fmtKRW, big, kstTime, notify, settings } = D;
const $ = id => document.getElementById(id);
const LWC = window.LightweightCharts;
const COOLDOWN = 5 * 60 * 1000;

const charts = {};                    // code → { chart, series, ema9 }
const lastNotify = {};                // code → ms
let lastRender = 0, lastCompute = 0;
const results = {};                   // code → computeAll 결과 (현재 종목 제외)

// innerHTML/텍스트는 바뀐 경우에만 넣는다
const htmlCache = new WeakMap();
const setHTML = (el, html) => { if (htmlCache.get(el) === html) return; htmlCache.set(el, html); el.innerHTML = html; };
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const pct = v => v === null || v === undefined ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const cls = v => v === null || v === undefined ? '' : v >= 0 ? 'chg up' : 'chg down';
const STATUS_LABEL = { neutral: '관망', buy_watch: '매수 준비', sell_watch: '매도 준비', buy_strong: '▲ 매수 타이밍', sell_strong: '▼ 매도 타이밍' };
const TREND = { strong_up: '강한 상승', up: '상승', down: '하락·횡보', strong_down: '강한 하락' };

function dataFor(code) {
  if (code === MARKET) return { candles1m: state.candles1m, candles5m: state.candles5m, orderbook: state.orderbook, trades: state.trades, ticker: state.ticker, computed: state.computed, mine: true };
  const b = state.basket[code];
  return b ? { ...b, computed: results[code] || null, mine: false } : null;
}

// 타이밍 알림: 현재 종목은 app.js 가 이미 보내므로 나머지 종목만 여기서 처리
function compute() {
  const now = Date.now();
  for (const w of WATCH) {
    if (w.code === MARKET) continue;
    const d = dataFor(w.code); if (!d) continue;
    const c = d.candles1m.length >= 60 ? computeAll({ candles1m: d.candles1m, candles5m: d.candles5m, orderbook: d.orderbook, trades: d.trades, now }) : null;
    results[w.code] = c;
    if (!c || !settings.signalAlerts) continue;
    const st = c.signals.status;
    if ((st === 'buy_strong' || st === 'sell_strong') && now - (lastNotify[w.code] || 0) > COOLDOWN) {
      lastNotify[w.code] = now;
      const kind = st === 'buy_strong' ? 'buy' : 'sell', score = kind === 'buy' ? c.signals.buyScore : c.signals.sellScore;
      const p = c.signals.plan, trig = (kind === 'buy' ? c.signals.buyParts : c.signals.sellParts).triggers.map(t => t.label.split(' (')[0]).join(', ');
      notify(kind, `${w.short} ${kind === 'buy' ? '▲ 매수' : '▼ 매도'} 타이밍 · ${score}점`,
        `${w.code} ${fmtKRW(c.indicators.price)} · ${trig}${p ? ` · 목표 ${fmtKRW(p.target1)} / 손절 ${fmtKRW(p.stop)}` : ''}`);
    }
  }
}

function ensureChart(code) {
  if (charts[code]) return charts[code];
  const el = $(`mchart-${code}`); if (!el) return null;
  const chart = LWC.createChart(el, {
    autoSize: true, layout: { background: { color: '#121826' }, textColor: '#8b95ad', fontSize: 10 },
    grid: { vertLines: { color: '#1b2336' }, horzLines: { color: '#1b2336' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232c42', rightOffset: 2, barSpacing: 4 },
    rightPriceScale: { borderColor: '#232c42' }, crosshair: { mode: 0 },
    localization: { locale: 'ko-KR', priceFormatter: p => p >= 10000 ? Math.round(p).toLocaleString('ko-KR') : p.toFixed(1) },
    handleScroll: { vertTouchDrag: false, mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: true },
  });
  const series = chart.addCandlestickSeries({ upColor: '#ff5b6e', downColor: '#3f8cff', borderVisible: false, wickUpColor: '#ff5b6e', wickDownColor: '#3f8cff', priceLineVisible: true });
  const ema9 = chart.addLineSeries({ color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const ema21 = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  charts[code] = { chart, series, ema9, ema21, first: true, lastLen: 0, lastFirst: 0 };
  return charts[code];
}
const shift = arr => arr.map(p => ({ ...p, time: p.time + KST }));

function cardHtml(w) {
  return `<div class="mcard neutral" id="mcard-${w.code}">
    <div class="mhead"><div class="mname"><b>${w.short}</b><span>${w.label.replace(/\(.*\)/, '')}</span></div>
      <div class="mprice" id="mprice-${w.code}">–</div>
      ${w.code === MARKET ? '<span class="pill neutral">보는 중</span>' : `<a class="btn" href="?market=${w.code}#dash">열기</a>`}</div>
    <div class="mstatus"><span class="pill neutral" id="mpill-${w.code}">데이터 대기</span>
      <div class="mgauge"><div class="g buy"><span id="mgb-${w.code}">매수 –</span><i id="mgbi-${w.code}" style="width:0"></i><b style="left:65%"></b></div>
        <div class="g sell"><span id="mgs-${w.code}">매도 –</span><i id="mgsi-${w.code}" style="width:0"></i><b style="left:65%"></b></div></div></div>
    <div class="mchart" id="mchart-${w.code}"></div>
    <div class="mkpis" id="mkpi-${w.code}"></div>
    <div class="mtrig" id="mtrig-${w.code}"></div>
    <div class="mplan" id="mplan-${w.code}"></div>
  </div>`;
}

function renderCard(w) {
  const d = dataFor(w.code); if (!d) return;
  const t = d.ticker, c = d.computed, sg = c?.signals;
  const card = $(`mcard-${w.code}`);
  card.className = `mcard ${sg ? sg.status : 'neutral'}${d.mine ? ' me' : ''}`;
  if (t) setHTML($(`mprice-${w.code}`), `${fmtKRW(t.price)}<span class="chg ${t.changeRate >= 0 ? 'up' : 'down'}">${t.changeRate >= 0 ? '▲' : '▼'}${(Math.abs(t.changeRate) * 100).toFixed(2)}%</span>`);

  const pill = $(`mpill-${w.code}`);
  if (sg) {
    const score = sg.status.startsWith('buy') ? sg.buyScore : sg.status.startsWith('sell') ? sg.sellScore : null;
    setText(pill, score !== null ? `${STATUS_LABEL[sg.status]} · ${score}점` : `${STATUS_LABEL.neutral} · 매수 ${sg.buyScore} / 매도 ${sg.sellScore}`);
    pill.className = `pill ${sg.status}`;
    setText($(`mgb-${w.code}`), `매수 ${sg.buyScore}`); $(`mgbi-${w.code}`).style.width = `${sg.buyScore}%`;
    setText($(`mgs-${w.code}`), `매도 ${sg.sellScore}`); $(`mgsi-${w.code}`).style.width = `${sg.sellScore}%`;
  } else {
    setText(pill, `1분봉 수신 중 ${d.candles1m.length}/60`); pill.className = 'pill neutral';
  }

  // 미니 차트: 최근 1분봉 120개 + EMA 9/21
  const ch = ensureChart(w.code);
  if (ch && d.candles1m.length) {
    // 봉이 1개 이하로 바뀌었으면 마지막 봉만 update(), 아니면 setData()
    const win = d.candles1m.slice(-120), n = d.candles1m.length, first = d.candles1m[0].time;
    const inc = !ch.first && first === ch.lastFirst && n - ch.lastLen >= 0 && n - ch.lastLen <= 1;
    const push = (series, arr) => { if (!arr.length) return; if (inc) series.update(arr[arr.length - 1]); else series.setData(arr); };
    push(ch.series, shift(win));
    if (c) { push(ch.ema9, shift(c.indicators.series.ema9.slice(-120))); push(ch.ema21, shift(c.indicators.series.ema21.slice(-120))); }
    ch.lastLen = n; ch.lastFirst = first;
    if (ch.first) { ch.chart.timeScale().scrollToRealTime(); ch.first = false; }
  }

  // 요약 지표
  const c5 = d.candles5m;
  const h1 = c5.length > 12 ? (c5[c5.length - 1].close / c5[c5.length - 13].close - 1) * 100 : null;
  const h4 = c5.length > 48 ? (c5[c5.length - 1].close / c5[c5.length - 49].close - 1) * 100 : null;
  const kp = [];
  kp.push(`1h <b class="${cls(h1)}">${pct(h1)}</b>`, `4h <b class="${cls(h4)}">${pct(h4)}</b>`);
  if (c) {
    const i = c.indicators;
    kp.push(`RSI <b>${i.rsi?.toFixed(1) ?? '–'}</b>`, `%B <b>${i.pctB === null ? '–' : i.pctB.toFixed(2)}</b>`, `VWAP 대비 <b>${i.vwapDistAtr === null ? '–' : (i.vwapDistAtr >= 0 ? '+' : '') + i.vwapDistAtr.toFixed(1) + ' ATR'}</b>`,
      `거래량 <b>${i.volRatio === null ? '–' : i.volRatio.toFixed(2) + '배'}</b>`, `5분봉 <b>${c.trend5m ? TREND[c.trend5m.strength] : '대기'}</b>`,
      `호가 <b>${d.orderbook ? d.orderbook.bidAskRatio.toFixed(2) + '배' : '–'}</b>`, `체결 매수 <b>${c.tradeStat ? (c.tradeStat.buyRatio * 100).toFixed(0) + '%' : '–'}</b>`);
  }
  if (t) kp.push(`24h 거래대금 <b>${big(t.accTradePrice24h)}원</b>`);
  setHTML($(`mkpi-${w.code}`), kp.map(x => `<span>${x}</span>`).join(''));

  // 켜진 트리거 · 실행 계획
  if (sg) {
    const bt = sg.buyParts.triggers.map(x => `<span class="t buy">${x.label.split(' (')[0]}</span>`).join('');
    const st = sg.sellParts.triggers.map(x => `<span class="t sell">${x.label.split(' (')[0]}</span>`).join('');
    setHTML($(`mtrig-${w.code}`), bt || st ? `<span class="lb">트리거</span>${bt}${st}` : '<span class="lb">트리거 없음 · 셋업·확인만 반영 중</span>');
    const p = sg.plan;
    setHTML($(`mplan-${w.code}`), p ? `${p.side === 'buy' ? '진입' : '신호'} <b>${fmtKRW(p.entry)}</b> · 목표 <b>${fmtKRW(p.target1)}</b> / <b>${fmtKRW(p.target2)}</b> · <span class="stop">손절 ${fmtKRW(p.stop)}</span> · 손익비 <b>${p.rr.toFixed(1)}</b>` : '');
  } else { setHTML($(`mtrig-${w.code}`), ''); setHTML($(`mplan-${w.code}`), ''); }
}

function render() {
  if ($('view-multi').hidden) return;
  const grid = $('multi-grid');
  if (!grid.children.length) grid.innerHTML = WATCH.map(cardHtml).join('');
  for (const w of WATCH) renderCard(w);
  const ready = WATCH.filter(w => dataFor(w.code)?.computed).length;
  setText($('multi-meta'), `갱신 ${kstTime(Date.now())} · 판정 가능 ${ready}/${WATCH.length} 종목`);
}

// 3초마다 판정(알림 포함), 화면이 열려 있을 때만 그린다
D.subscribe(() => {
  const now = Date.now();
  if (now - lastCompute > 3000) { lastCompute = now; compute(); }
  if (!$('view-multi').hidden && now - lastRender > 2000) { lastRender = now; render(); }
});
window.addEventListener('hashchange', () => { if (location.hash === '#multi') { for (const ch of Object.values(charts)) ch.first = true; lastRender = Date.now(); render(); } });
if (location.hash === '#multi') setTimeout(render, 300);
