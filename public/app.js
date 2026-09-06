// 브라우저 앱: 업비트 공개 REST(초기 캔들)와 WebSocket(실시간)으로 데이터를 받아 engine.js 로 조건을 판정한다.
// 서버 없이 GitHub Pages 같은 정적 호스팅에서 동작한다. 잔고 패널은 로컬 서버(/api/holdings)가 있을 때만 채워진다.
// 알림: 보유 수량·평균 매수가를 입력하면 수익률이 목표(기본 20%) 단계를 넘을 때마다 매도 알림,
//       최근 고점·전일 종가 대비 기준(기본 20%) 이상 급락하면 매수 알림을 브라우저 알림으로 보낸다.
import { computeAll } from './engine.js';

const params = new URLSearchParams(location.search);
const MARKET = (params.get('market') || 'KRW-WLD').toUpperCase();
const BASE = MARKET.split('-')[1];
const REST = 'https://api.upbit.com';
const WS_URL = 'wss://api.upbit.com/websocket/v1';
const KST = 9 * 3600;
const LS_KEY = `scalp-dash:${MARKET}`;

// 연관도 분석용 비교 바스켓: 시장 요인(비트코인) + 업비트 상장 AI 테마 코인. WebSocket 한 연결로 함께 수신한다.
const BASKET = [
  { code: 'KRW-BTC', label: '비트코인', kind: 'market' },
  { code: 'KRW-TAO', label: '비트텐서(TAO)', kind: 'ai' },
  { code: 'KRW-NEAR', label: '니어(NEAR)', kind: 'ai' },
  { code: 'KRW-RENDER', label: '렌더(RENDER)', kind: 'ai' },
].filter(b => b.code !== MARKET);

const state = {
  market: MARKET, candles1m: [], candles5m: [], orderbook: null, trades: [], ticker: null,
  error: null, updatedAt: null, conn: 'connecting', log: [], alertLog: [], holdings: { status: 'unknown' }, computed: null,
  basket: Object.fromEntries(BASKET.map(b => [b.code, { ...b, ticker: null, candles5m: [], loaded: false }])),
  bootstrapFailed: false, loadedAt: Date.now(),
};
let dirty = false, lastStatus = null, firstDraw = true, holdingsFailures = 0, swReg = null;
const listeners = new Set();

// ---------- 설정 (localStorage) ----------
const DEFAULTS = { qty: 0, avgPrice: 0, takeProfitPct: 20, dropPct: 20, dropWindowMin: 180, notify: true, sound: true };
const settings = { ...DEFAULTS };
const alertState = { lastSellLevel: 0, dropFired: false };
function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    Object.assign(settings, saved.settings || {});
    Object.assign(alertState, saved.alertState || {});
    state.alertLog = saved.alertLog || [];
  } catch { /* 저장값 없음 */ }
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ settings, alertState, alertLog: state.alertLog.slice(0, 50) })); } catch { /* 무시 */ }
}

// ---------- 유틸 ----------
const $ = id => document.getElementById(id);
const fmt = (n, d = 0) => n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtKRW = n => fmt(n) + '원';
const big = n => n === null || n === undefined ? '–' : n >= 1e8 ? (n / 1e8).toFixed(1) + '억' : n >= 1e4 ? (n / 1e4).toFixed(0) + '만' : fmt(n);
const kstTime = ms => new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toCandle = c => ({
  time: Math.floor(Date.parse(c.candle_date_time_utc + 'Z') / 1000), kst: c.candle_date_time_kst,
  open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume,
});
const toTrade = t => ({ ts: t.timestamp ?? t.trade_timestamp, price: t.trade_price, volume: t.trade_volume, side: t.ask_bid });
function setError(msg) { state.error = msg; const el = $('err'); el.hidden = !msg; el.textContent = msg ? `알림: ${msg}` : ''; }
function setConn(c) { state.conn = c; }

