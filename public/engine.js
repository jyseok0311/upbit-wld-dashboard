// 지표 계산 · 조건 판정 엔진 (브라우저와 Node 가 공유하는 순수 함수 모음)
//
// 판정 방식 (v2): 매수·매도 각각 0~100점 점수제
//   셋업(어디에 있나)  최대 35점  RSI 과매도/과매수, 볼린저 %B, VWAP 대비 위치·괴리
//   트리거(지금 도는가) 최대 40점  RSI 반전, 볼린저 밴드 복귀, 반전 캔들, EMA 교차, VWAP 이탈
//   확인(수급이 따르나) 최대 25점  호가 잔량 우위, 체결 방향 비중, 반전 봉 거래량
//   × 추세 배수          5분봉 EMA20/50 추세와 같은 방향이면 1.0, 반대면 0.7~0.85
//   − 감점               스프레드 과대, 변동성 과소(스캘핑 이득이 수수료보다 작음)
// "타이밍"은 셋업 + 트리거 1개 이상 + 점수 65 이상, 반대 점수보다 20점 이상 높을 때만 표시한다.
// 트리거 없이 셋업·확인만으로는 "준비" 단계까지만 올라간다.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- 캔들 패턴 (한 봉 기준) ----------
function candleShape(c) {
  const body = Math.abs(c.close - c.open), range = Math.max(c.high - c.low, 1e-9);
  return { body, range, upper: c.high - Math.max(c.open, c.close), lower: Math.min(c.open, c.close) - c.low, bull: c.close > c.open, bear: c.close < c.open };
}
// 망치형: 아래꼬리가 몸통의 2배 이상이고 봉 길이의 절반 이상, 종가가 봉 상단 1/3 안
export function isHammer(c) {
  const s = candleShape(c);
  return s.lower >= 2 * s.body && s.lower >= 0.5 * s.range && c.close >= c.low + s.range * 0.66;
}
// 유성형: 위꼬리가 몸통의 2배 이상이고 봉 길이의 절반 이상, 종가가 봉 하단 1/3 안
export function isShootingStar(c) {
  const s = candleShape(c);
  return s.upper >= 2 * s.body && s.upper >= 0.5 * s.range && c.close <= c.low + s.range * 0.34;
}
export function isBullEngulf(prev, c) {
  return prev.close < prev.open && c.close > c.open && c.close >= prev.open && c.open <= prev.close && (c.close - c.open) > (prev.open - prev.close) * 1.05;
}
export function isBearEngulf(prev, c) {
  return prev.close > prev.open && c.close < c.open && c.close <= prev.open && c.open >= prev.close && (c.open - c.close) > (prev.close - prev.open) * 1.05;
}

/**
 * @param {object} input
 * @param {Array} input.candles1m  오래된 → 최신 순 { time, open, high, low, close, volume } (마지막 봉은 진행 중일 수 있음)
 * @param {Array} input.candles5m  같은 형식
 * @param {object|null} input.orderbook { bidAskRatio, spreadPct }
 * @param {Array} input.trades  { side: 'BID'|'ASK', volume }
 * @param {number} [input.now]  현재 시각(ms). 진행 중 봉의 거래량 보정에 사용
 */
