// 종목별 프로필: 뉴스 분류(구글 뉴스 검색어·필터), 연관도 분석 설정(핵심 인물·기관, 시장 요인, 테마 바스켓), 주요 인물·기관 목록.
// 브라우저(app.js · news.js · relate.js)와 뉴스 수집 스크립트(scripts/fetch-news.mjs)가 함께 쓰는 순수 데이터 모듈.

export const LABELS = {
  'KRW-BTC': '비트코인', 'KRW-ETH': '이더리움', 'KRW-SOL': '솔라나', 'KRW-WLD': '월드코인', 'KRW-XRP': '리플(XRP)', 'KRW-DOGE': '도지코인',
  'KRW-TAO': '비트텐서(TAO)', 'KRW-NEAR': '니어(NEAR)', 'KRW-RENDER': '렌더(RENDER)',
  'KRW-ARB': '아비트럼(ARB)', 'KRW-OP': '옵티미즘(OP)', 'KRW-POL': '폴리곤(POL)',
  'KRW-JUP': '주피터(JUP)', 'KRW-RAY': '레이디움(RAY)', 'KRW-PYTH': '피스(PYTH)',
};

// 반복 게시물 제외: 예측시장 시간별 가격, "오늘 가격", 가격 예측 낚시성 제목
const NOISE = /prediction market|price (range )?on \w+ \d+, \d{4}|\bat \d+\s?(am|pm)\s?(edt|est|utc)\b|price today|live price|price prediction/i;

