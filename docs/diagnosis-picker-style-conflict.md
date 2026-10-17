# 诊断报告：「+ 技能」浮层样式失效

> 日期：2026-10-14
> 现象：开启 `dsh-curator` 时，`@weibaohui/skills-management` 的「+ 技能」浮层样式完全错乱；关闭 curator 后恢复正常。

---

## 一、结论（先给结论）

**`@weibaohui/skills-management` 的样式表（`.sk-picker*` 等 76 条规则）在 curator 开启时整表失效。**

不是 curator 覆盖了它，而是它自己的样式**没能生效**。curator 只是触发了这个既有的脆弱点。

证据：异常态下 `.sk-picker` 的**全部定位与布局属性都没应用** ——
`position:fixed` 没了（所以浮层掉进文档流、跑到屏幕左下），
`.sk-picker-row` 的 `display:flex` 没了（所以名称与描述黏连、换行）。

---

## 二、直接证据：像素级对照

裁切放大后的同一行（完整图见 `tools/crops/row_compare.png`）：

**正常态**（curator 关闭）：
```
antislop  Anti Slop: Rules for AI Coding Agents. The core filter. Load …
^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
加粗名称   灰色描述，单行，末尾省略号
```
即 `display:flex` + `.sk-picker-name{flex:none;max-width:45%;white-space:nowrap;text-overflow:ellipsis}` 生效。

**异常态**（curator 开启）：
```
        Load always to stop generic AI slop.
antisop-codeCode comment hygiene for AI coding agents:
             ↑ 名称与描述黏连（无 flex 间距）
remove generic AI-slop comments, keep the valuable ones, never
                  touch the code.        ← 居中 + 换行（无 nowrap/ellipsis）
```
名称与描述**没有分列**、**居中**、**换行** —— `display:flex`、`gap:8px`、`max-width:45%`、`white-space:nowrap` 全部未应用。

---

## 三、根因：两插件样式注入方式不同

### skills-management（脆弱）
`client/index.js:44-51`

```js
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('sk-styles')) return  // ① 幂等短路
  const holder = document.createElement('div')
  holder.id = 'sk-styles'
  holder.style.display = 'none'      // ② 藏起来的 div
  holder.innerHTML = STYLE           // ③ STYLE = "<style>…</style>"
  document.head.appendChild(holder)
}
```

三个脆弱点：
1. **幂等判据太弱**：只看 `#sk-styles` 元素在不在。元素在但样式不生效时，它**永远不会重新注入**。
2. **样式装在 `display:none` 的 div 里**（不是直接 append `<style>`）。
3. **调用点只有三处**（`:2165`、`:2300` 的 `useEffect(ensureStyles, [])` 与 `:2179` 的 `__boot`）。`useEffect(…, [])` 只在**组件首次挂载**时跑一次 —— 如果那一刻 `document.head` 的状态或渲染时机不对，之后**没有任何重试**。

### dsh-curator（稳健）
`client.js:1216-1222`

```js
function ensureStyle() {
  if (document.querySelector("style[data-dsh-curator]")) return;
  const el = document.createElement("style");   // ← 真正的 <style> 元素
  el.setAttribute("data-dsh-curator", "");
  el.textContent = CSS;
  document.head.appendChild(el);
}
```

**这是关键的对比**：curator 直接 append 一个真正的 `<style>` 元素，而 skills-management 把 `<style>` 塞进隐藏 div 的 `innerHTML`。后者在宿主重新渲染/移动 head 节点时更容易丢失。

---

## 四、curator 的触发路径（已定位，但最后一环需运行时确认）

### 已确认的事实

| 事实 | 来源 |
|---|---|
| curator 只注册 2 个槽位：`sidebar.panellist` + `main` | `client.js:5565,5592` |
| curator **不碰** composer 输入区 | 槽位审计：0 处 composer 相关 |
| curator 的 289 条 CSS 规则**全部**限定在 `.ss-` 内 | 严格解析 + 全选择器审计 |
| curator 声明 `inject = ['webServer','llm','agentDefaultModel']` | `lib/index.js:47` |
| skills-management 声明 `inject = ['slots','locale']` | `client/index.js:2175` |
| **curator 不在 `dsh.profile.bundles` 里** | profile `package.json`（只有一个 `- id: dsh-curator` insert 行挂载） |

