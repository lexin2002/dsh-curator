# DESIGN.md — dsh-curator 设计方向

> 这份文件是 antislop R-37 要求的设计方向。它记录**已经成立的事实**与**刻意的取舍**，
> 不是待办清单。改 UI 前先读这里。

## 身份

一个**治理面板**，不是展示页。用户来这里是为了：看清本机散落的技能/插件、决定收编哪些、
关掉哪些、装新的。所以信息密度优先于留白，操作可达性优先于视觉惊喜。

**不追求**：装饰性动效、品牌叙事、情绪化的空状态插画。

## Design Read

> Reading this as: 面向开发者的本地治理面板（DSH 插件），
> 视觉语言沿用 DSH 宿主自身的 token 体系（不另立品牌色），
> dial **ENERGY 1 / RHYTHM 2 / MOTION 1**。

| 档位 | 取值 | 依据 |
|---|---|---|
| **ENERGY** | 1（克制） | 面板嵌在宿主侧栏里，是工具不是门面。一屏一个主操作（primary 按钮），强调色只在选中态与主操作上出现。 |
| **RHYTHM** | 2（基本一致，偶有变化） | 列表/卡片两种视图共用同一套条目结构；来源分区与批量条是节奏断点。刻意不做「每个分区长得都不一样」——这是数据面板，可预期性比变化重要。 |
| **MOTION** | 1（基本只有 hover/焦点反馈） | 实测：全插件仅 2 个 `@keyframes`（抽屉滑入、保存点脉冲），14 处 `transition` 全是颜色/边框过渡。`prefers-reduced-motion` 已在媒体查询里处理。不加滚动reveal、不加视差——用户可能一屏扫 500 条技能。 |

## 视觉基准

**收纳方式与层级参考 `@weibaohui/skills-management`**（本机已装的参考实现），但**不照抄长相**：

- 学它的：卡片脚部锚定（`margin-top:auto` + `border-top`）、描述 3 行 clamp 保证网格整齐、
  状态徽章只改文字色与边框色而不填充、状态与动作同槽（未装=「安装」按钮，已装=禁用态「已装」）。
- 不抄它的：它的零动效、零焦点环、用原生 `alert()` 报异步错、弹窗不能 Esc 关闭 ——
  这四条是它的缺陷，本插件全部相反（有 `:focus-visible`、有 toast、Esc 可关抽屉）。
- 不抄它的 `--dsw-alias-bg-base` 用法：它拿这个 token 当全屏底，在鲸鱼娘皮肤下会透壁纸。

## 配色铁律

1. **只用宿主 `--dsw-alias-*` 语义 token**，不写死色值。明暗主题与第三方皮肤自动跟随。
2. **不拿 `--dsw-alias-bg-base` 当背景** —— 鲸鱼娘皮肤把它设为 `transparent`。
   面板底用 `--ss-surface`（`bg-layer-1` 88% + `bg-layer-3`，显式不透明）。
3. **状态色走 `--dsw-alias-state-*`**，不用 `#34c759` / `#ff9500` / `#ff9f0a` 这类固定值：
   实测它们在鲸鱼娘皮肤浅色主题下对比度只有 2.12 / 2.10 / 1.96，低于 WCAG AA 的 4.5。
4. **对比度必须实测**，不靠眼看：`tools/curator-contrast-audit.mjs`（面板底 × 壁纸 12 组合）
   与 `tools/curator-status-contrast.mjs`（状态色 × 两主题）。

## 已知的、刻意保留的取舍

- **头像不做「按名字哈希出彩色」**：本机 14 个插件里 11 个首字母撞脸
  （`@scope/...` 剥成同一个字母），随机配色只制造噪声。首字母块是中性描边块。
- **不用 emoji 当图标**：功能性字形（`✓`）保留，装饰性 emoji 一律不用。
  视图切换的 `☰`/`▦` 改成了内联 SVG（形状即语义，不依赖字体）。
- **毛玻璃只用于 2 处**（抽屉遮罩、吸附保存条）；分区块不用，因为它是大面积元素，
  `backdrop-filter` 在大面积上很贵。

## 相关工具（改 UI 后应重跑）

| 脚本 | 作用 |
|---|---|
| `tools/curator-antislop-audit.mjs` | 按 antislop 规则机械扫描 CSS，找硬证据 |
| `tools/curator-gate-v2.mjs` | 硬门复核（渐变/发光/状态色/字形/玻璃剂量/变量完整性） |
| `tools/curator-contrast-audit.mjs` | 面板底色 × 壁纸的 WCAG 对比度实测 |
| `tools/curator-status-contrast.mjs` | 状态色 × 明暗主题的对比度实测 |
| `tools/curator-motion-inventory.mjs` | 动效清点（用于核对 MOTION 档位没被破坏） |
| `tools/curator-smoke-deep.mjs` | 真跑 `apply(ctx)` + 渲染 Panel（React 桩） |
