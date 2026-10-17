# 关于 skills-management 的本地补丁与皮肤层

本目录记录两件事：

1. 针对 `@weibaohui/skills-management` 的**两处本地补丁**（要写进它的目录）
2. dsh-curator 侧的**「+ 技能」浮层皮肤层**（**不碰它的源码**）

补丁写在 `~/.dsh/profiles/desktop/node_modules/@weibaohui/skills-management/client/`，
**重装或升级该插件会覆盖掉**，届时重跑脚本即可。皮肤层在 curator 里，不受影响。

## 补丁 1：样式注入健壮性（修「picker UI 错乱」）

**症状**：与 dsh-curator 共存时，「+ 技能」浮层整张样式表失效 ——
浮层掉进文档流跑到屏幕角落、行内名称与描述黏连换行。

**根因**（`client/index.js:44-51`）：

```js
function ensureStyles() {
  if (document.getElementById('sk-styles')) return   // ← 幂等判据太弱
  const holder = document.createElement('div')
  holder.style.display = 'none'                      // ← 样式藏在隐藏容器里
  holder.innerHTML = STYLE
  document.head.appendChild(holder)
}
```

两个问题叠加：
1. 幂等判据只看元素在不在。一旦元素在、但里面的样式表没建起来，**后续每次调用都被短路**，
   样式永远补不回来。
2. `<style>` 塞在 `display:none` 的 div 里，比直接挂 `<style>` 元素更脆弱。

**修法**：判据改成「样式表真的有规则」（`sheet.cssRules.length > 0`），
直接 append 真正的 `<style>` 元素，并在 `open()` 里每次打开前再自愈一次。

**脚本**：`node tools/patch-skillsmgmt.mjs` → 写入 `tools/patched/`

## 补丁 2：picker 显示 curator 的中文分析

**需求**：让「+ 技能」列表显示 dsh-curator 分析出的中文说明，而不是 `SKILL.md` 里的英文原文。

**修法**：
1. 新增 `fetchCuratorAnalyses(rows)`：把 `[{name, description}]` POST 给
   `/api/dsh-curator/lookup`，拿回中文分析挂到行上（失败静默，退回原文）。
2. `fetchSkillCandidates` 的 rows 映射后附上 `analysis` 字段。
3. `SkillPicker` 渲染 `.sk-picker-desc` 时优先用 `row.analysis.summary`。

**脚本**：`node tools/patch-picker-chinese.mjs` → 写入 `tools/patched2/`

## 依赖的 curator 侧改动

补丁 2 依赖 `dsh-curator` 的两个新能力（都在 `lib/index.js`）：

- `POST /api/dsh-curator/lookup` —— 只读查询端点
- `AnalysisCache.getEither(description, fullText)` —— 两个缓存键都试

**键的坑**（实测）：写入侧 `/analyze` 用 `fullText || description` 当键，读取侧历史上只按
`description` 查。带全文提交的分析全部落在 `sha1(fullText)` 上，按 description 查必然 miss。
本机 22 条技能里旧逻辑只命中 8 条。

## 皮肤层：「+ 技能」浮层的外观（不碰它的源码）

**目标**：把那个浮层做成舒展的**单列两行**排版 —— 上标题（加粗、主色）、
下描述（次要色、单行省略），选中行浅底高亮。去掉了左侧字母方块。

**做法**（全在 `dsh-curator/lib/client.js`，不需要写它的目录）：

| 手段 | 作用 |
|---|---|
| CSS 覆盖 `.sk-picker-*` | 排版（`display:block` 单列两行）、间距、字号/字重/配色、圆角、hover 与选中态 |
| `MutationObserver`（盯 `document.body` 子树） | 给 `.sk-picker` 容器加 `data-ss-skin` 标记属性，作为上面那套 CSS 的作用域 |

为什么需要 JS 那一行：这个浮层是别的插件的 DOM 且 portal 到 `document.body`，
没有稳定父级可挂皮肤；加一个自己的标记属性最轻。**只写属性、不增删节点** ——
插节点会被 React 下一次 diff 抹掉。标记只打在容器上（容器在浮层存活期内稳定），
所以不需要逐行处理，「先出空壳后填内容」也不会漏打。

**修掉「太局促」**：根因是两处过小的间距 —— 列表 `gap` 2px、行内边距 9/11px。
现在 `gap:6px`、行内边距 `11px 13px`、浮层内边距 10px、圆角 16px。

**修掉描述被压成半行**：它原来是 flex 平铺 + `.sk-picker-name{max-width:45%}`，
标题与描述挤在同一行，描述吃不到一半宽度就被截断。改成单列两行后描述能吃到整行。

**关于头像（已移除）**：曾用 30px 字母方块 + `::before{content:attr(data-ss-letter)}`。
但 400px 宽度里它吃掉约 40px（含间距），剩给两行文字只有约 330px，反而更挤；
去掉后文字拿到整行宽度，才有余量做舒展排版。配套的 `data-ss-letter` /
`--ss-av-h` / `hueOf()` 一并删除 —— 现在 Skin 层**不再往行上写任何属性**。

**作用域**：9 条皮肤规则**全部**以 `.sk-picker` 开头且带 `data-ss-skin` 标记，
不会泄漏到别的界面。自查脚本：`tools/verify-picker-skin.mjs`（20 项断言，
含「不增删节点」「不再有头像残留」「间距已放大」）。排版效果预览：
`tools/render-new-layout.py` → `tools/crops/new_layout.png`。

**撤掉皮肤**：删掉 CSS 里那段 `.sk-picker[data-ss-skin]` 规则 + `apply()` 里的
`installPickerSkin(ctx)` 调用即可，没有其它代码依赖它。

## 回滚

```bash
node tools/rollback-skillsmgmt.mjs                    # 回到插件出厂状态（.orig）
node tools/rollback-skillsmgmt.mjs --to-chinese-base   # 只去掉中文分析补丁，保留样式修复
```

插件目录内保留了就地备份：`*.js.orig`（出厂）与 `*.js.before-chinese`（仅样式修复）。
工作区另有 `tools/patched/`、`tools/patched2/` 两份副本。
**皮肤层不在回滚范围内**（它在 curator 里）。

## 上游修复后可弃用

补丁 1 是通用健壮性缺陷，值得给作者提 issue。若上游改了 `ensureStyles` 的注入方式，
两个补丁都可撤掉。皮肤层则可以一直留着 —— 它不依赖补丁，只依赖 `.sk-picker-*` 类名。
