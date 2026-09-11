'use strict';
const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { encodeGrayPNG } = require('./png');

// ---------- 字体加载 ----------
function sfntComplete(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 16) return false;
    const numTables = b.readUInt16BE(4);
    if (!numTables || numTables > 200) return false;
    let maxEnd = 12;
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      if (off + 16 > b.length) return false;
      const o = b.readUInt32BE(off + 8);
      const l = b.readUInt32BE(off + 12);
      if (o + l > b.length) return false;
      maxEnd = Math.max(maxEnd, o + l);
    }
    return maxEnd <= b.length;
  } catch { return false; }
}

const FONT_DIR = path.join(__dirname, '..', 'assets');
const FONT_CANDIDATES = [
  { file: 'NotoSansSC_400Regular.ttf', family: 'NSR' },
  { file: 'NotoSansSC_700Bold.ttf', family: 'NSB' },
  { file: 'SimHei.ttf', family: 'NSR' }, // 兜底：黑体当常规体用
];

function loadFonts() {
  const loaded = [];
  for (const c of FONT_CANDIDATES) {
    const p = path.join(FONT_DIR, c.file);
    if (fs.existsSync(p) && sfntComplete(p)) {
      GlobalFonts.registerFromPath(p, c.family);
      loaded.push(c.family);
    }
  }
  if (!loaded.includes('NSR')) throw new Error('assets 目录下没有任何可用的中文字体');
  if (!loaded.includes('NSB')) loaded.push('NSR');
  return loaded;
}

const fonts = loadFonts();
const HAS_BOLD = fonts.includes('NSB');
const F_REG = 'NSR';
const F_BOLD = HAS_BOLD ? 'NSB' : 'NSR';

// ---------- 设计基准（1072 x 1448 竖屏）----------
const BASE_W = 1072;
const BASE_H = 1448;

function relTime(hours) {
  if (hours === null || hours === undefined) return '';
  const m = Math.round(hours * 60);
  if (m < 60) return m + '分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + '小时前';
  return Math.round(h / 24) + '天前';
}

// 分词：CJK 单字成词，拉丁字母/数字连成词，便于换行
function tokenize(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u2014\u2018\u2019\u201c\u201d\u2026]/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else if (ch === ' ') {
      if (buf) { out.push(buf); buf = ''; }
      out.push(' ');
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// 完整换行（不限制行数），返回所有行
function wrapAll(ctx, text, maxW) {
  const tokens = tokenize(text);
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    if (cur && ctx.measureText(cur + t).width > maxW) {
      lines.push(cur.trimEnd());
      cur = t === ' ' ? '' : t;
    } else {
      cur += t;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [''];
}

// 按 maxLines 试排，返回 { lines, overflow }
function fitLines(ctx, text, maxW, maxLines) {
  const all = wrapAll(ctx, text, maxW);
  if (all.length <= maxLines) return { lines: all, overflow: false };
  return { lines: all.slice(0, maxLines), overflow: true };
}

// 去掉尾部的分隔符、空白与残留标点
function cleanTail(s) {
  return String(s)
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[\s，。、；：,;:·|｜/\\\-—–~～!！?？、）】〉》」』\]\.。]+$/u, '')
    .trim();
}

// 去掉尾部被截断的半截英文单词，避免出现 "OpenA"
function trimPartialWord(s) {
  const arr = Array.from(s);
  while (arr.length > 1) {
    const last = arr[arr.length - 1];
    if (!/[A-Za-z0-9]/.test(last)) break;
    arr.pop();
  }
  return arr.join('');
}

// 标题里可作为"断句点"的分隔符
const DELIM_RE = /(｜|\||，|,|、|：|:|;|；|——|—|–|·|\/|以及)/g;

