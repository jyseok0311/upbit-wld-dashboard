// 거래소 설정: 업비트와 빗썸. 두 거래소의 공개 API(v1)는 캔들·시세 형식이 같지만 다음이 다르다.
//  - 업비트: 브라우저(Origin) 요청을 REST + WebSocket 접속 합쳐 약 10초에 1회로 제한 → REST 를 11초 간격 큐로 보내고 캔들 캐시를 쓴다.
//            WebSocket 에 캔들 스트림(candle.1m / candle.5m)이 있다.
//  - 빗썸:   REST 제한이 초당 150회라 사실상 대기 없음. WebSocket 에 캔들 스트림이 없어("candle.1m 은 지원하지 않는 타입") 체결로 캔들을 만들고
//            1분마다 REST 로 보정한다. 호가는 "KRW-WLD.15" 처럼 단계 수를 지정해 15단계만 받는다.
// 선택: 주소의 ?ex=upbit|bithumb → 없으면 마지막으로 고른 거래소 → 없으면 업비트.

export const EXCHANGES = {
  upbit: {
    id: 'upbit', name: '업비트',
    rest: 'https://api.upbit.com', ws: 'wss://api.upbit.com/websocket/v1',
    restGap: 11000,          // REST 간 최소 간격(ms)
    wsSharesLimit: true,     // WebSocket 접속도 REST 와 같은 제한을 쓴다
    liveCandles: 'stream',   // WebSocket 캔들 메시지로 봉을 갱신
    useCache: true,          // 새로 고침 시 캔들 캐시로 먼저 그림
    resyncMs: 0,
    subscribe: (all, watch) => [
      { type: 'ticker', codes: all }, { type: 'trade', codes: watch }, { type: 'orderbook', codes: watch },
      { type: 'candle.1m', codes: watch }, { type: 'candle.5m', codes: all },
    ],
  },
  bithumb: {
    id: 'bithumb', name: '빗썸',
    rest: 'https://api.bithumb.com', ws: 'wss://ws-api.bithumb.com/websocket/v1',
    restGap: 60,
    wsSharesLimit: false,
    liveCandles: 'trade',    // 체결로 1분봉·5분봉을 직접 만든다
    useCache: false,         // REST 가 즉시 응답하므로 캐시 불필요 (캐시와 최신 봉 사이 공백으로 인한 오판정도 피한다)
    resyncMs: 60000,         // 체결 누락·재접속 공백을 REST 로 1분마다 보정
    subscribe: (all, watch) => [
      { type: 'ticker', codes: all }, { type: 'trade', codes: all }, { type: 'orderbook', codes: watch.map(c => c + '.15') },
    ],
  },
};

const LS_EX = 'scalp-dash:exchange';
function pick() {
  const q = (new URLSearchParams(location.search).get('ex') || '').toLowerCase();
  if (EXCHANGES[q]) { try { localStorage.setItem(LS_EX, q); } catch { /* 무시 */ } return q; }
  try { const s = localStorage.getItem(LS_EX); if (EXCHANGES[s]) return s; } catch { /* 무시 */ }
  return 'upbit';
}
export const EX = EXCHANGES[pick()];
export const OTHER = EX.id === 'upbit' ? EXCHANGES.bithumb : EXCHANGES.upbit;   // 가격 비교용 다른 거래소
// 같은 화면의 다른 종목·거래소로 가는 링크 (현재 탭 유지)
export const hrefFor = ({ ex = EX.id, market } = {}) => `?ex=${ex}&market=${market}${location.hash || '#dash'}`;
