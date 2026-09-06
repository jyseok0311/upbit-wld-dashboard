// 지표 계산 · 조건 판정 엔진 (브라우저와 Node 서버가 공유하는 순수 함수 모음)

export const sma = (arr, p) => arr.map((_, i) => i < p - 1 ? null : arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);

export function ema(arr, p) {
  const k = 2 / (p + 1);
  const out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) continue;
    prev = prev === null ? arr.slice(0, p).reduce((a, b) => a + b, 0) / p : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) {
      gain += up; loss += dn;
      if (i === p) { gain /= p; loss /= p; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (p - 1) + up) / p;
      loss = (loss * (p - 1) + dn) / p;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function bollinger(closes, p = 20, mult = 2) {
  const mid = sma(closes, p);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    const win = closes.slice(i - p + 1, i + 1);
    const sd = Math.sqrt(win.reduce((a, v) => a + (v - mid[i]) ** 2, 0) / p);
    upper.push(mid[i] + mult * sd); lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

export function atr(candles, p = 14) {
  const out = new Array(candles.length).fill(null);
  let prev = null;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < p) { prev = (prev ?? 0) + tr / p; if (i === p - 1) out[i] = prev; continue; }
    prev = (prev * (p - 1) + tr) / p;
    out[i] = prev;
  }
  return out;
}

export function vwap(candles) {
  let pv = 0, v = 0;
  return candles.map(c => { pv += ((c.high + c.low + c.close) / 3) * c.volume; v += c.volume; return v ? pv / v : null; });
}

const last = arr => arr[arr.length - 1];

/**
 * @param {object} input
 * @param {Array} input.candles1m  오래된 → 최신 순 { time, open, high, low, close, volume }
 * @param {Array} input.candles5m  같은 형식
 * @param {object|null} input.orderbook { bidAskRatio }
 * @param {Array} input.trades  { side: 'BID'|'ASK', volume }
 */
