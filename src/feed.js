'use strict';

// 内容源配置：改这里即可增删订阅源。weight 用于排序加权，lang 用于中英搭配。
// 注意：单源失败会被自动跳过，不会影响整体出图。
const SOURCES = [
  // ---- 中文 ----
  { id: 'qbitai', name: '量子位', lang: 'zh', weight: 1.0, url: 'https://www.qbitai.com/feed' },
  { id: 'ifanr', name: '爱范儿', lang: 'zh', weight: 0.9, url: 'https://www.ifanr.com/feed' },
  { id: 'geekpark', name: '极客公园', lang: 'zh', weight: 0.9, url: 'https://www.geekpark.net/rss' },
  { id: 'jiqizhixin', name: '机器之心', lang: 'zh', weight: 1.0, url: 'https://www.jiqizhixin.com/rss' },
  // ---- 英文一手 ----
  { id: 'openai', name: 'OpenAI', lang: 'en', weight: 1.15, url: 'https://openai.com/news/rss.xml' },
  { id: 'huggingface', name: 'Hugging Face', lang: 'en', weight: 1.05, url: 'https://huggingface.co/blog/feed.xml' },
  { id: 'techcrunch', name: 'TechCrunch', lang: 'en', weight: 0.95, url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { id: 'verge', name: 'The Verge', lang: 'en', weight: 0.9, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { id: 'mittr', name: 'MIT科技评论', lang: 'en', weight: 0.95, url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
];

const UA = 'Mozilla/5.0 (compatible; DashWallpaperAI/1.0; +https://github.com/RC-APC/DashWallpaper.koplugin)';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·', yen: '¥',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCode(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function safeCode(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function cleanText(s) {
  if (!s) return '';
  return decodeEntities(String(s))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一段 XML 里抽取 <tag ...>body</tag>，兼容属性与自闭合
function pickTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i'));
  return m ? m[1] : '';
}

function pickLink(block) {
  const rss = pickTag(block, 'link').trim();
  if (rss) return rss;
  const m = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
  return m ? m[1] : '';
}

function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry\s*>/gi : /<item[\s>][\s\S]*?<\/item\s*>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = cleanText(pickTag(b, 'title'));
    if (!title) continue;
    const link = pickLink(b);
    const dateRaw = pickTag(b, 'pubDate') || pickTag(b, 'published') || pickTag(b, 'updated') || pickTag(b, 'dc:date');
    let ts = dateRaw ? Date.parse(dateRaw.trim()) : NaN;
    if (Number.isNaN(ts)) ts = null;
    // 正文优先取自 content:encoded / content（含完整资讯内容），description/summary 仅兜底；
    // 否则中文资讯源的 description 常只是"作者 · 发布时间"，会挤掉真正的内容正文。
    const desc = cleanText(pickTag(b, 'content:encoded') || pickTag(b, 'content') || pickTag(b, 'description') || pickTag(b, 'summary'));
    out.push({ title, link, ts, desc: desc.slice(0, 400) });
  }
  return out;
}

async function fetchFeed(src, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(src.url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return parseFeed(text);
  } finally {
    clearTimeout(timer);
  }
}

// 归一化标题用于去重：只保留字母数字与 CJK
function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function charBigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const NOISE = /(广告|赞助|推广|招商|合作|招聘|直播预告|报名|优惠券|限时|特惠|subscription|sponsor|advertis|promo|webinar|deal\b)/i;

// ============ AI 相关性判定 ============
// 强信号：命中 1 个即判定为 AI 相关
const AI_STRONG = [
  /\bA\.?I\.?\b/i, /人工智能/, /大模型/, /大语言模型/, /生成式/, /\bAIGC\b/i,
  /机器学习/, /深度学习/, /神经网络/, /智能体/, /多模态/, /具身智能/, /人形机器人/,
  /数字人/, /文生图/, /文生视频/, /语音助手/, /对话式/, /认知智能/,
  /Transformer/i, /扩散模型/, /大模型应用/, /模型参数/, /上下文窗口/,
  /\bLLM\b/i, /\bGPT\b/i, /ChatGPT/i, /\bClaude\b/i, /\bGemini\b/i, /DeepSeek/i,
  /\bQwen\b/i, /通义/, /豆包/, /文心/, /智谱/, /\bGLM\b/, /混元/, /\bKimi\b/i, /\bSora\b/i,
  /\bLlama\b/i, /Mistral/i, /Copilot/i, /\bGrok\b/i, /Midjourney/i, /Stable ?Diffusion/i,
  /可灵/, /即梦/, /\bCursor\b/, /Perplexity/i, /NotebookLM/i, /\bOllama\b/i, /\bLMArena\b/i,
  /OpenAI/i, /Anthropic/i, /DeepMind/i, /Hugging ?Face/i, /\bxAI\b/, /月之暗面/,
  /百川智能?/, /零一万物/, /阶跃星辰/, /面壁智能/, /MiniMax/i,
  /\bAGI\b/, /\bRLHF\b/i, /\bRAG\b/, /Agentic/i, /微调/, /fine-?tun/i, /对齐/,
  /artificial intelligence/i, /machine learning/i, /deep learning/i,
  /large language model/i, /foundation model/i, /generative (ai|model)/i, /\bchatbot\b/i,
  /语音识别/, /图像识别/, /自然语言处理/, /知识图谱/, /强化学习/,
];