// ---------- REST 초기 데이터 (브라우저 Origin 요청은 분당 6회 수준으로 제한되므로 최소한만 호출) ----------
// 업비트는 Origin 이 붙은 요청(REST + WebSocket 접속)을 IP 단위로 분당 약 6회로 제한한다.
// 429 응답에는 CORS 헤더가 없어 브라우저에서는 "Failed to fetch"(TypeError) 로 보이므로 둘을 같은 제한으로 취급한다.
async function restJson(path, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(REST + path, { cache: 'no-store' }); }
    catch { r = { status: 429 }; }
    if (r.status === 429) { const wait = 15 * (i + 1); setError(`업비트 요청 제한 · ${wait}초 후 자동 재시도 (${i + 1}/${tries})`); await sleep(wait * 1000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return r.json();
  }
  throw new Error('rate-limited');
}

// REST 캔들(과거)과 WebSocket 으로 이미 쌓인 캔들(최신)을 시간 기준으로 합친다
function mergeCandles(rest, live, max) {
  const map = new Map();
  for (const c of rest) map.set(c.time, c);
  for (const c of live) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-max);
}

async function bootstrap() {
  setError('초기 캔들 데이터를 받는 중…');
  try {
    const c1 = (await restJson(`/v1/candles/minutes/1?market=${MARKET}&count=200`)).reverse().map(toCandle);
    state.candles1m = mergeCandles(c1, state.candles1m, 300);
    dirty = true;
    await sleep(1500);
    const c5 = (await restJson(`/v1/candles/minutes/5?market=${MARKET}&count=120`)).reverse().map(toCandle);
    state.candles5m = mergeCandles(c5, state.candles5m, 200);
    state.bootstrapFailed = false;
    setError(null);
  } catch {
    // REST 를 못 받아도 WebSocket 1분봉이 쌓이면 60분 뒤부터 지표가 계산된다
    state.bootstrapFailed = true;
    setError(`업비트 요청 제한으로 과거 캔들을 받지 못했습니다. 실시간 캔들을 누적 중 (${state.candles1m.length}/60) · 1~2분 뒤 새로 고침하면 바로 받을 수 있습니다.`);
  }
  dirty = true;
}

// ---------- WebSocket 실시간 ----------
function upsertCandle(arr, raw, max) {
  const c = toCandle(raw), lastC = arr[arr.length - 1];
  if (lastC && lastC.time === c.time) arr[arr.length - 1] = c;
  else if (!lastC || c.time > lastC.time) { arr.push(c); if (arr.length > max) arr.shift(); }
}
let wsRetry = 0;
function connectWS() {
  setConn('connecting');
  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  let ping;
  ws.onopen = () => {
    wsRetry = 0;
    const all = [MARKET, ...BASKET.map(b => b.code)];
    ws.send(JSON.stringify([
      { ticket: 'scalp-dash-' + Math.random().toString(36).slice(2, 10) },
      { type: 'ticker', codes: all }, { type: 'trade', codes: [MARKET] }, { type: 'orderbook', codes: [MARKET] },
      { type: 'candle.1m', codes: [MARKET] }, { type: 'candle.5m', codes: all },
      { format: 'DEFAULT' },
    ]));
    setConn('live');
    ping = setInterval(() => { if (ws.readyState === 1) ws.send('PING'); }, 50000);
  };
  ws.onmessage = e => {
    let d; try { d = JSON.parse(new TextDecoder().decode(e.data)); } catch { return; }
    const tick = t => ({ price: t.trade_price, change: t.change, changeRate: t.signed_change_rate, changePrice: t.signed_change_price,
      high24: t.high_price, low24: t.low_price, accTradePrice24h: t.acc_trade_price_24h, accVolume24h: t.acc_trade_volume_24h, prevClose: t.prev_closing_price });
    // 비교 바스켓 종목 메시지
    if (d.code && d.code !== MARKET) {
      const b = state.basket[d.code]; if (!b) return;
      if (d.type === 'ticker') b.ticker = tick(d);
      else if (d.type === 'candle.5m') upsertCandle(b.candles5m, d, 200);
      else return;
      state.updatedAt = Date.now(); dirty = true; return;
    }
    switch (d.type) {
      case 'ticker':
        state.ticker = tick(d);
        break;
      case 'trade':
        state.trades.unshift(toTrade(d)); if (state.trades.length > 200) state.trades.length = 200; break;
      case 'orderbook': {
        const units = d.orderbook_units.slice(0, 15);
        const totalBid = units.reduce((a, u) => a + u.bid_size, 0), totalAsk = units.reduce((a, u) => a + u.ask_size, 0);
        state.orderbook = { bestBid: units[0].bid_price, bestAsk: units[0].ask_price, spread: units[0].ask_price - units[0].bid_price,
          spreadPct: (units[0].ask_price - units[0].bid_price) / units[0].bid_price * 100, totalBid, totalAsk,
          bidAskRatio: totalAsk ? totalBid / totalAsk : 0, units: units.slice(0, 10) };
        break;
      }
      case 'candle.1m':
        upsertCandle(state.candles1m, d, 300);
        if (state.bootstrapFailed) setError(`업비트 요청 제한으로 과거 캔들을 받지 못했습니다. 실시간 캔들을 누적 중 (${state.candles1m.length}/60) · 1~2분 뒤 새로 고침하면 바로 받을 수 있습니다.`);
        break;
      case 'candle.5m': upsertCandle(state.candles5m, d, 200); break;
      default: return;
    }
    state.updatedAt = Date.now(); dirty = true;
  };
  // 접속 실패가 반복되면 재시도 간격을 5초 → 10 → 20 → 40 → 60초로 늘려 요청 제한을 더 소모하지 않는다
  ws.onclose = () => {
    clearInterval(ping); setConn('reconnect');
    const wait = Math.min(60000, 5000 * 2 ** Math.min(wsRetry++, 4));
    setTimeout(connectWS, wait);
  };
  ws.onerror = () => ws.close();
}

