// 로컬 미리보기용 정적 파일 서버. public/ 폴더를 그대로 제공한다.
// 업비트 API 키나 계정 기능은 사용하지 않는다. 시세는 브라우저(app.js)가 업비트 공개 WebSocket 으로 직접 받는다.
//
// 실행: node server.mjs        (환경변수 PORT 로 포트 변경, 기본 3777)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3777);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.normalize(path.join(PUBLIC, file));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log(`[wld-dashboard] http://localhost:${PORT}`));