/**
 * 智能缩写：把标题压缩到 maxLines 行内完整显示，不加省略号。
 * 策略（保留的信息量从多到少依次尝试，第一个能放下的即采用）：
 *   1. 原文能放下 -> 原样
 *   2. 去掉括号内的补充说明
 *   3. 按分隔符逐段去掉尾部（中文标题重点通常在前）
 *   4. 二分查找最长可容纳前缀，并清理尾部的半截单词与标点
 */
function shortenToFit(ctx, text, maxW, maxLines) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [''];

  const first = fitLines(ctx, t, maxW, maxLines);
  if (!first.overflow) return first.lines;

  const cands = [];
  const add = (s) => {
    const v = cleanTail(trimPartialWord(cleanTail(s)));
    if (v.length >= 4 && !cands.includes(v)) cands.push(v);
  };

  // 2) 去掉圆括号 / 方括号内的补充说明
  add(t.replace(/[（(][^（）()]*[）)]/g, '').replace(/[【\[][^【】\[\]]*[】\]]/g, ''));

  // 3) 按分隔符切段，从"只去掉最后一段"开始，逐步缩短
  const parts = t.split(DELIM_RE).filter(p => p !== undefined && p !== '');
  for (let k = parts.length - 1; k >= 1; k--) {
    add(parts.slice(0, k).join(''));
  }
  // 去掉开头 4 字以内的栏目标签（如"早报｜""快讯："），保留后面的正文
  if (parts.length >= 3 && Array.from(parts[0]).length <= 4) {
    add(parts.slice(1).join(''));
  }
  // 对去括号后的结果再做一次分段缩短
  const noParen = t.replace(/[（(][^（）()]*[）)]/g, '');
  if (noParen !== t) {
    const p2 = noParen.split(DELIM_RE).filter(p => p !== undefined && p !== '');
    for (let k = p2.length - 1; k >= 1; k--) add(p2.slice(0, k).join(''));
  }

  for (const c of cands) {
    const r = fitLines(ctx, c, maxW, maxLines);
    if (!r.overflow && r.lines.length) return r.lines;
  }

  // 4) 兜底：二分找最长可容纳前缀
  const chars = Array.from(t);
  let lo = 1, hi = chars.length, best = chars.slice(0, 10).join('');
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = cleanTail(trimPartialWord(chars.slice(0, mid).join('')));
    if (cut && !fitLines(ctx, cut, maxW, maxLines).overflow) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const r = fitLines(ctx, best, maxW, maxLines);
  return r.lines.length ? r.lines : [best];
}

// 日期一律按北京时间（UTC+8）计算，不依赖运行环境：
// GitHub Actions 的 runner 默认是 UTC，凌晨生成时会算成"昨天"，
// 而工作流里的 TZ 设置容易在改动 yml 时被覆盖丢失，所以在代码里固定换算。
const BJ_OFFSET_MS = 8 * 3600 * 1000;

