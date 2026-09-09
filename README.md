# AI 日报 · Kindle 墨水屏壁纸源

给 KOReader **DashWallpaper** 插件用的「每日 AI 资讯」壁纸。每天定时生成一张
1072×1448 灰度 PNG（16 级抖动），Kindle 休眠时作为看板壁纸显示，含当天 AI
快讯（中文 + 英文一手）与城市天气。

## 它怎么做到「每天更新」？

方案是 **GitHub Actions 定时生成 + GitHub Pages 静态托管**，完全免费、无企业
账号依赖、云端 24 小时在线，不依赖你本地电脑是否开机。

```
每天 06:00（北京时间）
   GitHub Actions 在云端跑 generate.js
   → 抓最新 AI 新闻(RSS) + 指定城市天气(Open-Meteo)
   → 渲染成 wallpaper.png
   → force-push 到 gh-pages 分支
   → GitHub Pages 提供静态 URL
   → Kindle 插件每天早上自动下载这张 PNG
```

壁纸静态 URL（仓库设好后）：
```
https://laozhangqumaizhusiliao.github.io/ai-daily-wallpaper/wallpaper.png
```

## 目录结构

```
ai-daily-wallpaper/
├── generate.js                 # 每日渲染入口（GitHub Actions 调用）
├── server.js                   # 本地动态服务（调试/本地预览用，可选）
├── src/
│   ├── feed.js                 # 抓取 9 个 AI 源 + AI 相关性过滤 + Open-Meteo 天气
│   ├── render.js               # 版式渲染（标题/两行摘要/分组/报头天气/智能缩写）
│   └── png.js                  # 8bit 灰度 PNG 编码器
├── assets/                     # Noto Sans SC 字体（必须入库，CI 渲染依赖）
├── .github/workflows/
│   └── daily-wallpaper.yml     # 每天定时生成并发布到 gh-pages
├── dashwall_sources.txt        # 插件导入示例（名称<TAB>URL）
└── package.json                # 依赖 @napi-rs/canvas（预编译，CI 可直接装）
```

## 本地生成一张

```bash
npm install
CITY="上海" node generate.js     # 产物在 output/wallpaper.png
```

## 改城市

天气城市在 `.github/workflows/daily-wallpaper.yml` 的 `CITY` 环境变量里（当前为
**合肥**）。改成你想显示的城市后，**Kindle 插件里的「我的城市」要设成同一个城市**
（静态 PNG 无法响应不同 `?city=`，所以两侧保持一致）。

## 在 Kindle 上配置

`dashwall_sources.txt`（推送到 KOReader 数据目录后，插件「看板壁纸源 → 从文件
导入」）：
```
AI 日报	https://laozhangqumaizhusiliao.github.io/ai-daily-wallpaper/wallpaper.png
```

## 首次上线必须做的两件事

1. **跑一次生成**：仓库 → Actions → `daily-wallpaper` → Run workflow（等它跑完才会出现 `gh-pages` 分支和 `wallpaper.png`）。
2. **开启 Pages**：仓库 → Settings → Pages → Build and deployment → Source 选 **Deploy from a branch** → 分支选 **gh-pages**、目录选 **/root** → Save。

两者都完成后，上面的 URL 才能返回图片；之前访问会 404。之后每天 06:00（北京时间）自动更新，Kindle 侧无需再改动。

## 手动触发一次

仓库 → Actions → **daily-wallpaper** → Run workflow，可立即生成当日图而不用等
定时。

> 本项目复用 RC-APC/DashWallpaper.koplugin 的插件端：插件只下载 PNG 并写入屏保
> 目录，内容由本仓库的云端生成。