export function computeAll({ candles1m, candles5m, orderbook, trades, now = Date.now() }) {
  if (!candles1m || candles1m.length < 60) return null;
  const n = candles1m.length;
  const closes = candles1m.map(c => c.close);
  const vols = candles1m.map(c => c.volume);
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21);
  const r = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const a = atr(candles1m, 14);
  const vwWin = candles1m.slice(-120);
  const vw = vwap(vwWin);
  const vwAt = i => vw[i - (n - vwWin.length)] ?? null;   // 1분봉 인덱스 → VWAP 값
  const price = last(closes);
  const cur = candles1m[n - 1], prev = candles1m[n - 2], prev2 = candles1m[n - 3];

  // 거래량: 진행 중인 마지막 봉은 아직 다 쌓이지 않았으므로 완료된 봉과 그대로 비교하면 항상 낮게 나온다.
  //   → 완료 봉 20개 평균을 기준으로, (직전 완료 봉) 과 (진행 봉을 경과 시간으로 환산한 값) 중 큰 쪽을 쓴다.
  //   진행 봉 환산은 20초 이상 지난 뒤에만 쓴다(초반 몇 초는 체결 한 건으로도 수십 배가 나와 노이즈가 크다).
  const elapsed = clamp(now / 1000 - cur.time, 1, 60);
  const volAvg20 = vols.length > 21 ? vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20 : null;
  const volRatioPrev = volAvg20 ? prev.volume / volAvg20 : null;
  const volRatioNow = volAvg20 && elapsed >= 20 ? (cur.volume / (elapsed / 60)) / volAvg20 : null;
  const volRatio = volAvg20 ? Math.max(volRatioPrev, volRatioNow ?? 0) : null;

  const bbU = last(bb.upper), bbM = last(bb.mid), bbL = last(bb.lower);
  const pctB = bbU !== null && bbU !== bbL ? (price - bbL) / (bbU - bbL) : null;
  const atrNow = last(a), atrPct = atrNow ? atrNow / price * 100 : null;
  const vwapNow = last(vw);

  const ind = {
    price,
    ema9: last(ema9), ema21: last(ema21),
    rsi: last(r),
    bbUpper: bbU, bbMid: bbM, bbLower: bbL, pctB,
    atr: atrNow, atrPct,
    vwap: vwapNow, vwapDistAtr: vwapNow && atrNow ? (price - vwapNow) / atrNow : null,
    volume: cur.volume, volAvg20, volRatio, volRatioPrev, volRatioNow,
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
  for (let i = n - 3; i < n; i++) {
    if (ema9[i] === null || ema9[i - 1] === null) continue;
    if (ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) { ind.goldenCross = true; ind.deadCross = false; }
    if (ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) { ind.deadCross = true; ind.goldenCross = false; }
  }

  // ---------- 상위 추세 (5분봉) ----------
  let trend5m = null;
  if (candles5m && candles5m.length >= 50) {
    const cl5 = candles5m.map(c => c.close);
    const e20s = ema(cl5, 20), e50 = last(ema(cl5, 50)), e20 = last(e20s);
    const e20prev = e20s[e20s.length - 4] ?? e20;          // 15분 전 EMA20 → 기울기
    const p5 = last(cl5);
    const up = e20 !== null && e50 !== null && e20 > e50;
    const slope = e20 && e20prev ? (e20 / e20prev - 1) * 100 : 0;
    // strength: 'strong_up' | 'up' | 'down' | 'strong_down'  (가격과 EMA20 기울기까지 반영)
    let strength = up ? 'up' : 'down';
    if (up && p5 > e20 && slope > 0.05) strength = 'strong_up';
    if (!up && p5 < e20 && slope < -0.05) strength = 'strong_down';
    trend5m = { ema20: e20, ema50: e50, up, slope, strength, price: p5 };
  }

  // ---------- 체결 통계 ----------
  // 접속 직후 체결이 몇 건뿐일 때는 비중이 0% 또는 100% 로 튀므로 30건 이상 쌓인 뒤에만 점수에 넣는다
  const MIN_TRADES = 30;
  let tradeStat = null;
  if (trades && trades.length) {
    let buyVol = 0, sellVol = 0;
    for (const t of trades) { if (t.side === 'BID') buyVol += t.volume; else sellVol += t.volume; }
    tradeStat = { count: trades.length, buyVol, sellVol, buyRatio: buyVol + sellVol ? buyVol / (buyVol + sellVol) : 0.5, reliable: trades.length >= MIN_TRADES };
  }

  // ---------- 트리거 (최근 1~3봉 안에서 일어난 "전환" 사건) ----------
  const rsiNow = last(r);
  const rsiRecentMin = Math.min(...[r[n - 2], r[n - 3], r[n - 4]].filter(v => v !== null));
  const rsiRecentMax = Math.max(...[r[n - 2], r[n - 3], r[n - 4]].filter(v => v !== null));
  const rsiTurnUp = rsiNow !== null && Number.isFinite(rsiRecentMin) && rsiRecentMin <= 34 && rsiNow >= rsiRecentMin + 2.5 && rsiNow < 52;
  const rsiTurnDown = rsiNow !== null && Number.isFinite(rsiRecentMax) && rsiRecentMax >= 66 && rsiNow <= rsiRecentMax - 2.5 && rsiNow > 48;
  // 밴드 복귀: 최근 2~4봉 중 하단(상단)을 찔렀고 현재 종가는 밴드 안쪽
  const piercedLow = [n - 2, n - 3, n - 4].some(i => bb.lower[i] !== null && candles1m[i].low < bb.lower[i]);
  const piercedHigh = [n - 2, n - 3, n - 4].some(i => bb.upper[i] !== null && candles1m[i].high > bb.upper[i]);
  const bbReentryUp = piercedLow && bbL !== null && price > bbL && price < bbM;
  const bbReentryDown = piercedHigh && bbU !== null && price < bbU && price > bbM;
  // 반전 캔들: 직전 완료 봉, 또는 40초 이상 진행된 현재 봉
  const curMature = elapsed >= 40;
  const bullCandle = isHammer(prev) || isBullEngulf(prev2, prev) || (curMature && (isHammer(cur) || isBullEngulf(prev, cur)));
  const bearCandle = isShootingStar(prev) || isBearEngulf(prev2, prev) || (curMature && (isShootingStar(cur) || isBearEngulf(prev, cur)));
  // EMA9 회복/이탈: 직전 봉은 EMA9 아래(위), 현재 종가는 위(아래)
  const ema9Reclaim = ema9[n - 2] !== null && prev.close < ema9[n - 2] && price > ind.ema9;
  const ema9Loss = ema9[n - 2] !== null && prev.close > ema9[n - 2] && price < ind.ema9;
  // VWAP 이탈/회복 (최근 3봉 안에서 교차)
  let vwapLoss = false, vwapReclaim = false;
  for (let i = n - 3; i < n; i++) {
    const v0 = vwAt(i - 1), v1 = vwAt(i);
    if (v0 === null || v1 === null) continue;
    if (candles1m[i - 1].close >= v0 && candles1m[i].close < v1) { vwapLoss = true; vwapReclaim = false; }
    if (candles1m[i - 1].close <= v0 && candles1m[i].close > v1) { vwapReclaim = true; vwapLoss = false; }
  }
  // 과열 괴리: EMA9 에서 ATR 몇 배 떨어져 있나 (양수 = 위)
  const extAtr = atrNow ? (price - ind.ema9) / atrNow : 0;

  const ob = orderbook, tr = tradeStat, t5 = trend5m;
  const f1 = v => v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toFixed(1);
  const f2 = v => v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toFixed(2);
  const item = (key, group, label, max, pts, value) => ({ key, group, label, max, pts: Math.round(pts), ok: pts > 0, value });

  // ---------- 매수 점수 ----------
  const buy = [
    // 셋업 (35)
    item('rsi_oversold', 'setup', 'RSI(14) 과매도 (32 이하 · 25 이하 강함)', 15, rsiNow === null ? 0 : rsiNow <= 25 ? 15 : rsiNow <= 32 ? 10 : rsiNow <= 40 ? 4 : 0, f1(rsiNow)),
    item('bb_lower', 'setup', '볼린저 하단 접근 (%B 0.25 이하 · 0 이하 강함)', 12, pctB === null ? 0 : pctB <= 0 ? 12 : pctB <= 0.1 ? 8 : pctB <= 0.25 ? 3 : 0, pctB === null ? '-' : `%B ${f2(pctB)} · 하단 ${f1(bbL)}`),
    item('vwap_discount', 'setup', 'VWAP 아래 할인 구간 (0.5 ATR 이상 강함)', 8, ind.vwapDistAtr === null ? 0 : ind.vwapDistAtr <= -0.5 ? 8 : ind.vwapDistAtr < 0 ? 4 : 0, ind.vwapDistAtr === null ? '-' : `${ind.vwapDistAtr >= 0 ? '+' : ''}${f2(ind.vwapDistAtr)} ATR`),
    // 트리거 (40, 합산 상한)
    item('rsi_turn_up', 'trigger', 'RSI 과매도권에서 반등 전환', 14, rsiTurnUp ? 14 : 0, Number.isFinite(rsiRecentMin) ? `저점 ${f1(rsiRecentMin)} → ${f1(rsiNow)}` : '-'),
    item('bb_reentry', 'trigger', '볼린저 하단 이탈 후 밴드 안으로 복귀', 12, bbReentryUp ? 12 : 0, bbReentryUp ? '복귀' : piercedLow ? (price >= bbM ? '이탈 후 중심선 위' : '하단 이탈 중') : '없음'),
    item('bull_candle', 'trigger', '반전 캔들 (망치형 · 상승 장악형)', 10, bullCandle ? 10 : 0, bullCandle ? '발생' : '없음'),
    item('golden', 'trigger', '1분봉 EMA9/21 골든크로스 (최근 3봉)', 10, ind.goldenCross ? 10 : 0, ind.goldenCross ? '발생' : '없음'),
    item('ema9_reclaim', 'trigger', 'EMA9 위로 회복 · VWAP 회복', 6, ema9Reclaim || vwapReclaim ? 6 : 0, ema9Reclaim && vwapReclaim ? 'EMA9 · VWAP' : ema9Reclaim ? 'EMA9' : vwapReclaim ? 'VWAP' : '없음'),
    // 확인 (25, 합산 상한)
    item('bid_dom', 'confirm', '호가 매수잔량 우위 (1.2배 · 1.5배 강함)', 10, !ob ? 0 : ob.bidAskRatio >= 1.5 ? 10 : ob.bidAskRatio >= 1.2 ? 7 : 0, ob ? f2(ob.bidAskRatio) + '배' : '-'),
    item('taker_buy', 'confirm', '최근 체결 매수 비중 (55% · 62% 강함)', 10, !tr || !tr.reliable ? 0 : tr.buyRatio >= 0.62 ? 10 : tr.buyRatio >= 0.55 ? 7 : 0, tr ? `${(tr.buyRatio * 100).toFixed(0)}%${tr.reliable ? '' : ` (${tr.count}건 누적 중)`}` : '-'),
    item('vol_spike', 'confirm', '거래량 20봉 평균 대비 (1.5배 · 2.5배 강함)', 10, volRatio === null ? 0 : volRatio >= 2.5 ? 10 : volRatio >= 1.5 ? 7 : 0, volRatio === null ? '-' : `${f2(volRatio)}배`),
    // 추세 (표시용, 배수로 반영)
    item('trend5m_up', 'regime', '5분봉 EMA20 > EMA50 (상위 추세 상승)', 0, t5 && t5.up ? 1 : 0, t5 ? ({ strong_up: '강한 상승', up: '상승', down: '하락·횡보', strong_down: '강한 하락' })[t5.strength] : '5분봉 대기'),
  ];
  // ---------- 매도 점수 ----------
  const sell = [
    item('rsi_overbought', 'setup', 'RSI(14) 과매수 (68 이상 · 75 이상 강함)', 15, rsiNow === null ? 0 : rsiNow >= 75 ? 15 : rsiNow >= 68 ? 10 : rsiNow >= 60 ? 4 : 0, f1(rsiNow)),
    item('bb_upper', 'setup', '볼린저 상단 접근 (%B 0.75 이상 · 1 이상 강함)', 12, pctB === null ? 0 : pctB >= 1 ? 12 : pctB >= 0.9 ? 8 : pctB >= 0.75 ? 3 : 0, pctB === null ? '-' : `%B ${f2(pctB)} · 상단 ${f1(bbU)}`),
    item('overextended', 'setup', 'EMA9 위로 과열 괴리 (1.5 ATR 이상)', 8, extAtr >= 2.5 ? 8 : extAtr >= 1.5 ? 5 : 0, `${extAtr >= 0 ? '+' : ''}${f2(extAtr)} ATR`),
    item('rsi_turn_down', 'trigger', 'RSI 과매수권에서 꺾임', 14, rsiTurnDown ? 14 : 0, Number.isFinite(rsiRecentMax) ? `고점 ${f1(rsiRecentMax)} → ${f1(rsiNow)}` : '-'),
    item('bb_reentry_down', 'trigger', '볼린저 상단 이탈 후 밴드 안으로 복귀', 12, bbReentryDown ? 12 : 0, bbReentryDown ? '복귀' : piercedHigh ? (price <= bbM ? '이탈 후 중심선 아래' : '상단 이탈 중') : '없음'),
    item('bear_candle', 'trigger', '반전 캔들 (유성형 · 하락 장악형)', 10, bearCandle ? 10 : 0, bearCandle ? '발생' : '없음'),
    item('dead', 'trigger', '1분봉 EMA9/21 데드크로스 (최근 3봉)', 10, ind.deadCross ? 10 : 0, ind.deadCross ? '발생' : '없음'),
    item('vwap_loss', 'trigger', 'VWAP 아래로 이탈 · EMA9 이탈', 10, vwapLoss ? 10 : ema9Loss ? 6 : 0, vwapLoss && ema9Loss ? 'VWAP · EMA9' : vwapLoss ? 'VWAP' : ema9Loss ? 'EMA9' : '없음'),
    item('ask_dom', 'confirm', '호가 매도잔량 우위 (1.2배 · 1.5배 강함)', 10, !ob || !(ob.bidAskRatio > 0) ? 0 : 1 / ob.bidAskRatio >= 1.5 ? 10 : 1 / ob.bidAskRatio >= 1.2 ? 7 : 0, ob && ob.bidAskRatio > 0 ? f2(1 / ob.bidAskRatio) + '배' : '-'),
    item('taker_sell', 'confirm', '최근 체결 매도 비중 (55% · 62% 강함)', 10, !tr || !tr.reliable ? 0 : tr.buyRatio <= 0.38 ? 10 : tr.buyRatio <= 0.45 ? 7 : 0, tr ? `${((1 - tr.buyRatio) * 100).toFixed(0)}%${tr.reliable ? '' : ` (${tr.count}건 누적 중)`}` : '-'),
    item('vol_spike_sell', 'confirm', '거래량 20봉 평균 대비 (1.5배 · 2.5배 강함)', 10, volRatio === null ? 0 : volRatio >= 2.5 ? 10 : volRatio >= 1.5 ? 7 : 0, volRatio === null ? '-' : `${f2(volRatio)}배`),
    item('trend5m_down', 'regime', '5분봉 EMA20 < EMA50 (상위 추세 하락)', 0, t5 && !t5.up ? 1 : 0, t5 ? ({ strong_up: '강한 상승', up: '상승', down: '하락·횡보', strong_down: '강한 하락' })[t5.strength] : '5분봉 대기'),
  ];

  const sumGroup = (arr, g, cap) => Math.min(cap, arr.filter(x => x.group === g).reduce((s, x) => s + x.pts, 0));
  const regimeMult = (side) => {
    if (!t5) return 0.9;
    const s = t5.strength;
    if (side === 'buy') return s === 'strong_up' || s === 'up' ? 1 : s === 'down' ? 0.85 : 0.7;
    return s === 'strong_down' || s === 'down' ? 1 : s === 'up' ? 0.85 : 0.7;
  };
  const penalties = [];
  if (ob && ob.spreadPct !== undefined && ob.spreadPct > 0.25) penalties.push({ label: `스프레드 ${ob.spreadPct.toFixed(2)}% 과대`, pts: 8 });
  if (atrPct !== null && atrPct < 0.08) penalties.push({ label: `변동성 ${atrPct.toFixed(2)}% 과소 (수수료 대비 이득 적음)`, pts: 8 });
  const penalty = penalties.reduce((s, p) => s + p.pts, 0);

  const scoreOf = (arr, side) => {
    const setup = sumGroup(arr, 'setup', 35), trigger = sumGroup(arr, 'trigger', 40), confirm = sumGroup(arr, 'confirm', 25);
    const mult = regimeMult(side);
    const raw = setup + trigger + confirm;
    return { setup, trigger, confirm, mult, raw, score: Math.round(clamp(raw * mult - penalty, 0, 100)), triggers: arr.filter(x => x.group === 'trigger' && x.ok) };
  };
  const B = scoreOf(buy, 'buy'), S = scoreOf(sell, 'sell');
  const buyCount = buy.filter(x => x.ok && x.group !== 'regime').length, sellCount = sell.filter(x => x.ok && x.group !== 'regime').length;

  // ---------- 상태 판정 ----------
  const STRONG = 65, WATCH = 40, GAP = 20;
  let status = 'neutral', statusLabel = `관망 · 매수 ${B.score} / 매도 ${S.score}`;
  if (B.score >= STRONG && B.triggers.length && B.score >= S.score + GAP) { status = 'buy_strong'; statusLabel = `▲ 매수 타이밍 · ${B.score}점`; }
  else if (S.score >= STRONG && S.triggers.length && S.score >= B.score + GAP) { status = 'sell_strong'; statusLabel = `▼ 매도 타이밍 · ${S.score}점`; }
  else if (B.score >= WATCH && B.score > S.score) { status = 'buy_watch'; statusLabel = `매수 준비 · ${B.score}점${B.triggers.length ? '' : ' · 트리거 대기'}`; }
  else if (S.score >= WATCH && S.score > B.score) { status = 'sell_watch'; statusLabel = `매도 준비 · ${S.score}점${S.triggers.length ? '' : ' · 트리거 대기'}`; }

  // ---------- 실행 계획 (ATR · 최근 스윙 기준 목표가/손절가) ----------
  const lows10 = candles1m.slice(-10).map(c => c.low), highs10 = candles1m.slice(-10).map(c => c.high);
  let plan = null;
  if (atrNow) {
    if (status.startsWith('buy')) {
      const stop = Math.min(Math.min(...lows10), price) - atrNow * 0.3;
      const t1c = [bbM, vwapNow].filter(v => v !== null && v > price + atrNow * 0.5);
      const target1 = t1c.length ? Math.min(...t1c) : price + atrNow * 1.5;
      const target2 = bbU !== null && bbU > target1 ? bbU : price + atrNow * 2.5;
      plan = { side: 'buy', entry: price, stop, target1, target2, rr: (target1 - price) / Math.max(price - stop, 1e-9) };
    } else if (status.startsWith('sell')) {
      const stop = Math.max(Math.max(...highs10), price) + atrNow * 0.3;
      const t1c = [bbM, vwapNow].filter(v => v !== null && v < price - atrNow * 0.5);
      const target1 = t1c.length ? Math.max(...t1c) : price - atrNow * 1.5;
      const target2 = bbL !== null && bbL < target1 ? bbL : price - atrNow * 2.5;
      plan = { side: 'sell', entry: price, stop, target1, target2, rr: (price - target1) / Math.max(stop - price, 1e-9) };
    }
  }

  return {
    indicators: ind, trend5m, tradeStat,
    signals: {
      buy, sell, buyCount, sellCount, status, statusLabel,
      buyScore: B.score, sellScore: S.score, buyParts: B, sellParts: S, penalties, plan,
      thresholds: { strong: STRONG, watch: WATCH, gap: GAP },
    },
  };
}
