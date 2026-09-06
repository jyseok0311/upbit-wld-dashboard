// 로컬 서버: public/ 정적 파일 제공 + 업비트 공식 CLI(upbit)로 잔고 조회(/api/holdings)
// 시세·지표는 브라우저(app.js)가 업비트 WebSocket으로 직접 받으므로 서버는 잔고만 담당한다.
//
// 실행: node server.mjs        (환경변수 PORT 로 포트 변경, 기본 3777)

import http from 'node:http';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3777);
const SKILL_VERSION = 'v1.0.0';
const HEADER = `--header "X-Upbit-Initiator: upbit-cli-skill/${SKILL_VERSION}"`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// upbit CLI 실행 명령. PATH에 의존하지 않도록 현재 Node 바이너리로 CLI 진입 파일(run.js)을 직접 실행한다.
function resolveUpbit() {
  const candidates = [
    process.env.UPBIT_CLI_JS,
    process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@upbit-official', 'upbit-cli', 'run.js') : null,
    '/usr/local/lib/node_modules/@upbit-official/upbit-cli/run.js',
    '/usr/lib/node_modules/@upbit-official/upbit-cli/run.js',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return `"${process.execPath}" "${p}"`;
  return 'upbit';
}
const UPBIT = resolveUpbit();
const stripAnsi = s => s.replace(/\[[0-9;]*m/g, '');
const CLI_ENV = { ...process.env, NO_COLOR: '1', TERM: 'dumb',
  HOME: process.env.HOME || process.env.USERPROFILE, USERPROFILE: process.env.USERPROFILE || process.env.HOME };

function cli(args) {
  return new Promise((resolve, reject) => {
    exec(`${UPBIT} ${args} --format json ${HEADER}`, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: CLI_ENV }, (err, stdout, stderr) => {
      const out = stripAnsi(stdout || ''), errText = stripAnsi(stderr || '');
      if (err) {
        const full = ([errText, out].filter(Boolean).join('\n').trim()) || err.message;
        return reject(Object.assign(new Error(full.split('\n')[0]), { detail: full }));
      }
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('CLI 응답 파싱 실패: ' + out.slice(0, 160))); }
    });
  });
}

// 잔고는 30초 캐시 (CLI 호출과 API 요청을 줄이기 위해)
const cache = new Map();
async function holdings(market) {
  const hit = cache.get(market);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  let data;
  try {
    const accounts = await cli('accounts list');
    const base = market.split('-')[1];
    const krw = accounts.find(a => a.currency === 'KRW');
    const coin = accounts.find(a => a.currency === base);
    data = { status: 'ok', krw: krw ? Number(krw.balance) + Number(krw.locked) : 0,
      coin: coin ? { balance: Number(coin.balance), locked: Number(coin.locked), avgBuyPrice: Number(coin.avg_buy_price) } : null,
      fetchedAt: new Date().toISOString() };
  } catch (e) {
    const m = e.detail || e.message;
    let message = e.message;
    if (m.includes('credentials')) message = 'API 키 미등록 · 터미널에서 upbit.cmd config set 실행';
    else if (m.includes('invalid_access_key')) message = 'API 키가 유효하지 않음 (삭제·재발급된 키) · upbit.cmd config set 으로 새 키 등록';
    else if (m.includes('out_of_scope') || m.includes('403')) message = 'API 키에 자산 조회 권한 없음';
    else if (m.includes('401')) message = '인증 실패 (401)';
    console.error('[holdings]', e.message);
    data = { status: 'error', message };
  }
  cache.set(market, { at: Date.now(), data });
  return data;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/holdings') {
    const market = (url.searchParams.get('market') || 'KRW-WLD').toUpperCase();
    if (!/^[A-Z]{3,4}-[A-Z0-9]{2,10}$/.test(market)) { res.writeHead(400); return res.end('bad market'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await holdings(market)));
  }
  // 정적 파일
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.normalize(path.join(PUBLIC, file));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

server.listen(PORT, () => {
  console.log(`[wld-dashboard] http://localhost:${PORT}`);
  console.log(`[wld-dashboard] CLI: ${UPBIT}`);
});
