'use strict';
/*
 * generate.js — 每日壁纸生成器（GitHub Actions 定时调用）
 *
 * 在 CI / 本地运行：抓最新 AI 新闻 + 指定城市天气 → 渲染成 1072x1448
 * 灰度 PNG，写到 output/wallpaper.png。GitHub Actions 每天定时跑一次，
 * 生成的 PNG commit 到仓库后由 GitHub Pages 提供静态 URL，Kindle 每日拉取。
 *
 * 用法：
 *   CITY="上海" node generate.js
 *   （可选 W=1072 H=1448 N=22）
 */
const fs = require('fs');
const path = require('path');
const { loadNews, loadWeather } = require('./src/feed');
const { renderWallpaper } = require('./src/render');

const W = parseInt(process.env.W || '1072', 10);
const H = parseInt(process.env.H || '1448', 10);
const N = parseInt(process.env.N || '22', 10);
const CITY = process.env.CITY || '上海';

const OUT_DIR = path.join(__dirname, 'output');

async function main() {
  const news = await loadNews({ timeoutMs: 9000, limit: N });
  if (!news.items || !news.items.length) {
    throw new Error('未抓到任何新闻，终止本次生成');
  }

  // 天气按 CITY 拉取；失败则壁纸不带天气（不影响生成）
  let weather = null;
  try {
    weather = await loadWeather(CITY, 6000);
  } catch (e) {
    console.warn('[天气] 获取失败，本次不带天气：', (e && e.message) || e);
  }

  const okCount = news.status.filter(s => s.ok).length;
  const stat = news.stats
    ? `AI筛选 ${news.stats.scanned}→${news.stats.aiHit}`
    : '';

  const buf = renderWallpaper({
    w: W,
    h: H,
    items: news.items.slice(0, N),
    weather,
    fetchedAt: news.fetchedAt || Date.now(),
    sourceCount: okCount,
    stat,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'wallpaper.png');
  fs.writeFileSync(outFile, buf);
  console.log('已生成', outFile, buf.length, '字节',
    '城市=' + (weather ? weather.city : CITY),
    weather ? ` ${weather.desc} ${weather.tempC}°C` : '');
  return outFile;
}

main().then(f => { process.exit(0); }).catch(e => {
  console.error('生成失败：', (e && e.stack) || e);
  process.exit(1);
});
