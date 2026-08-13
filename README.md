# 字符工坊 GlyphWorks · Windows 版

图片 / 视频一键生成 ASCII 字符画的 Windows 桌面应用，基于 07 字符工坊（`00KEENTROPY/demos/07-ascii`）移植：
算法与视觉完整继承，浏览器边界全部换成 Windows 原生能力。

## 特性

- 拖入 / 打开图片或视频，全部在本机处理，不上传、不联网、不存储。
- 三种渲染通道：密度单通道（支持 ▀▄█ 半块纵向翻倍）、亮度前景、双通道（chafa 式背景+前景灰度）。
- 参数：细腻度 40–420 列、70/10/6 级字符集、对比度、Floyd–Steinberg / Bayer 抖动、深色磷光 / 浅色墨纸、反色。
- 输出：复制文本、保存 `.txt`、保存 `.png`（与预览同一张位图）、导出 `.mp4`（原帧率、含原声、零丢帧）。
- 视频：单帧取字 + 实时打印；导出用内置 FFmpeg 先本地解码全部画面帧（预渲染），再编码为 H.264 MP4。
- 视频导出会把画面最长边限制在 1920 像素（高细腻度时字符等比缩小），避免内存紧张时编码失败。
- 内置 FFmpeg 支持浏览器解不了的格式：MKV / MOV / AVI / WMV / HEVC 视频，TIFF / HEIC 图片。
- Windows 集成：原生打开/另存为对话框、文件关联（右键“打开方式”）、拖文件到程序图标、单实例、无界面 CLI。
- 1.1.0「版画工坊」界面：黑木工作台 + 纸样打样 + 朱砂印；六套策展预设、盖印揭示动画、样张角线与铭牌、首启示例、键盘快捷键、导出进度条。
- 1.2.0「从打样到成作」：落款钤印（自定义印章字与题款，覆盖预览 / PNG / MP4 / CLI）；PNG 成作精度 1×/2×/4×（像素上限保护）；样张档案（版次卡一键复原参数）；放大检视与原图对比；最近文件（含 Windows 跳转列表）；拖出保存。

## 运行与安装

开发运行（需 Node.js 20+）：

```powershell
npm install
npm run dev
```

构建与打包（产物为**单一安装包** `dist\GlyphWorks-1.2.0-Setup.exe`，内置 Electron 与 FFmpeg，用户无需另装任何东西）：

```powershell
npm run dist
```

## 使用

1. 双击启动，把图片或视频拖进窗口，或点「打开文件（系统对话框）」。
2. 调整参数后点「应用参数」；视频可切换「单帧取字 / 实时打印」。
3. 复制字符，或保存 TXT / PNG；视频点「导出 .mp4（原帧率）」。

## 命令行（CLI）

无界面批量转换，也可用于自动化：

```powershell
GlyphWorks.exe --cli --input in.png --output out.txt --columns 110
GlyphWorks.exe --cli --input in.mp4 --output out.mp4 --channel dual --theme light
GlyphWorks.exe --cli --input in.tiff --output out.png --half-block
```

参数：`--input`、`--output`（默认 `<输入名>-ascii.txt|.mp4`）、`--columns 40–480`、`--ramp classic|block|simple`、`--contrast 0.5–2`、`--dither none|floyd|bayer`、`--theme dark|light`、`--channel density|luminance|dual`、`--half-block`、`--invert`、`--seal <印章字 1–4>`、`--colophon <题款>`、`--scale 1|2|4`（PNG 成作精度）。
输出格式由 `--output` 扩展名决定：`.txt` / `.png` / `.mp4`。

## 支持的格式

- 图片：PNG / JPG / WebP / GIF / AVIF / BMP / SVG / TIFF / HEIC（后两者由内置 FFmpeg 解码）。
- 视频：MP4 / WebM / OGG / MKV / MOV / AVI / WMV（浏览器解不了的由内置 FFmpeg 解码；实时打印仅对浏览器可解码格式可用）。

## 开发与验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

界面视觉审查（输出空态与示例态两张截图，供设计迭代比对）：

```powershell
npm run build
npx electron . --shot shot   # 生成 shot-empty.png 与 shot-working.png
```

项目结构：`electron/`（主进程、preload 桥、FFmpeg 子进程封装）、`src/lib/ascii.ts`（07 原样复用的纯算法库）、`src/lib/demo.ts`（首启示例的程序化木版画）、`src/components/`（界面与导出管线）、`resources/ffmpeg/`（随包内置的 ffmpeg.exe / ffprobe.exe，未提交二进制，从本机 FFMPEG 目录复制）。

## 许可与隐私

- 本项目代码 MIT。
- 随包内置的 FFmpeg 为 gyan.dev LGPL 静态构建，许可文本见 `resources/ffmpeg/LICENSE.txt`，源码获取途径见 `resources/ffmpeg/README.txt`。
- 所有转换都在本机完成，不采集、不上传任何文件；请勿处理真实敏感资料。
- 安装包未做商业代码签名，首次运行可能触发 SmartScreen 提示（选择“仍要运行”即可）。