// ---------- 잔고 (로컬 서버가 있을 때만) ----------
async function pollHoldings() {
  try {
    const r = await fetch(`/api/holdings?market=${MARKET}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('no server');
    state.holdings = await r.json(); holdingsFailures = 0;
  } catch {
    holdingsFailures++;
    state.holdings = { status: 'unavailable' };
  }
  dirty = true;
  if (holdingsFailures < 2) setTimeout(pollHoldings, 30000);
}

// ---------- 알림 ----------
function permissionLabel() {
  if (!('Notification' in window)) return '이 브라우저는 알림 미지원';
  return { granted: '브라우저 알림 허용됨', denied: '브라우저 알림 차단됨 (주소창 옆 설정에서 허용)', default: '알림 권한 필요 · [알림 켜기]를 누르세요' }[Notification.permission];
}
async function requestPermission() {
  if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않습니다.'); return; }
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '알림이 켜졌습니다. 이 탭을 열어 두면 알림을 받습니다.' : '알림 권한이 거부되었습니다.');
  renderSettings();
}
let audioCtx = null;
function beep(kind) {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'sell' ? [880, 1174, 1568] : [660, 520, 660, 520];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      o.start(t); o.stop(t + 0.18);
    });
  } catch { /* 오디오 불가 */ }
}
function toast(msg, kind = 'info') {
  const box = $('toasts'); const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg; box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 9000);
}
let titleFlash = null;
function flashTitle(text) {
  clearInterval(titleFlash); const orig = `${BASE} 스캘핑 조건 대시보드`; let on = false;
  titleFlash = setInterval(() => { document.title = (on = !on) ? `🔔 ${text}` : orig; }, 1000);
  setTimeout(() => { clearInterval(titleFlash); document.title = orig; }, 30000);
}
async function notify(kind, title, body) {
  const entry = { time: Date.now(), kind, title, body };
  state.alertLog.unshift(entry); state.alertLog = state.alertLog.slice(0, 50); saveLocal();
  toast(`${title} — ${body}`, kind); beep(kind); flashTitle(title);
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag: `${MARKET}-${kind}-${Date.now()}`, icon: './icon.svg', badge: './icon.svg', renotify: true, requireInteraction: kind === 'sell', vibrate: [200, 100, 200], data: { url: location.href } };
  try {
    if (swReg && swReg.showNotification) await swReg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* 무시 */ } }
}

function positionMetrics(price) {
  const { qty, avgPrice, takeProfitPct, dropPct, dropWindowMin } = settings;
  const m = { hasPosition: qty > 0 && avgPrice > 0, pnlPct: null, pnl: null, value: null, cost: null, nextLevelPct: null, nextLevelPrice: null,
    windowHigh: null, dropFromHigh: null, dropFromPrev: null, drop: null, dropTriggerPrice: null };
  if (m.hasPosition) {
    m.pnlPct = (price - avgPrice) / avgPrice * 100;
    m.value = qty * price; m.cost = qty * avgPrice; m.pnl = m.value - m.cost;
    const level = Math.max(1, Math.floor(m.pnlPct / takeProfitPct) + 1);
    m.nextLevelPct = level * takeProfitPct; m.nextLevelPrice = avgPrice * (1 + m.nextLevelPct / 100);
  }
  // 급락 판정: 최근 N분 고점 대비 / 전일 종가 대비 중 더 큰 낙폭
  const since = Date.now() / 1000 - dropWindowMin * 60;
  const src = dropWindowMin <= 200 ? state.candles1m : state.candles5m;
  const highs = src.filter(c => c.time >= since).map(c => c.high);
  if (highs.length) { m.windowHigh = Math.max(...highs, price); m.dropFromHigh = (price / m.windowHigh - 1) * 100; m.dropTriggerPrice = m.windowHigh * (1 - dropPct / 100); }
  if (state.ticker) m.dropFromPrev = state.ticker.changeRate * 100;
  const drops = [m.dropFromHigh, m.dropFromPrev].filter(v => v !== null && v !== undefined);
  m.drop = drops.length ? Math.min(...drops) : null;
  return m;
}

function checkAlerts(price) {
  const m = positionMetrics(price);
  const { takeProfitPct, dropPct } = settings;
  // 매도: 수익률이 목표 단계(20%, 40%, 60%…)를 새로 넘을 때마다
  if (m.hasPosition && takeProfitPct > 0) {
    const level = Math.floor(m.pnlPct / takeProfitPct); // 1 → 20% 이상, 2 → 40% 이상 …
    if (level >= 1 && level > alertState.lastSellLevel) {
      alertState.lastSellLevel = level; saveLocal();
      notify('sell', `매도 시점 · 수익률 ${m.pnlPct.toFixed(1)}%`,
        `${MARKET} 현재가 ${fmtKRW(price)} · 평균 매수가 ${fmtKRW(settings.avgPrice)} 대비 +${(level * takeProfitPct)}% 도달 · 평가손익 ${m.pnl >= 0 ? '+' : ''}${fmtKRW(m.pnl)}`);
    }
    // 수익률이 한 단계 아래로 충분히 내려오면 그 단계 알림을 다시 받을 수 있게 재무장
    if (level < alertState.lastSellLevel && m.pnlPct < alertState.lastSellLevel * takeProfitPct - takeProfitPct / 4) { alertState.lastSellLevel = Math.max(0, level); saveLocal(); }
  }
  // 매수: 급락 기준 이상 하락 시 1회, 낙폭이 (기준 - 5%p) 안으로 회복되면 재무장
  if (m.drop !== null && dropPct > 0) {
    if (m.drop <= -dropPct && !alertState.dropFired) {
      alertState.dropFired = true; saveLocal();
      const why = m.dropFromHigh !== null && m.dropFromHigh <= -dropPct ? `최근 ${settings.dropWindowMin}분 고점 ${fmtKRW(m.windowHigh)} 대비 ${m.dropFromHigh.toFixed(1)}%` : `전일 종가 대비 ${m.dropFromPrev.toFixed(1)}%`;
      notify('buy', `급락 · 매수 시점 검토`, `${MARKET} 현재가 ${fmtKRW(price)} · ${why} 하락`);
    } else if (alertState.dropFired && m.drop > -(dropPct - 5)) { alertState.dropFired = false; saveLocal(); }
  }
  return m;
}

// ---------- 차트 ----------
const LWC = window.LightweightCharts;
const common = {
  layout: { background: { color: '#121826' }, textColor: '#8b95ad', fontSize: 11 },
  grid: { vertLines: { color: '#1b2336' }, horzLines: { color: '#1b2336' } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232c42', rightOffset: 4, barSpacing: 7 },
  rightPriceScale: { borderColor: '#232c42' }, crosshair: { mode: 0 }, localization: { locale: 'ko-KR' },
  // 모바일: 차트 위 세로 스와이프는 페이지 스크롤로, 가로 스와이프·핀치만 차트 조작으로
  handleScroll: { vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
  handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
};
const chart = LWC.createChart($('chart'), { ...common, autoSize: true });
const candleSeries = chart.addCandlestickSeries({ upColor: '#ff5b6e', downColor: '#3f8cff', borderVisible: false, wickUpColor: '#ff5b6e', wickDownColor: '#3f8cff' });
const ema9S = chart.addLineSeries({ color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'EMA9' });
const ema21S = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'EMA21' });
const bbU = chart.addLineSeries({ color: 'rgba(124,156,255,.55)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
const bbL = chart.addLineSeries({ color: 'rgba(124,156,255,.55)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
let avgLine = null, targetLine = null, dropLine = null;
const rsiChart = LWC.createChart($('rsi'), { ...common, autoSize: true, rightPriceScale: { ...common.rightPriceScale, scaleMargins: { top: .1, bottom: .1 } } });
const rsiS = rsiChart.addLineSeries({ color: '#7c9cff', lineWidth: 1.5, priceLineVisible: false });
rsiS.createPriceLine({ price: 70, color: 'rgba(245,158,11,.6)', lineStyle: 2, lineWidth: 1, title: '70' });
rsiS.createPriceLine({ price: 30, color: 'rgba(34,197,94,.6)', lineStyle: 2, lineWidth: 1, title: '30' });
chart.timeScale().subscribeVisibleLogicalRangeChange(r => r && rsiChart.timeScale().setVisibleLogicalRange(r));
const shift = arr => arr.map(p => ({ ...p, time: p.time + KST }));
function updatePriceLines(m) {
  [avgLine, targetLine, dropLine].forEach(l => l && candleSeries.removePriceLine(l)); avgLine = targetLine = dropLine = null;
  if (m.hasPosition) {
    avgLine = candleSeries.createPriceLine({ price: settings.avgPrice, color: '#e6eaf2', lineWidth: 1, lineStyle: 0, title: '평단' });
    targetLine = candleSeries.createPriceLine({ price: m.nextLevelPrice, color: '#22c55e', lineWidth: 1, lineStyle: 2, title: `매도 알림 +${m.nextLevelPct}%` });
  }
  if (m.dropTriggerPrice) dropLine = candleSeries.createPriceLine({ price: m.dropTriggerPrice, color: '#f59e0b', lineWidth: 1, lineStyle: 2, title: `급락 알림 -${settings.dropPct}%` });
}

// ---------- 렌더 ----------
function renderList(id, items, kind) {
  $(id).innerHTML = items.map(c =>
    `<li class="${c.ok ? 'on' : ''}"><span class="dot ${kind} ${c.ok ? 'on' : ''}"></span><span>${c.label}</span><span class="val">${c.value ?? '–'}</span></li>`).join('');
}
function renderSettings() {
  $('in-qty').value = settings.qty || ''; $('in-avg').value = settings.avgPrice || '';
  $('in-tp').value = settings.takeProfitPct; $('in-drop').value = settings.dropPct; $('in-win').value = settings.dropWindowMin;
  $('in-notify').checked = settings.notify; $('in-sound').checked = settings.sound;
  $('perm').textContent = permissionLabel();
  $('perm').className = 'perm ' + (('Notification' in window) ? Notification.permission : 'denied');
  $('btn-load').hidden = !(state.holdings.status === 'ok' && state.holdings.coin);
}
function renderPosition(m) {
  const el = $('position');
  if (!m || !state.ticker) { el.className = 'hold-empty'; el.textContent = '시세 수신 대기 중…'; return; }
  const price = state.ticker.price;
  const items = [];
  if (m.hasPosition) {
    items.push(['수익률', `<span class="chg ${m.pnlPct >= 0 ? 'up' : 'down'}">${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct.toFixed(2)}%</span>`, `평가손익 ${m.pnl >= 0 ? '+' : ''}${fmtKRW(m.pnl)}`]);
    items.push(['평가 금액', fmtKRW(m.value), `매수 원금 ${fmtKRW(m.cost)} · ${fmt(settings.qty, 4)} ${BASE}`]);
    items.push(['다음 매도 알림', `+${m.nextLevelPct}%`, `${fmtKRW(m.nextLevelPrice)} 도달 시 · 현재가 ${fmtKRW(price)}`]);
  } else {
    items.push(['포지션 미입력', '–', '보유 수량과 평균 매수가를 입력하면 수익률과 매도 알림이 켜집니다']);
  }
  if (m.dropFromHigh !== null) items.push([`최근 ${settings.dropWindowMin}분 고점 대비`, `${m.dropFromHigh.toFixed(2)}%`, `고점 ${fmtKRW(m.windowHigh)} · 알림가 ${fmtKRW(m.dropTriggerPrice)}`]);
  if (m.dropFromPrev !== null) items.push(['전일 종가 대비', `${m.dropFromPrev >= 0 ? '+' : ''}${m.dropFromPrev.toFixed(2)}%`, `급락 알림 기준 -${settings.dropPct}% · ${alertState.dropFired ? '알림 발송됨 (회복 시 재무장)' : '감시 중'}`]);
  el.className = 'kpis';
  el.innerHTML = items.map(([l, v, s2]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s2}</div></div>`).join('');
}

function render(m) {
  const s = state, c = s.computed;
  const connLabel = { connecting: '연결 중…', live: 'WebSocket 실시간', reconnect: '재연결 대기 중 (요청 제한 회피를 위해 간격을 늘림)' }[s.conn];
  $('meta').textContent = `${connLabel}${s.updatedAt ? ' · 갱신 ' + kstTime(s.updatedAt) : ''}`;
  $('market').textContent = `${s.market} · 업비트 · 1분봉`;
  $('title').textContent = `${BASE} 스캘핑 조건 대시보드`;

  if (s.ticker) {
    const t = s.ticker;
    $('price').textContent = fmtKRW(t.price);
    const el = $('chg');
    el.textContent = `${t.changeRate >= 0 ? '▲' : '▼'} ${fmt(Math.abs(t.changePrice))} (${(t.changeRate * 100).toFixed(2)}%)`;
    el.className = 'chg ' + (t.changeRate >= 0 ? 'up' : 'down');
  }
  renderPosition(m);
  if (c) {
    const st = $('status'); st.textContent = c.signals.statusLabel; st.className = 'status ' + c.signals.status;
    renderList('buylist', c.signals.buy, 'buy'); renderList('selllist', c.signals.sell, 'sell');
    $('buycount').textContent = `${c.signals.buyCount} / ${c.signals.buy.length}`;
    $('sellcount').textContent = `${c.signals.sellCount} / ${c.signals.sell.length}`;

    candleSeries.setData(shift(s.candles1m));
    ema9S.setData(shift(c.indicators.series.ema9)); ema21S.setData(shift(c.indicators.series.ema21));
    bbU.setData(shift(c.indicators.series.bbUpper)); bbL.setData(shift(c.indicators.series.bbLower));
    rsiS.setData(shift(c.indicators.series.rsi));
    if (m) updatePriceLines(m);
    if (firstDraw) { chart.timeScale().scrollToRealTime(); firstDraw = false; }

    const i = c.indicators, t5 = c.trend5m, ob = s.orderbook, tk = s.ticker;
    const kp = [
      ['RSI(14)', i.rsi?.toFixed(1), i.rsi <= 32 ? '과매도 구간' : i.rsi >= 68 ? '과매수 구간' : '중립'],
      ['EMA9 / EMA21', `${fmt(i.ema9, 1)} / ${fmt(i.ema21, 1)}`, i.ema9 > i.ema21 ? '단기 상승 배열' : '단기 하락 배열'],
      ['볼린저 상단 / 하단', `${fmt(i.bbUpper, 1)} / ${fmt(i.bbLower, 1)}`, `밴드폭 ${((i.bbUpper - i.bbLower) / i.bbMid * 100).toFixed(2)}%`],
      ['VWAP(120봉)', fmt(i.vwap, 1), i.price >= i.vwap ? '가격이 VWAP 위' : '가격이 VWAP 아래'],
      ['ATR(14)', `${fmt(i.atr, 2)}원`, i.atrPct !== null ? `가격의 ${i.atrPct.toFixed(2)}% · 변동성` : ''],
      ['거래량 / 20봉 평균', i.volRatio ? `${i.volRatio.toFixed(2)}배` : '–', `${big(i.volume)} / ${big(i.volAvg20)}`],
      ['5분봉 EMA20 / 50', t5 ? `${fmt(t5.ema20, 1)} / ${fmt(t5.ema50, 1)}` : '–', t5 ? (t5.up ? '상위 추세 상승' : '상위 추세 하락·횡보') : '5분봉 대기'],
      ['스프레드', ob ? `${fmt(ob.spread)}원` : '–', ob ? `${ob.spreadPct.toFixed(3)}%` : ''],
      ['24h 고가 / 저가', tk ? `${fmt(tk.high24)} / ${fmt(tk.low24)}` : '–', tk ? `24h 거래대금 ${big(tk.accTradePrice24h)}원` : ''],
    ];
    $('kpis').innerHTML = kp.map(([l, v, s2]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v ?? '–'}</div><div class="s">${s2 ?? ''}</div></div>`).join('');
  }
  if (s.orderbook) {
    const ob = s.orderbook, p = ob.totalBid / (ob.totalBid + ob.totalAsk) * 100;
    $('obbar').style.setProperty('--p', p.toFixed(1) + '%');
    $('obbid').textContent = `매수 ${big(ob.totalBid)}`; $('obask').textContent = `매도 ${big(ob.totalAsk)}`;
    $('obratio').textContent = `매수/매도 ${ob.bidAskRatio.toFixed(2)}배`;
    const max = Math.max(...ob.units.flatMap(u => [u.ask_size, u.bid_size]));
    const asks = ob.units.slice().reverse().map(u => `<tr><td></td><td class="depth ask"><span style="width:${u.ask_size / max * 100}%"></span>${big(u.ask_size)}</td><td class="ask">${fmt(u.ask_price)}</td></tr>`).join('');
    const bids = ob.units.map(u => `<tr><td class="bid">${fmt(u.bid_price)}</td><td class="depth bid"><span style="width:${u.bid_size / max * 100}%"></span>${big(u.bid_size)}</td><td></td></tr>`).join('');
    $('obtable').innerHTML = `<tr><th>매수호가</th><th>잔량</th><th>매도호가</th></tr>${asks}${bids}`;
  }
  if (c && c.tradeStat) {
    const tr = c.tradeStat, p = tr.buyRatio * 100;
    $('trhead').textContent = `최근 체결 ${tr.count}건 매수/매도 비중${tr.count < 200 ? ' (접속 후 누적 중)' : ''}`;
    $('trbar').style.setProperty('--p', p.toFixed(1) + '%');
    $('trbuy').textContent = `매수 ${p.toFixed(0)}% (${big(tr.buyVol)})`; $('trsell').textContent = `매도 ${(100 - p).toFixed(0)}% (${big(tr.sellVol)})`;
    $('trtable').innerHTML = `<tr><th>시간(KST)</th><th>가격</th><th>수량</th><th>구분</th></tr>` +
      s.trades.slice(0, 12).map(t => `<tr><td>${kstTime(t.ts)}</td><td>${fmt(t.price)}</td><td>${big(t.volume)}</td><td class="${t.side === 'BID' ? 'bid' : 'ask'}">${t.side === 'BID' ? '매수' : '매도'}</td></tr>`).join('');
  }

  // 잔고(로컬 서버 모드)는 카드로 표시하지 않고 [잔고에서 불러오기] 버튼 노출 여부에만 사용한다
  $('btn-load').hidden = !(s.holdings.status === 'ok' && s.holdings.coin);

  $('alertlog').innerHTML = s.alertLog.length ? s.alertLog.map(a =>
    `<div><span class="t">${kstTime(a.time)}</span><span class="pill ${a.kind === 'sell' ? 'buy_strong' : 'sell_strong'}">${a.kind === 'sell' ? '매도' : '매수'}</span><span>${a.title} · ${a.body}</span></div>`).join('')
    : '<div style="color:var(--muted)">아직 알림 없음</div>';
  $('log').innerHTML = s.log.length ? s.log.map(l =>
    `<div><span class="t">${kstTime(l.time)}</span><span class="pill ${l.status}">${l.statusLabel}</span><span style="margin-left:auto;color:var(--muted)">${fmtKRW(l.price)} · 매수 ${l.buyCount} / 매도 ${l.sellCount}</span></div>`).join('')
    : '<div style="color:var(--muted)">아직 상태 변화 없음</div>';
}

function tick() {
  if (!dirty) return;
  dirty = false;
  const c = computeAll(state);
  if (c) {
    state.computed = c;
    if (c.signals.status !== lastStatus) {
      state.log.unshift({ time: Date.now(), status: c.signals.status, statusLabel: c.signals.statusLabel, price: c.indicators.price, buyCount: c.signals.buyCount, sellCount: c.signals.sellCount });
      state.log = state.log.slice(0, 60); lastStatus = c.signals.status;
    }
  }
  const m = state.ticker ? checkAlerts(state.ticker.price) : null;
  render(m);
  for (const fn of listeners) { try { fn(state); } catch { /* 구독자 오류는 대시보드에 영향 주지 않음 */ } }
}

// 다른 모듈(relate.js 등)이 같은 데이터·REST 제한 관리 로직을 쓰도록 공개
window.dash = {
  state, MARKET, BASE, BASKET, KST, restJson, mergeCandles, toCandle, fmt, fmtKRW, big, kstTime,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  markDirty() { dirty = true; },
};

// ---------- 설정 폼 이벤트 ----------
function bindSettings() {
  const num = (id, min = 0) => Math.max(min, Number($(id).value) || 0);
  $('settings-form').addEventListener('submit', e => {
    e.preventDefault();
    settings.qty = num('in-qty'); settings.avgPrice = num('in-avg');
    settings.takeProfitPct = num('in-tp', 1); settings.dropPct = num('in-drop', 1); settings.dropWindowMin = Math.min(600, num('in-win', 5));
    settings.notify = $('in-notify').checked; settings.sound = $('in-sound').checked;
    // 기준이 바뀌었으니 알림 단계는 현재 수익률 기준으로 재설정 (이미 넘은 단계는 다시 알리지 않음)
    if (state.ticker && settings.qty > 0 && settings.avgPrice > 0) {
      const pnlPct = (state.ticker.price - settings.avgPrice) / settings.avgPrice * 100;
      alertState.lastSellLevel = Math.max(0, Math.floor(pnlPct / settings.takeProfitPct));
    } else alertState.lastSellLevel = 0;
    alertState.dropFired = false;
    saveLocal(); renderSettings(); dirty = true; toast('알림 설정을 저장했습니다.');
  });
  $('btn-perm').addEventListener('click', requestPermission);
  $('btn-test').addEventListener('click', () => notify('sell', '테스트 알림', `${MARKET} 알림이 이렇게 표시됩니다.`));
  $('btn-load').addEventListener('click', () => {
    const h = state.holdings; if (h.status !== 'ok' || !h.coin) return;
    $('in-qty').value = (h.coin.balance + h.coin.locked).toFixed(4); $('in-avg').value = h.coin.avgBuyPrice;
    toast('잔고 값을 불러왔습니다. [저장]을 눌러 적용하세요.');
  });
  $('btn-reset').addEventListener('click', () => { alertState.lastSellLevel = 0; alertState.dropFired = false; state.alertLog = []; saveLocal(); dirty = true; toast('알림 기록과 단계를 초기화했습니다.'); });
}

// ---------- 시작 ----------
loadLocal();
bindSettings();
renderSettings();
render(null);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(r => { swReg = r; }).catch(() => {});
connectWS();                       // WebSocket 접속 1회
setTimeout(bootstrap, 1500);       // 그 다음 REST 2회 (1분봉, 5분봉) — 분당 6회 제한 안에서 여유 확보
pollHoldings();
setInterval(tick, 1000);