function fmtDate(input) {
  const ts = (input instanceof Date) ? input.getTime() : input;
  const d = new Date((ts || Date.now()) + BJ_OFFSET_MS);
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  const p = n => String(n).padStart(2, '0');
  return {
    ymd: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
    week: '星期' + wd[d.getUTCDay()],
    short: `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

// 单行放不下时硬截（不加省略号），用于辅助信息行
function fitOneLine(ctx, text, maxW) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (ctx.measureText(t).width <= maxW) return t;
  const chars = Array.from(t);
  let lo = 1, hi = chars.length, best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = trimPartialWord(cleanTail(chars.slice(0, mid).join('')));
    if (cut && ctx.measureText(cut).width <= maxW) { best = cut; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// 剥掉 desc 里的噪音前缀：作者/编辑/来源/记者/时间戳等，只留下真正的资讯正文。
// 中文资讯源 description 常有"作者｜编辑｜2026 年 2 月 3 日，…"这类头，正文在后面甚至根本没有。
function stripMetaNoise(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  // 去掉开头的作者类前缀段（一直到下一个正文分隔前）
  t = t.replace(/^[\s（(]*(?:作者|编辑|来源|记者|文|图|据|快讯|摘要|导读)[\s：:|｜·/／]*[^，。；;]{0,14}[\s：:|｜·/／,，；;]*/, '');
  // 去掉嵌入/开头的时间戳："2026 年 2 月 3 日，" / "9 月 8 日，" / "2026-02-03"
  t = t
    .replace(/^(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?[，,，\s]*/, '')
    .replace(/^(?:\d{4}[-/.]\s*)?\d{1,2}[-/.]\d{1,2}[-/.]?\d{0,4}[\s，,]/, '');
  return t.trim();
}

// 提取内容的第一句话（到句号/分号/感叹号为止），作为"一句话摘要"；
// 没有完整句子时按最长的前置片段。避免把整段长文挤进一行造成残缺。
function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // 优先取到第一个句末标点（含标点，保证读起来完整）
  const full = t.match(/^[\s\S]*?[。！？!?；;](?=\s|$)/);
  if (full) return full[0];
  // 无句末标点：取最长以逗号/空格为界的首个片段（最多 ~22 字）
  const seg = t.match(/^[^，,、；;]{0,22}/);
  return seg ? seg[0] : t.slice(0, 22);
}

/**
 * 渲染壁纸（看板风格：白底报头 + 黑色分组条 + 紧凑双行条目）。
 * 返回 8bit 灰度 PNG Buffer。
 * opts: { w, h, items, weather, fetchedAt, sourceCount }
 */
function renderWallpaper(opts) {
  const w = opts.w | 0;
  const h = opts.h | 0;
  const items = opts.items || [];
  const weather = opts.weather || null;
  const fetchedAt = opts.fetchedAt || Date.now();

  // 设计基准画布，等比缩放并居中，适配任意尺寸
  const s = Math.min(w / BASE_W, h / BASE_H);
  const bw = Math.max(1, Math.round(BASE_W * s));
  const bh = Math.max(1, Math.round(BASE_H * s));

  const canvas = createCanvas(bw, bh);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bw, bh);

  const M = 48 * s;            // 页边距
  const CW = bw - M * 2;       // 内容宽度
  const d = fmtDate(new Date(fetchedAt));

  // ---------- 报头（白底，作者同款：大标题 + 右侧天气 + 副标题行 + 粗黑线）----------
  ctx.fillStyle = '#000000';
  ctx.font = `bold ${Math.round(54 * s)}px ${F_BOLD}`;
  ctx.fillText('AI 日报', M, 32 * s);

  ctx.font = `${Math.round(26 * s)}px ${F_REG}`;
  ctx.fillStyle = '#444444';
  // 报头右上：城市 · 当日天气 · 全天温度区间。
  // 用最低~最高而非生成时刻的实况温度——壁纸一整天不变，
  // 单点温度到下午就会"对不上"，区间全天都成立。
  let headRight;
  if (weather) {
    const tempTxt = (weather.lo !== null && weather.hi !== null)
      ? `${weather.lo}~${weather.hi}°C`
      : `${weather.tempC}°C`;
    headRight = `${weather.city} · ${weather.desc} · ${tempTxt}`;
  } else {
    headRight = `${d.ymd} ${d.week}`;
  }
  ctx.fillText(headRight, bw - M - ctx.measureText(headRight).width, 44 * s);

  ctx.font = `${Math.round(24 * s)}px ${F_REG}`;
  ctx.fillStyle = '#888888';
  ctx.fillText('每日 AI 资讯精选 · 休眠壁纸', M, 100 * s);
  const headSub = weather ? `${d.ymd} ${d.week}` : 'AI Daily Digest';
  ctx.fillText(headSub, bw - M - ctx.measureText(headSub).width, 100 * s);

  ctx.fillStyle = '#000000';
  ctx.fillRect(M, 140 * s, CW, Math.max(2, Math.round(5 * s)));

  // ---------- 列表区 ----------
  const listTop = 156 * s;
  const footerH = 54 * s;
  const listBottom = bh - footerH;

  const GROUP_H = 36 * s, GROUP_ABOVE = 16 * s, GROUP_BELOW = 10 * s;
  const ROW_H = 84 * s;    // 条目行高加大，容纳两行摘要 + 标题
  const NUM_W = 40 * s;        // 序号列宽
  const TAG_H = 28 * s;        // 来源标签高

  const groups = [
    { name: '中文快讯', list: items.filter(i => i.lang === 'zh') },
    { name: '英文一手', list: items.filter(i => i.lang !== 'zh') },
  ].filter(g => g.list.length);

  let y = listTop;
  let drawn = 0;
  const drawnPerGroup = [];

  // 中英文各占约一半版面：先按总行容量估出配额，再开画。
  // 否则中文组先画会把空间占满，英文组只剩页脚上一两条。
  {
    const overhead = groups.length * (GROUP_H + GROUP_BELOW) + (groups.length - 1) * GROUP_ABOVE;
    const totalRows = Math.max(1, Math.floor((listBottom - listTop - overhead) / ROW_H));
    const halfRows = Math.ceil(totalRows / 2);
    // 某组条目不足配额时，富余行数让给下一组，保证版面不空
    let spare = 0;
    for (const g of groups) {
      const target = halfRows + spare;
      const cap = Math.min(g.list.length, target);
      spare = target - cap;
      g.cap = cap;
    }
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (gi > 0) y += GROUP_ABOVE;
    if (y + GROUP_H + Math.round(ROW_H * 0.6) > listBottom) break;

    // 黑色分组条：组名 + 计数（计数需等画完才知道实际条数，位置先记下）
    const cntY = y + 7 * s;
    ctx.fillStyle = '#000000';
    ctx.fillRect(M, y, CW, GROUP_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(22 * s)}px ${F_BOLD}`;
    ctx.fillText(g.name, M + 12 * s, cntY);
    y += GROUP_H + GROUP_BELOW;

    let n = 0;
    const cap = g.cap || g.list.length;
    for (let i = 0; i < g.list.length && n < cap; i++) {
      if (y + ROW_H > listBottom) break;
      const it = g.list[i];

      // 来源标签（右侧描边小方块）
      ctx.font = `${Math.round(20 * s)}px ${F_REG}`;
      const tagTxt = String(it.source);
      const tagW = ctx.measureText(tagTxt).width + 16 * s;
      const tagX = M + CW - tagW;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, 1.4 * s);
      ctx.strokeRect(tagX, y + 2 * s, tagW, TAG_H);
      ctx.fillStyle = '#000000';
      ctx.fillText(tagTxt, tagX + 8 * s, y + 6 * s);

      // 序号
      ctx.fillStyle = '#999999';
      ctx.font = `${Math.round(20 * s)}px ${F_REG}`;
      ctx.fillText(String(i + 1).padStart(2, '0'), M, y + 4 * s);

      // 标题（加粗，单行，智能缩短且不加省略号）
      const tx = M + NUM_W;
      ctx.font = `bold ${Math.round(30 * s)}px ${F_BOLD}`;
      ctx.fillStyle = '#000000';
      const tl = shortenToFit(ctx, it.title, tagX - tx - 14 * s, 1);
      ctx.fillText(tl[0] || '', tx, y);

      // 第二行：直接显示内容摘要（不显示作者/时间），字号更小，因此可容纳明显多于标题的字数
      // 宽度略放宽（借到标签左侧），用 shortenToFit 完整缩写到一行，绝不出现残词残句。
      // 摘要可比标题长：标题字号 30、摘要字号 22，同等宽度下摘要可容纳约 30/22 ≈ 1.36 倍字符数。
      const metaW = tagX - tx - 10 * s;
      const descTxt = String(it.desc || '').replace(/\s+/g, ' ').trim();
      // 过滤掉\"作者/发布时间\"这类无效摘要，避免第二行只剩时间和来源噪音
      const usefulDesc = descTxt.length >= 8 && !/^(作者|来源|据|文|图|编辑|记者)[''：:]?[^，。]{0,12}$/.test(descTxt)
        && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(descTxt);
      // 清洗掉 desc 里的作者/编辑/时间戳噪音，只留真正的资讯正文
      const cleaned = stripMetaNoise(it.desc);
      const metaSrc = cleaned.length >= 8 ? cleaned : it.title;
      // 摘要最多排 2 行（字号更小 → 能容纳约 2 倍的文本量），绝不出残词残句
      ctx.font = `${Math.round(19 * s)}px ${F_REG}`;
      ctx.fillStyle = '#555555';
      if (metaSrc) {
        const lines = ctx.measureText(metaSrc).width <= metaW
          ? [metaSrc]
          : shortenToFit(ctx, metaSrc, metaW, 2);
        ctx.fillText(lines[0] || '', tx, y + 40 * s);
        if (lines[1]) ctx.fillText(lines[1], tx, y + 62 * s);
      }


      y += ROW_H;
      n++;
    }
    // 实际展示条数补画到分组条右侧
    const cnt = String(n);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(22 * s)}px ${F_BOLD}`;
    ctx.fillText(cnt, M + CW - 12 * s - ctx.measureText(cnt).width, cntY);

    drawnPerGroup.push({ name: g.name, count: n });
    drawn += n;
    if (y + ROW_H > listBottom && n < g.list.length) break;
  }

  if (drawn === 0) {
    ctx.font = `${Math.round(34 * s)}px ${F_REG}`;
    ctx.fillStyle = '#555555';
    ctx.fillText('今日暂无更新，稍后自动重试', M, listTop + 30 * s);
  }

  // ---------- 页脚 ----------
  ctx.fillStyle = '#000000';
  ctx.fillRect(M, bh - footerH, CW, Math.max(1, Math.round(1.5 * s)));
  ctx.font = `${Math.round(22 * s)}px ${F_REG}`;
  ctx.fillStyle = '#777777';
  const stat = opts.stat || '';
  ctx.fillText(`看板休眠壁纸 · 更新于 ${d.short} · ${drawn} 条 · ${opts.sourceCount || 0} 来源${stat ? ' · ' + stat : ''}`, M, bh - footerH + 12 * s);

  // ---------- 转灰度 + 16 级抖动 + PNG ----------
  const img = ctx.getImageData(0, 0, bw, bh).data;
  const gray = toGray16(img, bw, bh);

  if (bw === w && bh === h) return encodeGrayPNG(gray, w, h);

  // 尺寸不一致时居中贴到白底
  const out = new Uint8Array(w * h).fill(255);
  const ox = Math.floor((w - bw) / 2);
  const oy = Math.floor((h - bh) / 2);
  for (let yy = 0; yy < bh; yy++) {
    const dy = oy + yy;
    if (dy < 0 || dy >= h) continue;
    for (let xx = 0; xx < bw; xx++) {
      const dx = ox + xx;
      if (dx < 0 || dx >= w) continue;
      out[dy * w + dx] = gray[yy * bw + xx];
    }
  }
  return encodeGrayPNG(out, w, h);
}

// RGBA -> 灰度（合成白底）-> Floyd-Steinberg 抖动到 16 级
function toGray16(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const lum = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    g[i] = lum * a + 255 * (1 - a);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = g[i];
      const nw = Math.round(old / 17) * 17;
      g[i] = nw;
      const err = old - nw;
      if (x + 1 < w) g[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) g[i + w - 1] += (err * 3) / 16;
        g[i + w] += (err * 5) / 16;
        if (x + 1 < w) g[i + w + 1] += err / 16;
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(g[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

module.exports = { renderWallpaper };