// 弱信号：单独出现不足以判定，需要至少 2 个（避免"手机芯片""汽车机器人"误入）
const AI_WEAK = [
  /算力/, /数据中心/, /\bGPU\b/i, /芯片/, /半导体/, /\bNVIDIA\b/i, /英伟达/,
  /机器人/, /自驾/, /自动驾驶/, /智驾/, /算法/, /\bdataset\b/i, /数据集/,
  /开源模型/, /推理/, /\binference\b/i, /训练/, /算力集群/, /智能眼镜/, /AI硬件/i,
  /自动化/, /automation/i, /大语言/, /参数量/, /预训练/, /量化/, /\btoken\b/i,
];

// 明确非 AI 话题，直接排除
const AI_NEG = [
  /彩票|足彩|赌球/, /绯闻|八卦|出轨|离婚/, /考研|高考|四六级/,
  /房价|楼市|楼盘/, /食谱|菜谱|减肥|健身教程/, /旅游攻略|景区|门票/,
  /股[票市]异动|涨停|跌停/, /球[赛星]|足[球坛]|篮[球坛]|NBA|CBA/i,
];

function aiClassify(text) {
  if (!text) return { ai: 0, score: 0 };
  if (AI_NEG.some(r => r.test(text))) return { ai: 0, score: 0 };
  let strong = 0, weak = 0;
  for (const r of AI_STRONG) if (r.test(text)) strong++;
  for (const r of AI_WEAK) if (r.test(text)) weak++;
  if (strong > 0) return { ai: 2, score: Math.min(3, strong) };
  if (weak >= 2) return { ai: 1, score: 0.5 };
  return { ai: 0, score: 0 };
}

// 把"早报"式多话题标题拆成子话题，便于只保留 AI 相关的那一段
function splitTopics(title) {
  return String(title)
    .split(/[；;｜|]+|\s\/\s|\/(?=[\u4e00-\u9fff])/)
    .map(s => s.trim())
    .filter(s => Array.from(s).length >= 4);
}

let lastStats = { scanned: 0, aiHit: 0, droppedNonAi: 0, window: '' };

function collect(rawBySource, now, limit, maxHours, minAi) {
  const seen = [];
  const items = [];
  lastStats = { scanned: 0, aiHit: 0, droppedNonAi: 0, window: `${maxHours}h/minAi${minAi}` };

  for (const src of SOURCES) {
    const list = rawBySource[src.id] || [];
    let used = 0;
    for (const it of list) {
      lastStats.scanned++;
      let hours = null;
      if (it.ts) {
        hours = (now - it.ts) / 3600000;
        if (hours < -1 || hours > maxHours) continue; // 未来时间或太旧
      }
      const title = String(it.title || '').trim();
      if (normTitle(title).length < 6) continue; // 过短的标题没价值
      if (NOISE.test(title)) continue;

      // ---- AI 相关性筛选（在载入阶段就过滤，非 AI 内容不进入候选）----
      let showTitle = title;
      let cls;
      const topics = splitTopics(title);
      if (topics.length > 1) {
        // 多话题标题（如"早报｜A；B；C"）：只保留命中 AI 的子话题
        const hits = topics.map(t => ({ t, c: aiClassify(t) })).filter(x => x.c.ai >= minAi);
        if (!hits.length) { lastStats.droppedNonAi++; continue; }
        // 去掉"环比增长379%，"这类数据前缀，让子话题读起来更完整
        showTitle = hits.slice(0, 2)
          .map(x => x.t.replace(/^(?:环比|同比)[^，,]{0,20}[，,]\s*/, ''))
          .join('；');
        cls = { ai: Math.max(...hits.map(x => x.c.ai)), score: Math.max(...hits.map(x => x.c.score)) };
      } else {
        cls = aiClassify(title);
        if (cls.ai < minAi) {
          cls = aiClassify(title + ' ' + (it.desc || '')); // 用描述兜底判定
          if (cls.ai < minAi) { lastStats.droppedNonAi++; continue; }
        }
      }
      lastStats.aiHit++;

      const dkey = normTitle(showTitle);
      const grams = charBigrams(dkey);
      let dup = false;
      for (const s of seen) {
        if (s.key === dkey || jaccard(s.grams, grams) > 0.55) { dup = true; break; }
      }
      if (dup) continue;
      seen.push({ key: dkey, grams });

      const recency = hours === null ? 0.12 : Math.exp(-hours / 20);
      const score = recency * src.weight + 0.12 * cls.score + (cls.ai === 2 ? 0.1 : 0);
      items.push({
        title: showTitle, link: it.link, ts: it.ts, hours,
        source: src.name, lang: src.lang, score, ai: cls.ai,
        desc: String(it.desc || '').slice(0, 160),
      });
      used++;
      if (used >= 40) break; // 单源最多取 40 条候选
    }
  }

  // 排序：AI 相关度高的优先，其次看综合分
  const byScore = (a, b) => (b.ai - a.ai) || (b.score - a.score);
  const zh = items.filter(i => i.lang === 'zh').sort(byScore);
  const en = items.filter(i => i.lang !== 'zh').sort(byScore);
  const halfZh = Math.ceil(limit / 2);
  let picked = zh.slice(0, halfZh).concat(en.slice(0, limit - Math.min(zh.length, halfZh)));
  if (picked.length < limit) {
    const rest = items.filter(i => !picked.includes(i)).sort(byScore);
    picked = picked.concat(rest.slice(0, limit - picked.length));
  }
  // 展示顺序：新在前
  picked.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return picked.slice(0, limit);
}