### 推断的触发链

1. curator 的 `webServer` / `llm` / `agentDefaultModel` 是**重量级服务**，它在 `apply()` 里注册 5 个 HTTP 路由并 load 配置、扫描技能目录。
2. 它与 skills-management 在**同一渲染树**、**同一 `document.head`** 上操作。
3. skills-management 的 `useEffect(ensureStyles, [])` 只在首次挂载跑一次；若那一刻 head 正在被 curator 的注入/重排扰动，`innerHTML` 写入的 `<style>` 可能未被解析进样式表，而 `#sk-styles` 元素**已存在** → 永久短路，样式再也不会补上。

**最后这一环我没有运行时证据**，需要 DevTools 数据（见第六节）。

---

## 五、为什么「关闭 curator 就正常」

关闭 curator 后，它的 client bundle 不再加载 → 不再有并发写 `document.head` 的第二个插件 → skills-management 的 `ensureStyles` 在首次挂载时成功落地 → 样式正常。

**注意**：这不是「curator 的样式污染了它」（我前后两次的错判）。curator 的 CSS 作用域是干净的，从不命中 `.sk-*`。真正的问题是**两个插件同时改 `document.head`，而其中一方的注入方式不够健壮**。

---

## 六、待确认的最后一步（需要运行时数据）

在 DevTools Console 跑 `tools/picker-style-diag.js`（只读），重点看三行：

| 检查 | 正常期望 | 若异常则证明 |
|---|---|---|
| `document.getElementById('sk-styles').querySelector('style')` | 有 | **无** → 隐藏 div 里的 `<style>` 没被解析，样式表未建立 |
| 该 `<style>.sheet.cssRules.length` | ≈76 | **0 或 n/a** → 样式表为空 |
| `.sk-picker` 的 `getComputedStyle().position` | `fixed` | 非 `fixed` → 定位规则未生效（与截图一致） |

---

## 七、可选修复方向（尚未实施）

**方案 A — 修 skills-management（推荐，治本）**

把它的注入改成直接 append `<style>` 元素，并把幂等判据从「元素存在」改成「样式表真的存在且有规则」：

```js
function ensureStyles() {
  if (typeof document === 'undefined') return
  let el = document.getElementById('sk-styles')
  // 已存在且样式表可用 → 不重复注入
  if (el && el.tagName === 'STYLE' && el.sheet && el.sheet.cssRules && el.sheet.cssRules.length > 0) return
  if (el) el.remove()
  el = document.createElement('style')
  el.id = 'sk-styles'
  el.textContent = STYLE_CSS          // 纯 CSS，去掉 <style> 包裹
  document.head.appendChild(el)
}
```

同时把调用点从「仅首次挂载」改为「每次打开 picker 前都确保」。

**方案 B — 只改 curator（回避）**

让 curator 不与它争 `document.head`：延迟注入自己的样式（等宿主稳定后），或改为按需注入。

**代价**：治标不治本，其它插件仍可能触发同样问题。

**方案 C — 报告上游**

这是 skills-management 的健壮性缺陷，值得给作者提 issue（附本报告）。

---

## 八、本次排查中我纠正的两个错误判断

| 轮次 | 我的错误结论 | 实际情况 |
|---|---|---|
| 1 | 「curator 注入的 CSS 漏到了宿主身上」 | ❌ 错。289 条规则全部 `.ss-` 限定，0 条裸选择器 |
| 2 | 「浮层宽度被压到 250px 导致换行」 | ❌ 错。宽度本身正常，问题是**整张样式表失效** |

教训记录在案：在断言「某插件的 CSS 污染了别的插件」之前，必须先做**严格解析 + 全选择器审计**（裸元素选择器、裸类、`!important`、改宿主 token），而不是凭第一眼印象。
