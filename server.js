'use strict';
const http = require('http');
const { URL } = require('url');
const { loadNews, loadWeather, SOURCES } = require('./src/feed');
const { renderWallpaper } = require('./src/render');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 用东八区判断"今天"
const REFRESH_MIN_MS = 3 * 3600 * 1000; // 数据最短复用间隔
const DAILY_HOUR = 5; // 每天 05:00 后视为"新的一天"

const PNG_HEADERS = {
  'content-type': 'image/png',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
};

const state = {
  items: [],
  status: [],
  fetchedAt: 0,
  weatherByCity: {},      // { city -> { data, at } } 按城市分别缓存，避免串城/失败回退默认城市
  lastError: '',
  startedAt: Date.now(),
  renders: 0,
  stats: null,
};

// ---------- 数据刷新 ----------
function todayKey(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function shouldRefresh(now) {
  if (!state.fetchedAt) return true;
  if (now - state.fetchedAt >= REFRESH_MIN_MS) return true;
  // 跨过了当天设定时刻，且今天还没抓过 -> 补做
  const crossedDaily = now.getHours() >= DAILY_HOUR && todayKey(state.fetchedAt) !== todayKey(now);
  return crossedDaily;
}

let refreshing = null;
function refresh(force) {
  const now = new Date();
  if (!force && !shouldRefresh(now)) return Promise.resolve(false);
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const news = await loadNews({ timeoutMs: 9000, limit: 22 });
      state.items = news.items;
      state.status = news.status;
      state.stats = news.stats;
      state.fetchedAt = news.fetchedAt;
      state.lastError = '';
      cache.clear();
      console.log(`[refresh] OK ${news.items.length} 条, 来源 ${news.status.filter(s => s.ok).length}/${news.status.length}`);
    } catch (e) {
      state.lastError = String(e.message || e).slice(0, 300);
      console.error('[refresh] FAIL', state.lastError);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function getWeather(city) {
  if (!city) return null;
  const now = Date.now();
  const entry = state.weatherByCity[city];
  if (entry && now - entry.at < 3600 * 1000) return entry.data;   // 该城市 1h 内缓存命中
  const w = await loadWeather(city, 4000);
  if (w) state.weatherByCity[city] = { data: w, at: now };        // 只写该城市，绝不清别的城市
  // 该城市失败/无数据时返回 null（不回落旧城市），渲染端据此不显示天气
  return state.weatherByCity[city] ? state.weatherByCity[city].data : null;
}

// ---------- PNG 缓存 ----------
const cache = new Map(); // key -> { buf, at }

function getWallpaper(params) {
  const w = clampInt(params.w, 200, 4096, 1072);
  const h = clampInt(params.h, 200, 4096, 1448);
  const n = clampInt(params.n, 1, 30, 18);
  const wkey = params.city ? params.city : '';
  const key = `${w}x${h}x${n}|${wkey}`;

  const hit = cache.get(key);
  if (hit && hit.sig === state.fetchedAt && hit.wcity === wkey) return hit.buf;

  const items = state.items.slice(0, n);
  const st = state.stats;
  // 只取请求城市对应的天气（与插件 ?city 严格一致，绝不串城）
  const cityWx = params.city ? (state.weatherByCity[params.city] || {}).data : null;
  const buf = renderWallpaper({
    w, h, items,
    weather: cityWx,
    fetchedAt: state.fetchedAt || Date.now(),
    sourceCount: state.status.filter(s => s.ok).length || SOURCES.length,
    stat: st ? `AI筛选 ${st.scanned}→${st.aiHit}` : '',
  });
  cache.set(key, { buf, sig: state.fetchedAt, wcity: wkey });
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return buf;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ---------- HTTP ----------
function sendPng(res, buf) {
  res.writeHead(200, PNG_HEADERS);
  res.end(buf);
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}

function htmlPage() {
  const ok = state.status.filter(s => s.ok).length;
  const rows = state.status.map(s =>
    `<tr><td>${esc(s.source)}</td><td class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '正常 · ' + s.items + ' 条' : '失败 · ' + esc(s.error || '')}</td></tr>`
  ).join('');
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>AI 日报 · 墨水屏壁纸源</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f5f3;color:#222}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:22px;margin:0 0 6px}p.sub{margin:0 0 24px;color:#666;font-size:14px}
img{width:100%;max-width:420px;border:1px solid #ddd;background:#fff;display:block}
.grid{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
table{border-collapse:collapse;font-size:13px;margin-top:8px}
td,th{border:1px solid #e2e2e2;padding:6px 12px;text-align:left}
th{background:#fafafa}
.ok{color:#0a7a3d}.bad{color:#b3261e}
code{background:#eee;padding:2px 6px;border-radius:4px;font-size:13px}
.legacy{margin-top:18px;font-size:13px;color:#444;line-height:1.8}
</style></head><body><div class="wrap">
<h1>AI 日报 · 墨水屏壁纸源</h1>
<p class="sub">给 KOReader DashWallpaper 插件用的每日 AI 资讯壁纸，灰度 16 级抖动输出。</p>
<div class="grid">
<div><img src="/wallpaper?t=${state.renders}" alt="今日壁纸预览"></div>
<div>
<table><tr><th>内容源</th><th>状态</th></tr>${rows}</table>
<div class="legacy">
<p><b>插件里填这一行</b>（名称与地址之间用 Tab 分隔）：</p>
<p><code>AI 日报	${'${ORIGIN}'}/wallpaper</code></p>
<p>接口：<code>/wallpaper</code> · <code>/digest.png</code> · <code>/health</code> · <code>/regen</code></p>
<p>参数：<code>?w=1072&amp;h=1448</code> 尺寸，<code>?n=8</code> 条数，<code>?city=上海</code> 天气（插件会自动带上 city）</p>
<p>数据时间：<b>${state.fetchedAt ? new Date(state.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未抓取'}</b> · 来源 ${ok}/${state.status.length}</p>
<p>AI 筛选：扫描 ${(state.stats && state.stats.scanned) || 0} 条 → 命中 ${(state.stats && state.stats.aiHit) || 0} 条 → 剔除 ${(state.stats && state.stats.droppedNonAi) || 0} 条非 AI 内容（窗口 ${(state.stats && state.stats.window) || '-'}）</p>
</div>
</div></div></div></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(u.searchParams.entries());
  const t0 = Date.now();

  try {
    if (p === '/wallpaper' || p === '/wallpaper.png' || p === '/digest.png') {
      if (!state.fetchedAt) await Promise.race([refresh(true), sleep(6000)]);
      else if (shouldRefresh(new Date())) refresh(false);
      if (q.city) {
        await getWeather(q.city).catch(() => {});   // getWeather 内部处理 1h 缓存，过期自动刷新该城市
      }
      try {
        const buf = getWallpaper(q);
        state.renders++;
        sendPng(res, buf);
      } catch (err) {
        console.error('[render-fail]', err);
        try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('render error: ' + (err && err.message || err)); }
        catch {}
      }
      return;
    }

    if (p === '/health') {
      sendJson(res, {
        ok: !!state.fetchedAt,
        items: state.items.length,
        sources: state.status,
        fetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
        lastError: state.lastError,
        uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        renders: state.renders,
        filter: state.stats,
      });
      return;
    }

    if (p === '/regen') {
      await refresh(true);
      cache.clear();
      sendJson(res, { ok: true, items: state.items.length, lastError: state.lastError, tookMs: Date.now() - t0 });
      return;
    }

    if (p === '/' || p === '/index.html') {
      const body = htmlPage().replace('${ORIGIN}', `http://${req.headers.host || 'localhost'}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    console.error('[http]', e);
    try {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('error: ' + (e.message || e));
    } catch { /* ignore */ }
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

server.listen(PORT, HOST, () => {
  console.log(`[ai-daily-wallpaper] listening on ${HOST}:${PORT}`);
  refresh(true).then(() => {
    // 预热默认尺寸，避免首次请求慢
    try { getWallpaper({}); console.log('[warmup] default wallpaper cached'); } catch (e) { console.error('[warmup]', e.message); }
  });
});

// 每 10 分钟检查一次是否需要刷新（跨天补做 / 3 小时兜底）
setInterval(() => { refresh(false).catch(() => {}); }, 10 * 60 * 1000).unref();
