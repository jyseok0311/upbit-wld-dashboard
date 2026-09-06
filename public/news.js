// 뉴스 탭: scripts/fetch-news.mjs 가 만든 news.json(해외 기사 + 한국어 번역)을 읽어 표시한다.
// 탭 전환(#dash / #news), 카테고리 필터, 새 기사 배지, 5분 간격 자동 갱신을 담당한다.

const $ = id => document.getElementById(id);
const LS_SEEN = 'scalp-dash:news-seen';
let data = null, cat = 'all', seenAt = 0;
try { seenAt = Number(localStorage.getItem(LS_SEEN) || 0); } catch { /* 무시 */ }

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return '방금'; if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const VIEWS = ['dash', 'news', 'relate'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'dash';
  for (const v of VIEWS) { $(`view-${v}`).hidden = v !== name; $(`tab-${v}`).classList.toggle('active', v === name); }
  if (name === 'news') { seenAt = Date.now(); try { localStorage.setItem(LS_SEEN, String(seenAt)); } catch { /* 무시 */ } $('news-badge').hidden = true; }
}

function render() {
  const grid = $('news-grid');
  if (!data) { grid.innerHTML = '<div class="hold-empty">뉴스 데이터가 아직 없습니다. GitHub Actions 첫 실행(약 15분) 후 표시됩니다.</div>'; return; }
  $('news-meta').textContent = `갱신 ${new Date(data.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} · 15분 간격 자동 수집`;
  const cats = data.categories.filter(c => cat === 'all' || c.key === cat);
  grid.style.gridTemplateColumns = cats.length > 1 ? '' : '1fr';
  grid.innerHTML = cats.map(c => `
    <div class="card">
      <h2>${c.label} <span class="count">${c.items.length}건</span></h2>
      <div class="news-list">
        ${c.items.map(it => `
          <a class="news-item ${Date.parse(it.publishedAt) > seenAt ? 'fresh' : ''}" href="${it.link}" target="_blank" rel="noopener noreferrer">
            <div class="ko">${it.titleKo || it.title}</div>
            ${it.titleKo && it.titleKo !== it.title ? `<div class="en">${it.title}</div>` : ''}
            <div class="src"><b>${it.source || '출처 미상'}</b><span>${ago(it.publishedAt)}</span><span>${new Date(it.publishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span></div>
          </a>`).join('') || '<div class="hold-empty">기사가 없습니다.</div>'}
      </div>
    </div>`).join('');
  // 새 기사 배지 (뉴스 탭이 닫혀 있을 때)
  const fresh = data.categories.flatMap(c => c.items).filter(it => Date.parse(it.publishedAt) > seenAt).length;
  const badge = $('news-badge');
  if (fresh > 0 && $('view-news').hidden) { badge.textContent = fresh > 99 ? '99+' : String(fresh); badge.hidden = false; } else badge.hidden = true;
}

async function load() {
  try {
    const r = await fetch(`./news.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch { /* news.json 없음: 안내 문구 유지 */ }
  render();
}

document.querySelectorAll('.news-head .chip').forEach(ch => ch.addEventListener('click', () => {
  document.querySelectorAll('.news-head .chip').forEach(x => x.classList.toggle('active', x === ch));
  cat = ch.dataset.cat; render();
}));
$('news-refresh').addEventListener('click', load);
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));
load();
setInterval(load, 5 * 60 * 1000);