export const PROFILES = {
  'KRW-WLD': {
    name: '월드코인', short: 'WLD',
    news: [
      {
        key: 'wld', label: '월드코인 · World',
        query: '(Worldcoin OR "WLD token" OR "Tools for Humanity" OR ("World Network" (crypto OR token OR Altman OR blockchain)) OR ("World ID" (Altman OR crypto OR iris OR Orb))) when:7d',
        // 제목에 월드코인 관련 단어가 실제로 있어야 함 (Animation World Network 등 오탐 제거)
        mustMatch: /worldcoin|\bwld\b|tools for humanity|world network|world id|world app|world money|\borb\b|altman|iris.?scan|eye.?scan/i,
      },
      { key: 'openai', label: 'OpenAI · 샘 올트먼', query: '(OpenAI OR "Sam Altman" OR ChatGPT) when:1d', mustMatch: /openai|altman|chatgpt|gpt/i },
    ],
    relate: {
      tab: 'OpenAI 연관도', tabSub: '뉴스 반응 · 상관 · 베타', title: 'WLD · OpenAI 연관도', subtitle: 'OpenAI·올트먼 헤드라인 이후 가격 반응 · 비트코인·AI 코인과의 상관 · 베타',
      entity: 'OpenAI·올트먼', entityCat: 'openai', entityRe: /openai|altman|올트먼|chatgpt|gpt-?\d|sora|o\d\b/i,
      marketFactor: 'KRW-BTC', theme: { label: 'AI 테마', codes: ['KRW-TAO', 'KRW-NEAR', 'KRW-RENDER'] },
      note: '참고: 월드코인(World)은 샘 올트먼이 공동 창업한 Tools for Humanity 가 만든 프로젝트이며, OpenAI 가 WLD 를 보유하거나 운영하는 것은 아닙니다. 위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.',
      people: [
        { name: '샘 올트먼', role: 'OpenAI CEO · Tools for Humanity 공동 창업자', re: /altman|올트먼/i },
        { name: '알렉스 블라니아', role: 'Tools for Humanity CEO · World 공동 창업자', re: /blania|블라니아/i },
        { name: 'Tools for Humanity', role: 'World App · Orb 개발사', re: /tools for humanity/i },
        { name: 'World Foundation', role: 'WLD 토큰 발행 · 거버넌스', re: /world foundation/i },
        { name: 'OpenAI', role: 'ChatGPT 개발사 · 올트먼 연계로 시장이 함께 반응', re: /openai|chatgpt|gpt-?\d/i },
      ],
    },
  },
  'KRW-BTC': {
    name: '비트코인', short: 'BTC',
    news: [
      { key: 'btc', label: '비트코인', query: '(Bitcoin OR BTC) (price OR market OR crypto) when:1d', mustMatch: /bitcoin|\bbtc\b/i, exclude: NOISE },
      {
        key: 'btc_key', label: '주요 인물 · 기관',
        query: '("Michael Saylor" OR MicroStrategy OR ("Strategy" bitcoin) OR (BlackRock bitcoin) OR IBIT OR ("Bitcoin ETF") OR ("Federal Reserve" bitcoin) OR (Powell bitcoin) OR (SEC bitcoin) OR (Tether bitcoin) OR (Trump bitcoin)) when:2d',
        mustMatch: /saylor|microstrategy|\bmstr\b|strategy (inc|buys|bought|adds|purchase|holdings|bitcoin)|blackrock|\bibit\b|\betf\b|\bfed\b|federal reserve|powell|\bsec\b|trump|tether|coinbase|fidelity|grayscale|ark invest|cathie|metaplanet/i,
      },
    ],
    relate: {
      tab: '주요 인물·기관', tabSub: '세일러 · 블랙록 · ETF · 연준', title: 'BTC · 주요 인물·기관 연관도', subtitle: '세일러·블랙록·ETF·연준 헤드라인 이후 가격 반응 · 이더리움·주요 알트와의 상관 · 베타',
      entity: '주요 인물·기관', entityCat: 'btc_key', entityRe: /saylor|microstrategy|\bmstr\b|strategy (inc|buys|bought|adds|purchase|holdings|bitcoin)|blackrock|\bibit\b|\betf\b|\bfed\b|federal reserve|powell|\bsec\b|trump|tether|세일러|블랙록|연준|파월/i,
      marketFactor: 'KRW-ETH', theme: { label: '주요 알트', codes: ['KRW-SOL', 'KRW-XRP', 'KRW-DOGE'] },
      note: '참고: 비트코인은 특정 인물·기관이 운영하지 않지만, 대량 보유 기업(Strategy 등)·현물 ETF 운용사·통화정책 발언이 가격에 크게 반영됩니다. 위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.',
      people: [
        { name: '마이클 세일러', role: 'Strategy(구 MicroStrategy) 회장 · 최대 기업 보유자', re: /saylor|microstrategy|\bmstr\b|strategy (inc|buys|bought|adds|purchase|holdings|bitcoin)|세일러|마이크로스트래티지/i },
        { name: '블랙록 · 래리 핑크', role: '현물 ETF IBIT 운용사', re: /blackrock|\bibit\b|larry fink|블랙록/i },
        { name: '미 연준 · 제롬 파월', role: '금리 결정 · 유동성', re: /\bfed\b|federal reserve|powell|fomc|연준|파월/i },
        { name: '미 SEC', role: '증권 규제 · ETF 승인', re: /\bsec\b|gensler|atkins/i },
        { name: '테더 · 코인베이스', role: '스테이블코인 발행 · 거래소·ETF 수탁', re: /tether|coinbase|테더|코인베이스/i },
        { name: '도널드 트럼프 행정부', role: '전략 비트코인 준비금 · 규제 기조', re: /trump|white house|트럼프/i },
      ],
    },
  },
  'KRW-ETH': {
    name: '이더리움', short: 'ETH',
    news: [
      { key: 'eth', label: '이더리움', query: '(Ethereum OR "ETH price" OR Ether) crypto when:1d', mustMatch: /ethereum|\beth\b|\bether\b/i, exclude: NOISE },
      {
        key: 'eth_key', label: '주요 인물 · 기관',
        query: '("Vitalik Buterin" OR "Ethereum Foundation" OR Consensys OR "Joseph Lubin" OR (BlackRock ethereum) OR ETHA OR "Ethereum ETF" OR (BitMine ethereum) OR ("Tom Lee" ethereum) OR SharpLink) when:2d',
        mustMatch: /vitalik|buterin|ethereum foundation|consensys|lubin|blackrock|\betha\b|\betf\b|bitmine|tom lee|sharplink|lido|arbitrum|optimism|\bbase\b|coinbase/i,
      },
    ],
    relate: {
      tab: '주요 인물·기관', tabSub: '부테린 · 재단 · ETF · 비트마인', title: 'ETH · 주요 인물·기관 연관도', subtitle: '부테린·이더리움 재단·ETF·기업 보유자 헤드라인 이후 가격 반응 · 비트코인·L2 코인과의 상관 · 베타',
      entity: '주요 인물·기관', entityCat: 'eth_key', entityRe: /vitalik|buterin|ethereum foundation|consensys|lubin|blackrock|\betha\b|\betf\b|bitmine|tom lee|sharplink|부테린|재단|블랙록|비트마인/i,
      marketFactor: 'KRW-BTC', theme: { label: '이더리움 생태계 (L2)', codes: ['KRW-ARB', 'KRW-OP', 'KRW-POL'] },
      note: '참고: 이더리움 재단은 프로토콜 개발을 지원하지만 가격을 운영하지 않습니다. ETF 운용사·기업 보유자(비트마인, 샤프링크 등)의 매수·매도 공시가 최근 가격 재료로 자주 등장합니다. 위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.',
      people: [
        { name: '비탈릭 부테린', role: '이더리움 공동 창시자', re: /vitalik|buterin|부테린/i },
        { name: '이더리움 재단', role: '프로토콜 개발 지원 · 보유 ETH 매도 이슈', re: /ethereum foundation|재단/i },
        { name: '컨센시스 · 조셉 루빈', role: 'MetaMask · Infura 개발사 · 공동 창시자', re: /consensys|lubin|컨센시스|루빈/i },
        { name: '블랙록 ETHA', role: '현물 ETF 운용사', re: /blackrock|\betha\b|블랙록/i },
        { name: '비트마인 · 톰 리', role: '최대 기업 보유자(트레저리)', re: /bitmine|tom lee|비트마인/i },
        { name: '샤프링크 게이밍', role: '기업 보유자(트레저리)', re: /sharplink|샤프링크/i },
      ],
    },
  },
  'KRW-SOL': {
    name: '솔라나', short: 'SOL',
    news: [
      { key: 'sol', label: '솔라나', query: '(Solana OR "SOL price") crypto when:1d', mustMatch: /solana|\bsol\b/i, exclude: NOISE },
      {
        key: 'sol_key', label: '주요 인물 · 기관',
        query: '("Anatoly Yakovenko" OR "Solana Foundation" OR "Solana Labs" OR "Raj Gokal" OR "Solana ETF" OR ("Forward Industries" solana) OR (Multicoin solana) OR ("Jump Crypto" solana) OR (VanEck solana) OR (Bitwise solana)) when:2d',
        mustMatch: /yakovenko|gokal|solana foundation|solana labs|solana etf|\betf\b|forward industries|multicoin|jump|pump\.?fun|jupiter|helius|firedancer|vaneck|bitwise|grayscale|galaxy/i,
      },
    ],
    relate: {
      tab: '주요 인물·기관', tabSub: '야코벤코 · 재단 · ETF · 트레저리', title: 'SOL · 주요 인물·기관 연관도', subtitle: '야코벤코·솔라나 재단·ETF·기업 보유자 헤드라인 이후 가격 반응 · 비트코인·솔라나 생태계 코인과의 상관 · 베타',
      entity: '주요 인물·기관', entityCat: 'sol_key', entityRe: /yakovenko|gokal|solana foundation|solana labs|\betf\b|forward industries|multicoin|jump|vaneck|bitwise|galaxy|야코벤코|재단|포워드/i,
      marketFactor: 'KRW-BTC', theme: { label: '솔라나 생태계', codes: ['KRW-JUP', 'KRW-RAY', 'KRW-PYTH'] },
      note: '참고: 솔라나 재단과 솔라나 랩스는 네트워크 개발을 이끌지만 가격을 운영하지 않습니다. ETF 승인·기업 트레저리(포워드 인더스트리스 등) 매수 공시가 최근 가격 재료로 자주 등장합니다. 위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.',
      people: [
        { name: '아나톨리 야코벤코', role: '솔라나 공동 창시자 · 솔라나 랩스 CEO', re: /yakovenko|야코벤코/i },
        { name: '라지 고칼', role: '솔라나 공동 창시자', re: /gokal|고칼/i },
        { name: '솔라나 재단', role: '생태계 지원 · 검증인 프로그램', re: /solana foundation|재단/i },
        { name: '포워드 인더스트리스', role: '최대 기업 보유자(트레저리) · 멀티코인·점프·갤럭시 참여', re: /forward industries|포워드/i },
        { name: '멀티코인 캐피털 · 점프 크립토', role: '초기 투자사 · Firedancer 클라이언트 개발(점프)', re: /multicoin|jump|firedancer|멀티코인|점프/i },
        { name: 'VanEck · Bitwise · Grayscale', role: '솔라나 ETF 신청·운용사', re: /vaneck|bitwise|grayscale/i },
      ],
    },
  },
};

// 프로필이 없는 종목(주소로 직접 지정한 경우)용 기본값
export function profileFor(market) {
  if (PROFILES[market]) return PROFILES[market];
  const base = market.split('-')[1] || market;
  return {
    name: base, short: base, news: [],
    relate: {
      tab: '연관도', tabSub: '상관 · 베타', title: `${base} · 연관도`, subtitle: '비트코인·주요 알트와의 상관 · 베타 (이 종목은 뉴스 분류가 없습니다)',
      entity: '주요 인물·기관', entityCat: null, entityRe: /$^/, marketFactor: 'KRW-BTC', theme: { label: '주요 알트', codes: ['KRW-ETH', 'KRW-SOL'] },
      note: '위 수치는 상관관계이며 인과관계나 향후 가격을 뜻하지 않습니다.', people: [],
    },
  };
}

// 뉴스 수집용: 모든 프로필의 분류를 키 중복 없이 모은다
export function allNewsCategories() {
  const seen = new Set(), out = [];
  for (const p of Object.values(PROFILES)) for (const c of p.news) { if (seen.has(c.key)) continue; seen.add(c.key); out.push(c); }
  return out;
}