export function computeAll({ candles1m, candles5m, orderbook, trades }) {
  if (!candles1m || candles1m.length < 60) return null;
  const closes = candles1m.map(c => c.close);
  const vols = candles1m.map(c => c.volume);
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21);
  const r = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const a = atr(candles1m, 14);
  const vw = vwap(candles1m.slice(-120));
  const volAvg20 = sma(vols, 20);
  const price = last(closes);

  const ind = {
    price,
    ema9: last(ema9), ema21: last(ema21),
    rsi: last(r),
    bbUpper: last(bb.upper), bbMid: last(bb.mid), bbLower: last(bb.lower),
    atr: last(a), atrPct: last(a) ? last(a) / price * 100 : null,
    vwap: last(vw),
    volume: last(vols), volAvg20: last(volAvg20),
    volRatio: last(volAvg20) ? last(vols) / last(volAvg20) : null,
    goldenCross: false, deadCross: false,
    series: {
      ema9: candles1m.map((c, i) => ({ time: c.time, value: ema9[i] })).filter(p => p.value !== null),
      ema21: candles1m.map((c, i) => ({ time: c.time, value: ema21[i] })).filter(p => p.value !== null),
      bbUpper: candles1m.map((c, i) => ({ time: c.time, value: bb.upper[i] })).filter(p => p.value !== null),
      bbLower: candles1m.map((c, i) => ({ time: c.time, value: bb.lower[i] })).filter(p => p.value !== null),
      rsi: candles1m.map((c, i) => ({ time: c.time, value: r[i] })).filter(p => p.value !== null),
    },
  };
  // 최근 3봉 안에서 가장 마지막에 일어난 교차 하나만 인정
  for (let i = candles1m.length - 3; i < candles1m.length; i++) {
    if (ema9[i] === null || ema9[i - 1] === null) continue;
    if (ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) { ind.goldenCross = true; ind.deadCross = false; }
    if (ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) { ind.deadCross = true; ind.goldenCross = false; }
  }

  let trend5m = null;
  if (candles5m && candles5m.length >= 50) {
    const cl5 = candles5m.map(c => c.close);
    const e20 = last(ema(cl5, 20)), e50 = last(ema(cl5, 50));
    trend5m = { ema20: e20, ema50: e50, up: e20 !== null && e50 !== null && e20 > e50 };
  }

  let tradeStat = null;
  if (trades && trades.length) {
    let buyVol = 0, sellVol = 0;
    for (const t of trades) { if (t.side === 'BID') buyVol += t.volume; else sellVol += t.volume; }
    tradeStat = { count: trades.length, buyVol, sellVol, buyRatio: buyVol + sellVol ? buyVol / (buyVol + sellVol) : 0.5 };
  }

  const ob = orderbook, tr = tradeStat, t5 = trend5m;
  const f1 = v => v === null || v === undefined ? '-' : Number(v).toFixed(1);

  const buy = [
    { key: 'rsi_oversold', label: 'RSI(14) 32 이하 과매도', ok: ind.rsi !== null && ind.rsi <= 32, value: f1(ind.rsi) },
    { key: 'bb_lower', label: '종가가 볼린저 하단 이하', ok: ind.bbLower !== null && price <= ind.bbLower * 1.001, value: `${price} / ${f1(ind.bbLower)}` },
    { key: 'vol_spike', label: '거래량 20봉 평균의 1.8배 이상', ok: ind.volRatio !== null && ind.volRatio >= 1.8, value: ind.volRatio ? ind.volRatio.toFixed(2) + '배' : '-' },
    { key: 'bid_dom', label: '호가 매수잔량 우위 (1.2배 이상)', ok: ob ? ob.bidAskRatio >= 1.2 : false, value: ob ? ob.bidAskRatio.toFixed(2) + '배' : '-' },
    { key: 'taker_buy', label: '최근 체결 매수 비중 55% 이상', ok: tr ? tr.buyRatio >= 0.55 : false, value: tr ? (tr.buyRatio * 100).toFixed(0) + '%' : '-' },
    { key: 'trend5m_up', label: '5분봉 EMA20 > EMA50 (상위 추세 상승)', ok: t5 ? t5.up : false, value: t5 ? (t5.up ? '상승' : '하락/횡보') : '-' },
    { key: 'golden', label: '1분봉 EMA9/21 골든크로스 (최근 3봉)', ok: ind.goldenCross, value: ind.goldenCross ? '발생' : '없음' },
  ];
  const sell = [
    { key: 'rsi_overbought', label: 'RSI(14) 68 이상 과매수', ok: ind.rsi !== null && ind.rsi >= 68, value: f1(ind.rsi) },
    { key: 'bb_upper', label: '종가가 볼린저 상단 이상', ok: ind.bbUpper !== null && price >= ind.bbUpper * 0.999, value: `${price} / ${f1(ind.bbUpper)}` },
    { key: 'dead', label: '1분봉 EMA9/21 데드크로스 (최근 3봉)', ok: ind.deadCross, value: ind.deadCross ? '발생' : '없음' },
    { key: 'ask_dom', label: '호가 매도잔량 우위 (1.2배 이상)', ok: ob ? ob.bidAskRatio > 0 && ob.bidAskRatio <= 1 / 1.2 : false, value: ob && ob.bidAskRatio > 0 ? (1 / ob.bidAskRatio).toFixed(2) + '배' : '-' },
    { key: 'taker_sell', label: '최근 체결 매도 비중 55% 이상', ok: tr ? tr.buyRatio <= 0.45 : false, value: tr ? ((1 - tr.buyRatio) * 100).toFixed(0) + '%' : '-' },
    { key: 'trend5m_down', label: '5분봉 EMA20 < EMA50 (상위 추세 하락)', ok: t5 ? !t5.up : false, value: t5 ? (t5.up ? '상승' : '하락/횡보') : '-' },
    { key: 'below_vwap', label: '가격이 VWAP 아래로 이탈', ok: ind.vwap !== null && price < ind.vwap, value: f1(ind.vwap) },
  ];
  const buyCount = buy.filter(x => x.ok).length, sellCount = sell.filter(x => x.ok).length;
  let status = 'neutral', statusLabel = '관망 · 조건 미충족';
  if (buyCount >= 4 && buyCount > sellCount) { status = 'buy_strong'; statusLabel = `매수 조건 ${buyCount}개 충족`; }
  else if (sellCount >= 4 && sellCount > buyCount) { status = 'sell_strong'; statusLabel = `매도 조건 ${sellCount}개 충족`; }
  else if (buyCount >= 3 && buyCount > sellCount) { status = 'buy_watch'; statusLabel = `매수 관심 · ${buyCount}개 충족`; }
  else if (sellCount >= 3 && sellCount > buyCount) { status = 'sell_watch'; statusLabel = `매도 관심 · ${sellCount}개 충족`; }

  return { indicators: ind, trend5m, tradeStat, signals: { buy, sell, buyCount, sellCount, status, statusLabel } };
}