// 逐级放宽，优先保证"强 AI 相关 + 新鲜"
function aggregate(rawBySource, now, opts) {
  const limit = (opts && opts.limit) || 8;
  const attempts = [
    { maxHours: 48, minAi: 2 },
    { maxHours: 72, minAi: 2 },
    { maxHours: 72, minAi: 1 },
    { maxHours: 120, minAi: 1 },
  ];
  let best = [];
  for (const a of attempts) {
    best = collect(rawBySource, now, limit, a.maxHours, a.minAi);
    if (best.length >= limit) break;
  }
  return best;
}

async function loadNews(opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 9000;
  const results = await Promise.allSettled(SOURCES.map(s => fetchFeed(s, timeoutMs)));
  const rawBySource = {};
  const status = [];
  results.forEach((r, i) => {
    const s = SOURCES[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      rawBySource[s.id] = r.value;
      status.push({ source: s.name, ok: true, items: r.value.length });
    } else {
      status.push({ source: s.name, ok: false, error: String((r.reason && r.reason.message) || r.reason).slice(0, 120) });
    }
  });
  const okCount = status.filter(s => s.ok).length;
  if (okCount === 0) throw new Error('所有内容源均抓取失败: ' + status.map(s => s.source + '(' + s.error + ')').join(', '));
  const items = aggregate(rawBySource, Date.now(), opts);
  return { items, status, fetchedAt: Date.now(), stats: { ...lastStats, kept: items.length } };
}

// 城市天气（Open-Meteo，免费无需 key；失败静默返回 null，不影响壁纸生成）。
// 与作者插件同款链路：插件把「我的城市」以 ?city 传给服务端，这里按城市定位并取真实天气。
const WMO_CODE = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

// 常用城市中文名 -> 已知坐标，省一次地理编码请求；未命中则走搜索接口
const CITY_COORDS = {
  '北京': [39.90, 116.40], '上海': [31.23, 121.47], '广州': [23.13, 113.26], '深圳': [22.54, 114.06],
  '杭州': [30.27, 120.16], '南京': [32.06, 118.80], '成都': [30.57, 104.07], '武汉': [30.59, 114.31],
  '西安': [34.34, 108.94], '重庆': [29.56, 106.55], '天津': [39.08, 117.20], '苏州': [31.30, 120.58],
  '香港': [22.32, 114.17], '澳门': [22.20, 113.55], '台北': [25.03, 121.57], '东京': [35.68, 139.69],
  '纽约': [40.71, -74.01], '伦敦': [51.51, -0.13], '巴黎': [48.86, 2.35], '新加坡': [1.35, 103.82],
};

const coordsCache = new Map();
const geoCached = (city) => coordsCache.get(city);

async function geoCode(city) {
  const hit = coordsCache.get(city);
  if (hit) return hit;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json';
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA } });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j && j.results && j.results[0];
    if (!r) return null;
    const v = [r.latitude, r.longitude];
    coordsCache.set(city, v);
    return v;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function loadWeather(city, timeoutMs) {
  if (!city) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 5000);
  try {
    const known = CITY_COORDS[city];
    let coords = known || (geoCached(city) || await geoCode(city));
    if (!coords) return null;
    const now = new Date();
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + coords[0] + '&longitude=' + coords[1]
      + '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const cur = j && j.current;
    if (!cur) return null;
    // 「平均温度」= (今日最高 + 今日最低) / 2，比单一当前温度更能代表当日
    const dMax = j.daily && j.daily.temperature_2m_max && j.daily.temperature_2m_max[0];
    const dMin = j.daily && j.daily.temperature_2m_min && j.daily.temperature_2m_min[0];
    const avg = (dMax !== undefined && dMin !== undefined) ? Math.round((dMax + dMin) / 2) : Math.round(cur.temperature_2m);
    return {
      city,
      tempC: Math.round(cur.temperature_2m),
      avg: avg,
      hi: dMax !== undefined ? Math.round(dMax) : null,
      lo: dMin !== undefined ? Math.round(dMin) : null,
      desc: WMO_CODE[cur.weather_code] || '',
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { SOURCES, loadNews, loadWeather };
