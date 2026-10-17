# Changelog

## Unreleased

### 修：点「更新」全部报 already-installed（官方 installBundle 拒绝覆盖已装包）

用户实测：5 个可更新插件点哪个都失败，提示条只显示英文 `already-installed`。

- **复现**：`POST /api/dsh-curator/plugins/install {name, version}` → `500 {"error":"already-installed"}`。
- **根因（读 app.asar 源码坐实）**：`dsh-plugin-manager` 的 `installBundle` 里有一道前置拦截 ——
  `if (ownerContext.get("hmr") !== void 0 && known !== void 0 && Object.hasOwn(before, known))`
  就 `throw new ManagementFailure("already-installed")`。**它不看目标版本**：
  只要 profile dependencies 里已有这个包就拒绝。官方的产品语义是「社区插件升级请先卸载再装」，
  所以官方服务根本没有第三方插件的升级路径。
  此前「官方通道接受 name@version」的验证只覆盖了 `parseInstallSpec`，没覆盖 `installBundle` 的前置检查 ——
  这是这次漏掉的根因。
- **修法（分流）**：已装 + 给了目标版本 + 非本地目录 = 升级 → 走 `dsh CLI`（`dsh plugin add name@version`，
  失败退 `pnpm add`），这是历史上真机验证过的通道；装新包仍优先官方 `installBundle`（热应用 + 回滚）。
  升级结果标 `restart-required`（模块解析图变了，下次启动生效）。
- **错误中文化**：`already-installed` 与 DSH 的 peer 兼容性拒装（`incompatible with dsh ... allow-version`）
  都翻成人话；兼容性那条直接给出精确版本例外的命令，但 **curator 不替你自动接受风险**。
- **真机验证**：`dsh plugin --profile desktop add dsh-context@0.73.0`
  → 磁盘 0.72.0 → 0.73.0、profile spec `0.72.0 → 0.73.0`。
- **测试**：新增 `tools/test-update-channel.mjs` 13 项（分流真值表 + 错误映射 + 源码依据），
  全量 19 套回归 0 失败。
- **注意**：DSH 运行时已升到 `0.2.1-rc.2`。`dsh-workbuddy-connect` 0.7.x 把 peer 钉成精确版本
  （0.7.6 钉 `0.2.0-rc.2`、0.7.7 钉 `0.2.1-rc.1`），所以它在 rc.2 上会被启动校验拒载；
  更新到 0.7.7 仍需显式 exact-version 例外（命令见错误提示），这是发布方 pin 版本导致的，不是更新通道的问题。

### 改：多窗口比例适配 —— 最大化窗口不再单边留白

用户截图：2560 宽的最大化窗口下，详情页内容只有 880px 且**贴左边**，右侧空出 1400px，
看起来像页面没加载完。根因不是缺 max-width，而是「只给了 max-width 没居中 + 没有宽屏布局」。

- **新增 `xwide` 档（面板宽 ≥1500px）**：原来的分档止于 `wide`（≥980），
  2560 屏幕的主区有 2300+，全部落在同一档里，宽屏无从适配。
- **所有页签内容统一 1120px 居中**：规则写成 `.ss-body > *:where(...)` 而不是逐个点类名 ——
  技能页把「分区标题 + 列表」包在 `.ss-group` 里，只给 `.ss-list` 加 max-width 会漏掉整块
  （实测 2300px 下技能页仍贴左边）。fixed 定位的弹窗/抽屉/浮层遮罩排除在外。
  设置页表单收窄到 1040。
- **一级页签、二级分段跟随内容栏居中**：否则 2300px 下导航贴左、内容居中，像两块拼起来的页面。
- **详情页头部改三列**（头像 / 身份 / 操作）：操作不再单独占一行 ——
  那一行在最大化窗口会横跨 2000px，开关和卸载各贴一端、中间全是空的。
  `mid/narrow/xs` 自动回退成两列，操作条落到身份区下方。
- **详情页 xwide 变两列**：正文（AI 说明 / 配置）+ 360px 信息侧栏（信息事实表 + 说明文档），
  侧栏 `position:sticky` 吸附。单列时顺序仍是「AI 说明 → 信息 → 说明文档」。
- **验证**：预览流水线扩到 12 个状态（2300 / 1600 / 1150 / 570 宽 + 深色），
  逐张截图核对；新增 `tools/test-responsive-layout.mjs` 18 项锁住分档、居中规则、
  两列布局与窄屏回退。17 套回归全绿，gate 14/14，对比度 48/48。

### 改：布局与视觉 V2 —— 向官方插件页的排版规矩看齐

用户要求「顺便优化布局和 ui 设计」。这一轮不是换配色，是把**结构**重排：
先读了 app.asar 里官方插件页的 CSS（`dsh-client-ui-plugin-manager`，23KB）当量尺，
再按它把整个面板的标题层级、行结构、控件高度、分区节奏统一。

- **导航层级定死**：一级页签改**下划线式**（原来和二级分段、分类筛选共用三种"药丸"，
  同屏分不清哪个是换页）；二级分区用浅选中分段；筛选条件用实心 chip。
- **一屏一个实心主操作**：插件页原来「AI 分析」和「全部更新」两个实心蓝按钮并排，
  等于没有 primary。现在主操作固定为「全部更新」，分析降为描边按钮，工具栏动作收进
  右侧一组（`.ss-toolbar-end`），搜索/分类留在左边。
- **列表 = 一个容器 + 发丝分隔线**：原来 14 行插件 = 14 张带描边和阴影的卡；
  现在收进一个圆角容器，行与行只有一条线，hover 只换底色。行内信息压成
  名称行 / 元信息行（来源 · 分类 · AI）/ 单行描述，右侧只留「更新 / 启停 / 详情」。
  **卸载挪进详情页**——破坏性操作不该每次都挨着开关。
- **卡片去投影**：`.ss-card` 只留一层描边，hover 换描边色；`backdrop-filter` 全插件
  只剩抽屉遮罩 1 处（原来是 2 处）。
- **控件统一 32px 高**：输入框/下拉/按钮同一高度；`:focus-visible` 从"只有弹窗有"
  推广到所有按钮、下拉、折叠行。
- **详情页**：标题 20/28（对齐官方页）、正文 14/22、正文宽 ≤74ch；
  新增「信息」事实表（安装标识 / 安装目录 / 分类 / 文档体量），把右侧一大片空白填掉；
  **作者没注册配置页时不再显示空的「配置」标题**（新增 `useSlotPresence` 订阅槽位变更）；
  README 折叠行改成整行可点 + 右侧箭头。
- **原生槽位归位**：`plugins.detail.badge` 移到标题旁、`plugins.detail.actions` 移到操作条里
  （官方就是这么放的），「配置」区只留 `plugins.bundle.config`。顺带修掉一个隐患：
  badge/actions 是 list 槽位，宿主无法静态判断"当前插件有没有内容"，之前把它们也算进
  「配置区是否存在」的判断，会让任何插件注册了就每页都冒出空配置区。
- **来源/分类/AI 状态去胶囊**：只保留纯文字元信息；胶囊只给"要处理"的状态
  （可更新 / 被配置覆盖 / 已停用）。一屏 14 行 × 4 个描边小方块，噪声大于信息量。
- **底色改 `bg-overlay` 派生**：皮肤把 `bg-base` 设成 transparent、`layer-1` 只有 72%
  alpha，浅色主题配深色壁纸时面板会被拉灰，灰字对比度实测只有 3.3。
  改为 `--ss-surface = bg-overlay 94% + layer-3`（两套主题都 96%+ 不透明）。
- **验证**：`tools/curator-contrast-audit.mjs` 重写为 48 组（浅/深 × 白/黑壁纸 ×
  面板底/卡片底 × 正文/次要/三级/状态色），**48 通过 0 失败**；
  `curator-gate-v2.mjs` 13/13；新增真渲染截图流水线（见 DESIGN.md）。
- **测试**：`test-plugin-detail-page` 17/17、`test-native-fusion` 45/45、
  `test-no-dead-code` 6/6、`test-toggle-state` 26/26、`test-uninstall-flow` 19/19、
  `test-feedback-quality` 33/33、`test-local-install` 13/13（新增）。

### 修：本地目录安装被后端 spec 白名单拒绝（设置页文案长期与实现对不上）

- **现象（实测复现）**：设置页「按包名安装」占位符写着「本地绝对路径」，
  但后端 `MARKET_SPEC_RE` 不允许反斜杠，POST `C:\...\demo-plugin` 直接 400
  「非法 spec（只允许 npm 包名/带版本、github:owner/repo）」。
- **修法**：新增 `LOCAL_PATH_RE`（盘符 / UNC / POSIX 绝对路径），本地路径单独校验
  `existsSync + isDirectory`，然后转成 `link:<绝对路径>` 走同一条安装通道；
  目录不存在当场 400，不进入安装步骤。非本地 spec 仍走原白名单。
- **测试**：`tools/test-local-install.mjs` 13 项（源码分支 + 真实正则行为表）。

### 改：运行状态徽标合并为一次查询

- **原来**：每个 `PluginRunningBadge` 各自 `listBundles()` + `listPlugins()`——
  14 个插件 = 28 次宿主 IPC，而且每次列表重渲染都重打一遍。
- **现在**：模块级 `loadPhases()` 缓存 + in-flight 去重 + 5 秒 TTL；
  启停/卸载/更新后主动 `invalidatePhases()`。相位语义不变（entryId → fiberPhase），
  只是改成按 entryId 建索引查，不再每行 `find()`。
- **测试**：`test-native-fusion` 的关联方式断言同步更新。

### 清：过期文档、测试与临时文件

- **删除** `tools/test-plugin-config-ui.mjs`、`tools/test-plugin-config-e2e.mjs`、
  `tools/curator-status-contrast.mjs`：前两个测的是已被用户要求整体删除的
  「通用配置编辑器」，最后一个的职能已并入 48 组对比度审计。
- **CHANGELOG 历史条目纠偏**：下面「新：通用插件配置查看/编辑」记录的功能
  **已在 10-17 重构中整体移除**（只渲染作者注册的原生组件），保留原文但加注，
  避免以后有人照着它找代码。
- 旧 `preview-plugin-detail.html` 单页预览被 `dsh-frontend-env/make-previews.mjs`
  （8 个状态）取代。

### 改：插件详情改为独立二级页面（取消抽屉与行内展开）

用户要求：「取消这种抽屉的设计做一个 UI 简约大方的二级页面」。

- **形态**：列表 → 点「详情」→ 整块切到详情页（`openId` 单值 state）→ 「‹ 返回插件列表」
  或 ESC 返回。和原生插件页同构，但排版更透气：一屏只讲一个插件，没有遮罩、
  没有 flex 挤压、不需要滚两层。
- **详情页结构**（自上而下）：返回面包屑 → 头部（图标 / 名称 / 版本 / 运行状态徽标 /
  来源与分类 chips / 一句话描述）→ 操作条（启停开关、更新、AI 分析、卸载）→
  内容区（AI 说明 → 配置 → 更多详情 README 折叠）。
- **配置区不变**：只渲染作者注册的原生组件（`plugins.bundle.config` 等），与官方页一致。
- **修复**：`Toast` 渲染点恢复为唯一（顶层 Panel），详情页分支不再重复渲染
  （否则两条提示会重叠 —— 这是此前修过的问题，重构时又踩了一次）。
- **清理**：行内展开的 `.ss-expand` / `.ss-item-open` CSS、`expandOpen` /
  `expandCollapse` 文案、`PluginExpandBody` 组件全部移除。

### 新：原生融合区 —— 插件自己的配置页/操作按钮/徽章 + 运行状态

需求：**原生插件页的所有能力（含插件作者自绘的二级页面）全部融合进 curator，
新装插件零二次开发。**

- **机制突破（用户点破）**：插件的二级页面不是官方页私有的 —— 插件作者把 React
  组件注册进**全宿主共享的槽位表**（`ctx.slots`，`@deepseek-ai/dsh-client-ui-slots`
  的 SlotCore），官方插件页只是去读这张表的展示入口之一。curator 同样持有
  `ctx.slots`（inject 名单加 `remote.pluginManager`），用与官方页**相同的调用约定**
  读同一张表，就能渲染出与原生页一致的内容。**作者注册了什么，curator 就显示什么。**
- **对齐的官方约定**（逐一读 app.asar 核实）：
  - `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` — 配置页
  - `renderSlot("plugins.detail.actions", { subject })` — 「打开 IM 机器人」类按钮
  - `renderSlot("plugins.detail.badge", { subject })` — 状态徽章
  - entry 结构 `{ component, options: { key/id/order/priority/label } }`；
    读侧用 `entriesOfSlot`（keyed 选举胜者，官方渲染同款语义），keyed 过滤用
    `entry.options.key`。
- **运行状态**：与官方同数据源同语义 ——
  `remote.pluginManager.listBundles()` 的 `rows[].entryId` 关联
  `listPlugins()` 的 `enabled`/`fiberPhase`（官方 packageView 同款关联）。
  相位映射：active 运行中 / loading 加载中 / failed 异常 / unloading 卸载中 /
  pending 等待依赖 / 其余已关闭。
- **详情抽屉新布局**：AI 说明 → **状态与原生界面**（状态行 + 徽章 + 操作按钮 +
  配置页，原生组件优先）→ 通用配置（cordis.patch.yml 单键编辑，兜底无表单插件）。
- **容错**：插件组件渲染 try/catch 单条隔离（一个插件的组件抛错不拖垮抽屉）；
  槽位空返回 null；宿主服务不可用静默降级（不显示假状态）。
- **通用性**：无任何逐插件代码 —— workbuddy 的账号面板、IM 的启动按钮、
  dsh-context 的下拉组，凡注册进槽位表的都会自动出现；以后新装插件同样自动。
- **测试**：`test-native-fusion.mjs` 24 项（机制对齐/读侧语义/容错/文案对齐）。
  全量 23 套件 0 失败。

### 新：通用插件配置查看/编辑（详情抽屉「配置」区）— **已被移除，见上方「清」**

> 注（2026-10-17）：用户后续要求「配置区只渲染作者注册的原生组件，与官方页一致」，
> 通用配置编辑器（`PluginConfigSection` / `GET|POST /plugins/config` / YAML 写回 /
> 相关文案与 CSS）已**整体删除**。本条保留只为解释当时的决策过程，不要照它找代码。

需求：**在 curator 里能看/能改任何插件的配置，以后装新插件不用再开发。**

- **为什么这条路是通用的**：取证发现各插件的配置最终都落在
  `cordis.patch.yml` 的 `- name: 包名 / config: {...}` 段 —— 这是 DSH 的
  **官方统一配置层**（宿主自己的 agent-default-model、settings-account 也存这）。
  按包名抽这一段展示+编辑，对新装插件自动成立。
  对照：插件作者自绘的二级配置 UI（workbuddy 的账号面板、dsh-context 的几十个下拉）
  是插件自己 client.js 里的 React 组件，**无法被第三方渲染** —— 这是架构边界，
  不是没做。所以本功能与原生二级页互补而非替代。
- **后端**：`GET/POST /api/dsh-curator/plugins/config`（同路径，handler 内分支，
  与全部既有路由 path 唯一的约定一致）。
  - 读：按 name 抽 config 段 + `available/hasConfig/disabled/rowId`；
    没段的插件（如 dsh-read-url）返回中文原因，不出假编辑器。
  - 写（单键写回，五道安全线）：YAML 库不可用拒写(503) → 现文件解析失败拒写(409，
    防止把手工弄坏的文件再覆盖一层) → 值没变不落盘 → 写回后**内存里再解析自检**
    （文件完好且值真的变了才继续）→ `backupProfileFiles()` 后落盘。
  - **YAML 解析**：用 `YAML.parseDocument` 文档 API —— 实测改一个键后
    头注释、其它段（wallpaper-engine/agent-default-model/hmr）逐字保留，
    改回后文本与最初**逐字节一致**（幂等）。
  - **yaml 模块加载**：curator 真实目录向上没有 node_modules（link: 安装），
    `import 'yaml'` 实测 MODULE_NOT_FOUND；改为运行时按候选路径探测
    （profile node_modules 的 yaml 2.9.1 实测可加载）。
- **前端**：`PluginConfigSection` 挂进已装插件详情抽屉。
  - config 树**拍平成点路径**逐键一行（布尔→开关；数字/字符串→输入框；
    对象/数组→JSON 文本域），改哪条存哪条（后端就是单键写回，逐键提交最贴合）；
  - 未修改不显示保存按钮；JSON 解析失败中文提示；保存中禁用；
  - zh/en 文案 10 键对齐。
- **测试**：`test-plugin-config-e2e.mjs`（12 项，真文件真 yaml，含幂等还原与坏文件拒写）+
  `test-plugin-config-ui.mjs`（13 项）。全量 22 套件 0 失败。
- **回收**：中途会错过一次需求（把「说明页」做成了给 curator 自己挂
  `plugins.bundle.config` 槽位），已完整回收（组件/注册/文案/CSS 四处，
  残留引用 0，`node --check` 通过）。

### 修：卸载流程（第一次静默失败 / 第二次 not-removable / UI 两条提示重叠）
用户实测：点卸载「第一次没报错，但列表里还在」，再点一次 → 报 `not-removable`，且 UI 错乱。
三个独立缺陷叠加，逐个定位：

- **① 第一次"成功"是假的**：`listDshPlugins()` 是扫 **node_modules 目录**得到的，
  而 `link:` 类型的自建插件在 `dependencies`/`bundles` 被移除后，
  **node_modules 里的符号链接仍然留着**（pnpm rm 对 link: 依赖常常只改清单、不删链接）。
  于是清单清干净了、目录还在 → 列表照旧显示 → 用户以为没卸掉。
  → 卸载收尾**显式清理残留目录**（含 `node_modules/.pnpm/<name>@...` 虚拟 store），
    并以**磁盘实际存在性**作最终判定：目录还在就返回 500 + `stillInstalled: true`，
    并给出可执行下一步（"关闭 DSH 后手动删除：<路径>"），不再谎报成功。
- **② 第二次的 `not-removable` 是官方语义**（读 app.asar 确认）：
  `removeBundle()` 里 `if (bundle === void 0 || !bundle.removable) throw new ManagementFailure("not-removable")`，
  而 `removable = installed && !Object.hasOwn(installation.dependencies, name)` ——
  `installation` 是 **DSH 安装自身**的 package.json。
  也就是说：**凡在 DSH 自带 dependencies 里的包都是内置包，官方设计上不允许卸载**。
  但 `listBundles()` 的名单来自「bundles ∪ profile deps ∪ **安装自带的 deps**」，
  内置包同样会出现在列表里 → 用户以为点得动、实际卸不了。
- **③ 界面直接显示英文枚举 `not-removable`**：`officialError()` 之前只取
  `diagnostic ?? message ?? code`，而这个错误**只有 code、没有 diagnostic**，
  于是把裸枚举值丢给用户。
  → 加中文映射表，把 `not-removable` / `management-required` / `not-bundle` /
    `unknown-plugin` / `unaddressable` / `incompatible-version` 等 12 个 code
    翻成人话（有 diagnostic 时仍优先用 diagnostic）。
- **④ UI 两条提示重叠**：把 toast 改成全局共享（`useToast` 单一来源）之后，
  **顶层 Panel 与各子页签同时在渲染同一个 toast** → 屏幕上出现两条互相盖住的提示，
  看着就是"UI 错乱"。
  → 渲染点从 9 处收敛为**恰好 1 处**（Panel 顶层），子页签不再各自渲染。
    这是全局化时漏掉的一步：共享状态必须只由最近的公共祖先渲染。

回归测试 `tools/test-uninstall-flow.mjs`（19 项）+ `test-feedback-quality.mjs`
新增的「渲染点必须恰好 1 处」断言。

### 修：dshmarket 无法关闭（我加的守卫是错的）
- 现象：点 dshmarket 的开关没有任何反应。
- 根因：`/plugins/toggle` 里有一行守卫
  `if (!enabled && (isSelf || name === 'dshmarket'))` 直接返回 400
  「dshmarket 不能在这里停用」—— **这是我加的，理由不成立**。
- 为什么理由不成立：curator 自带独立的插件市场实现（直连
  `awesome-dsh-plugin.com` 公开目录，不依赖 dshmarket），装/卸走 `dsh CLI`
  与官方 `pluginManager`。dshmarket 停用后本面板功能一个都不少。
- 现在只拦「停用 curator 自己」—— 那是真的自锁死（它就是当前界面，
  停掉后再没有入口开回来），属于硬约束。

### 修：更新失败 —— pnpm 供应链策略拦下新版本（第二层与第三层根因）
现象：点更新弹出**大面积报错乱码**，内容是
`? Verifying lockfile against supply-chain policies (353 entries)...` 一长串。
- **根因 2**：pnpm 11 默认 `minimumReleaseAge = 24h`，**拒装刚发布的版本**；
  而「更新的目标版本」恰恰就是刚发布的那个 —— 所以更新必然撞上
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
  DSH 自带 `dsh plugin add` 会自己往白名单追加（执行时会打印
  「Added 1 entry to minimumReleaseAgeExclude」），curator 走底层通道没做这件事。
  → 新增 `allowReleaseAgeException(name, version)`：更新前把**这一个明确的目标版本**
  加进 `pnpm-workspace.yaml` 的白名单。只放行本次要装的版本，不动全局策略。
- **根因 3（更隐蔽）**：原有白名单**整份失效**，两个原因叠加——
  1. 历史条目用了 `pkg@1.66.11 || 1.66.12` 组合写法（实测：只要含一条这种写法，
     整个检查就失败，连干净条目一起失效）；
  2. **名单过长时 pnpm 整体判定失败**（同样的内容 5 条通过、21 条失败，
     与引号无关）。这是 pnpm 的实现缺陷。
  → 因此改成「**迭代求解最小可用集**」（`tools/fix-exclude-syntax.mjs`）：
     从空名单开始，让 pnpm 自己报出违规项，逐个纳入直到通过。
     本机求得**恰好 5 条**（不是之前的 21 条），且验证
     `✓ Lockfile passes supply-chain policies`。
- 另外修：`allowBuilds` 里留着模板占位符字面量
  `'@google/genai': set this to true or false`（没被替换），
  会让 pnpm 报 `ERR_PNPM_IGNORED_BUILDS` 退出 —— 改成 `true`。

### 修：反馈颠倒 —— 失败铺满界面、成功毫无提示
用户原话：「失败了就大面积的占用ui界面出现一堆报错乱码，成功了就没有任何提示」。
- **根因**：`/plugins/install` 失败时把**整份 pnpm 日志**（实测 1202 字符，
  含几十行 Progress）原样拼进 `error` 字段，前端又原样铺在面板上；
  而成功只有一行和失败长得一样的裸文字，4 秒就没了。
- **后端**：新增 `summarizeToolError()` —— 摘要而不是截断。优先挑出真正说明
  原因的一两行，丢掉进度噪音，并把已知错误翻译成人话 + 下一步
  （供应链策略 / 构建脚本 / 404 / 版本不存在 / 网络 / 网络盘满 / 受保护插件）。
  实测：593 字符的 pnpm 日志 → 127 字符的中文说明，且点出具体包名。
- **前端**：把 9 处 `h("div", {className:"ss-ok"|"ss-err"}, toast.text)`
  统一换成新的 `<Toast>` 组件：
  - 成功/失败长相明确区分（✓/! 图标 + ok/danger 语义色 + 左边线），
    **成功不再"没提示"**；
  - **长错误不再撑爆界面**：默认最多约 3 行、超出给「展开详情」，
    展开后内部滚动；
  - `role=status` + `aria-live=polite`，读屏能播报操作结果；
  - 失败提示不自动消失（要看原因），但给了关闭按钮。
- **还有一个藏得更深的点（"更新后 UI 变了却没提示"的真因）**：
  提示条原本只是普通块级元素，位置在「工具栏之后、列表之前」——
  而插件列表有 15 行，用户操作某一行时早就滚下去了，
  于是提示渲染在**视野上方看不见的地方**。不是没提示，是位置不对。
  → 给 `.ss-toast` 加 `position:sticky; top:0; z-index:5`，滚到哪都贴在容器顶部。
  刻意**不加 backdrop-filter**：本项目 R-10 规定玻璃效果最多 2 处
  （已给 `.ss-drawer-mask` 与 `.ss-savebar`），吸顶条再加就是第 3 处 ——
  这一点是被 antislop 硬门测试当场拦下的，随后改为纯不透明语义底色。

### 修（第二次，第一次没接上线）：更新「提示成功但版本没变」
- **第一次修复失败的原因（必须记下来）**：上一版新增了 `updateBundleTo()`、
  写了注释、写了测试，**却从没在 handler 里调用它** ——
  handler 里仍是 `const spec = rawSpec`，前端送来的 `version` 被整个丢掉。
- **为什么测试没抓到**：`test-update-version.mjs` 用的是**假后端**
  （可编程 mock），而 mock "实现"了这处修复（收到 version 就改版本号）。
  于是测试验证的是 mock 行为，不是真实代码 —— 全绿，却毫无意义。
  **教训：当修复点正好在你要 mock 的那一侧时，mock 会替你"实现"修复。
  凡涉及改真实产物的修复（装包、写文件、改配置），必须有一次真后端/真产物验证。**
- **本次真正修好**：`const spec = (expectedName && targetVersion)
  ? (expectedName + '@' + targetVersion) : rawSpec`
- **实测证据**（真 CLI、真磁盘）：
  - `dsh plugin --profile desktop add dsh-opencode-go@0.1.24`
    → 磁盘 `0.1.23 → 0.1.24`、spec `^0.1.23 → ^0.1.24` ✓
  - 早前 `dsh-better-sidebar@0.26.1` → `0.26.0 → 0.26.1`、`hasUpdate → false` ✓
- **同时确认官方通道接受带版本 spec**（读 app.asar 源码）：
  `parseInstallSpec()` 用 `spec.indexOf("@", 1)` 切出 `name` 与 `range`，
  返回 `{kind:"registry", name, range}`；安装命令把 spec 作位置参数原样透传
  给 `pnpm add`。所以 `name@version` 在官方 `installBundle` 路径上有效。
- **清理同类死代码**：删掉 `updateBundleTo()`，以及另外两个"写了包装、从未接线"的
  同款死函数 `officialSetPluginEnabled()` / `officialListPlugins()`。
  它们正是让我误以为「非 bundle 插件启停」已经通了的原因。
  现状诚实记录：开关走 `setBundleEnabled`，只对 bundle 型插件有效
  （本机 15 个全是 bundle 型，够用）。
- **新增防复发检查** `tools/test-no-dead-code.mjs`：
  扫描「定义了却引用次数 ≤ 1」的内部函数（当前 109 个具名函数全部有调用点），
  并定点断言「handler 里把版本拼进 spec」「传给 installBundle 的是拼好的 spec」
  「装完必须回读核对」「没动版本就返回 409」。

### 修：更新「提示成功但版本没变」——这是「更新没用」的真正根因
- **现象**：点「更新 → vX」，弹确认、提示「已安装」，看起来成功了，
  但**版本号、磁盘、`hasUpdate` 全都没变**。用户自然认为更新功能是坏的。
- **根因（真实调用坐实）**：profile 里存的是 caret 范围
  （`"dsh-better-sidebar": "^0.26.0"`），`pnpm-lock.yaml` 里锁成
  `specifier: ^0.26.0 / version: 0.26.0`。此时执行
  `pnpm add dsh-better-sidebar`（**不带版本号**），pnpm 判定
  「`^0.26.0` 已被 `0.26.0` 满足」→ **什么都不装** → 却照样返回成功。
  实测：接口 200、耗时 3.6s、`hint: "已安装"`，而磁盘版本仍是 0.26.0。
- **修法**：更新必须显式带上目标版本。
  1. 前端 `doUpdate(name, spec, silent, version)`，请求体带
     `version: latest`；三个调用点（列表、卡片、全部更新）都传。
  2. 后端 `/plugins/install` 接收 `version`，新增
     `updateBundleTo(name, latest)` 显式拼 `name@latest`。
  3. **装完必须回读核对**：比对 `beforeVersion` / `afterVersion`，
     没变就返回 **409 + `moved:false` + 明确原因与手动命令**，
     不再谎报成功；前端据此显示失败而不是「已安装」。
- **实测验证**：
  `dsh plugin --profile desktop add dsh-better-sidebar@0.26.1`
  → 磁盘 `0.26.0 → 0.26.1`、profile spec `^0.26.0 → ^0.26.1`、
  `hasUpdate → false`、`updatesCount 5 → 4`。
- 教训：任何「安装/更新」都不能只看子进程退出码或官方返回的
  `application` —— 必须回读实际产物证明真的生效。

### 搭建真前端调试环境（此前只会读源码做正则断言）
- 位置 `dsh-frontend-env/`：jsdom + react 18 + react-dom 18，
  `harness.mjs` 用 `node:vm` 跑**真实的** `client.js`，
  补 `window.__ModuleLoader__` 桩拿到 `{apply, inject}`，再真渲染面板。
- 支持 `REAL_FETCH=1` 直连真 DSH，做「真 UI + 真后端」端到端。
- 这套环境**立刻抓到两个真 bug**（下面两条），是这轮唯一有效的手段。
- 本机浏览器（Edge/Chrome + playwright-core）不可用：`spawn EPERM`
  （沙箱禁止 Node 经命名管道与浏览器通信），jsdom 是唯一可行途径。

### 修：UI 反馈烂透的两个直接原因
- **失败原因被前端丢掉**：`sendJson`/`getJson` 里写的是
  `throw new Error("HTTP " + res.status)`，于是后端精心写的
  「插件不存在或已卸载: xxx」「版本没有变化…」全被扔掉，
  用户只看得到一个无信息量的「HTTP 400」。
  新增 `failureText(res)` 解析 `{error|message}`，解析不出才退回状态码。
  （顺带修掉一处死代码：`else setToast(...r.error)` 因为已经 throw 而永远走不到。）
- **提示条是每个页签各自的 state**：在插件页操作完、切到别的页签，
  提示就没了（实测确认），而且失败信息永远不会自动消失。
  新增全局 `useToast()`（模块级单一来源 + 订阅），9 处状态声明统一替换；
  成功提示 4 秒后自动消失，失败提示保留让用户看清原因。
- 两个 bug 都有真前端回归测试：`test-error-visibility.mjs`、
  `test-update-version.mjs`。

### 修：开关「点了没反应」——状态判定漏了补丁层（本次最关键的 bug）
- **现象**：点插件的启用/停用开关，弹了确认框、也提示了，但界面状态和插件行为都不变，
  于是「不知道到底成没成功」。本机 `dsh-plugin-wallpaper-engine` 就是活样本。
- **根因（读真实文件核对）**：DSH 的组合顺序是「各 bundle 层 → `cordis.patch.yml` →
  命令行 overlay」，**补丁层在 bundle 层之后应用、优先级更高**。而
  `dsh-plugin-wallpaper-engine` 自己 insert 的行 id 是 `wallpaper-engine`
  （注意：**行 id ≠ 包名**），用户补丁层里留着一条
  `- id: wallpaper-engine / disabled: true`。
  于是实际状态是：
  - `package.json` 的 `bundles` **有**它（说明那次点开关其实写盘成功了）
  - `cordis.patch.yml` 里 `disabled: true` 把它按着（实际不加载）

  旧代码只读 `bundles` 判 `enabled` → 显示「已启用」，与实际相反。
  这不是「写失败」，而是**判定读错了层**，所以怎么点都不会变。
- **同一个盲区也在原生实现里**（读 app.asar 核对）：
  - `selectBundle()` 只写 `package.json` 的 `bundles`，**不碰补丁层**；
  - `listBundles()` 的 `const enabled = selected.includes(name)` 同样只看 `bundles`；
  - 只有 `setPluginEnabled()` 走 `writePluginEnabled(patchPath, …)` 写补丁层、
    并且会回报 `overridden` —— 但它只对**非 bundle 型**插件生效。
  本机 15 个插件全是 bundle 型，所以原生那个开关同样有这个问题。
  curator 现在对 bundle 型也做补丁层对账，比原生更完整。
- **修法**：
  1. 新增 `readPatchDisabled()`：读补丁层**顶层**的 `disabled`（只认顶格 `- id:` 块里
     缩进恰好两格的，避免把 `config` 里同名的业务字段当成停用标志）。
  2. 新增 `effectivePluginState(name, pkgDir, bundles, patchDisabled)`：
     实际生效 = 在 bundles 里 **且** 未被补丁层停用。补丁行 id 与包名不一致，
     所以两边的 id 都拿来比对（包名 + 该包自己 `cordis.patch.yml` 里 insert 的行 id）。
  3. `/plugins` 与 `/market/status` 两个端点都改用它，并在响应里带上
     `inBundles` / `disabledByPatch`，两处状态不会再出现分歧。
  4. `toggle` 现在会**对账补丁层**：目标状态写在哪层，就把另一层也掰到一致
     （启用时把 `disabled` 显式写 `false` 而不是删行，保留痕迹且不猜是谁写的）。
  5. `toggle` 不再回报请求值，而是**回头读一遍实际状态**回报，
     并给出 `overridden: true`；前端据此提示「已保存，但被更高优先级的配置覆盖，
     当前未生效」而不是假的成功。
- **界面**：新增「被配置覆盖」标记（列表与卡片视图都有），
  专治「开关显示开、插件却不工作」这种最迷惑人的状态 —— 直接把矛盾摆出来。
- 回归测试 `tools/test-toggle-state.mjs`（23 项）：从 `index.js` 抠出真实函数，
  用**真实补丁文件**验证；含「旧实现必错报 true」的对照断言、
  「包名与行 id 不一致也要能对上」、「写 false 能解除覆盖」、
  「enable 之后 effective 状态必须翻过来」，以及「嵌套 config.disabled 不得误读」。

### 修：更新装完了列表不刷新
- `doUpdate()` 成功后只调了 `loadStatus()`（管「还有没有更新」），
  **没有调 `load()`**（管「版本号显示多少」）。结果装完了列表里还写着旧版本号，
  用户看不出成没成功。
- 现在两个都刷，并且走 `loadStatus(true)` 强制重查 npm 版本、绕过 10 分钟缓存。
- 「全部更新」改为整批跑完统一刷一次（中途每装一个就刷会打断进度显示）。

### 「已安装」列表：自动检测更新 + 就地更新（数据源改用 npm）
- **修：更新检测的数据源不可靠**。原来拿第三方目录 `awesome-dsh-plugin.com`
  里的版本当「最新版」，而那份目录是别人定时从 npm 抄的，会滞后。
  本机实测 13 个 npm 包中有 3 个不一致，其中 **`dsh-better-sidebar` 目录里仍停在
  已装版本 0.26.0（npm 实际已是 0.26.1）** —— 这种「目录版本 == 已装版本」的情况，
  无论版本比较怎么写都会漏报。
- **改**：新增 `fetchNpmLatest()`，直接问 `registry.npmjs.org` 的 `dist-tags.latest`
  作为权威版本；目录只用来补描述与 spec。为省流量与时间：请求精简元数据
  （`application/vnd.npm.install-v1+json`，不拉整份版本历史）、并发 6、单包 8 秒超时、
  内存 + 磁盘双层缓存 10 分钟、**任何单包失败都不影响其余**（退回目录版本并标记来源）。
- **自建插件（`link:`）不查 npm**：版本由本地决定，没有「远端最新版」这个概念。
- **同一轮里自查出的两个缓存缺陷**（写完初版、复查时发现，已修并加测试）：
  1. **过期缓存永不刷新**：待查集合按「map 里没有的名字」算，可过期缓存里每个名字都"有"，
     于是待查集合为空 —— 函数把过期数据**原地盖上新时间戳**就返回了。
     后果是 npm 发了新版也永远看不出，`?refresh=1` 同样无效。
     改成：新鲜但缺名字才只补缺的，**过期或 force 就全部重查**。
  2. **并发重复打网络**：面板重载与「刷新」几乎同时触发时会各打一轮（实测并发两次 = 两倍请求）。
     加 in-flight 去重；只对非 force 去重 —— 用户明确点刷新就该真去查。
- 效果（本机实测）：可更新数 **4 → 5**，多出的正是目录漏报的 `dsh-better-sidebar`；
  另有 `dshmarket 1.66.12→1.66.28`、`dsh-workbuddy-connect 0.7.1→0.7.6` 从「晚报」变「准时报」。
- **可视化操作补齐**（在这之前更新按钮藏在右侧按钮堆里，不易发现）：
  - 列表与卡片**两个视图的信息区**都加「可更新 → vX.Y.Z」标记，用 warn 语义色
    （它是一件待办，和「网络安装」这类中性归属信息不是一回事），并显示目标版本号。
  - 工具栏在真有可更新项时出现「**只看可更新 (n)**」筛选，一键把列表收敛到待办项；
    没有可更新项时不给这个按钮，避免多一个永远筛不出东西的开关。
  - 「全部更新 (n)」带逐个执行的进度（`n/total`）与运行中禁用。
  - 每条都有「更新 → vX.Y.Z」就地按钮；确认弹窗 + 完成后重新拉取状态，
    按钮随之消失。
- 回归测试：`tools/test-npm-latest.mjs`（21 项，真打 npm registry，含
  「旧写法必漏 dsh-better-sidebar」这条关键回归）+
  `tools/test-npm-cache.mjs`（18 项，用假 fetch + 可控时钟把缓存的
  「新鲜 / 补缺 / 过期 / force / 磁盘 / 单包失败 / 并发」七档语义钉死）+
  `tools/verify-update-ui.mjs`（17 项，断言两个视图都有标记、筛选真的接进
  `visible`、按钮传的是不带版本的 spec）。

### 修：主题皮肤把边框/阴影画到了不该画的地方
- **现象**：开着 maid-atelier（鲸鱼娘）皮肤时，「+ 技能」浮层边缘出现一道**金色描边**，
  底下拖一片很重的投影，和周围界面明显不是一个语言。
- **根因（已用级联计算 + 像素实测确认）**：这个浮层自带 `role="dialog"`
  （上游 `@weibaohui/skills-management` 在渲染时就写死了这个 role），
  而 maid 皮肤有一条
  `body[data-dsh-maid-atelier] :is(dialog,[role=dialog],[role=alertdialog],[role=menu],…)`
  的规则，会给「对话框/菜单」统一刷 `border-color:#c5a46885` + `box-shadow:var(--maid-shadow)`。
  它靠 `:is()` 拿到 `(0,2,1)`（暗色版 `(0,3,1)`）特异度，
  而浮层自己的 `.sk-picker` 只有 `(0,1,0)` —— 于是被当成了设置对话框。
  像素验证：`#c5a46885` 叠在面板底色 `#e0e7f6` 上算出 `#d1c4ac`，与截图实测的 `#d2c4ac` 一致。
- **修法（不改第三方皮肤一行代码）**：在皮肤层补一条特异度 `(0,4,0)` 的规则把它按回去，
  恢复 DSH 弹层的通用外观（隐形描边 + `--dsw-shadow-lv3`）。
  选择器里刻意重复写了 `[role=dialog]`：对面靠这个 role 命中我们，我们就用同一个 role 收回来；
  末尾 `:is([role=dialog])` 是为了抬到 `(0,4,0)`，压过**暗色主题**那套 `(0,3,1)` ——
  否则切到暗色主题同一个 bug 会复现。
- **同一个 bug 还打中了本插件自己的两处**：详情抽屉 `.ss-drawer`（横向投影被换成四周均匀投影）
  与确认弹窗 `.ss-modal`（被描上金边）。两者也带 `role="dialog"`/`role="alertdialog"`，
  同样给它们补了 `(0,4,0)` 的夺回规则。这三处以前都没发现，因为关掉皮肤时完全正常。
- 回归测试：`verify-picker-skin.mjs` 新增 8 条断言，逐个计算特异度并断言**高过暗色皮肤**，
  同时禁止把颜色硬编码成金色。以后谁把这几条规则改弱，测试立刻红。

### 「+ 技能」浮层皮肤（只改外观）
- 给那个浮层加了一层皮肤：**单列两行排版 —— 上标题（加粗、主色）、下描述（次要色）**，
  每行各自占满整行宽度；选中行用 `business` 语义色浅底高亮，鼠标悬停用同色更浅一档。
- **不碰它的源码**：按它自己声明的 `.sk-picker-*` 类名覆盖样式，
  再用一个 `MutationObserver` 给 `.sk-picker` 容器加上 `data-ss-skin` 标记属性
  （**只写属性、不增删节点**，避免与 React diff 冲突）。
- **修掉「太局促」**：根因是两处过小的间距 —— 列表 `gap` 只有 2px、行内边距 9/11px。
  现在列表 `gap:6px`、行内边距 `11px 13px`、浮层内边距 10px、圆角 16px，
  行与行之间成为可分辨的块，不再糊成一片。
- **修掉描述被压成半行**：它原来是 flex 平铺 + `.sk-picker-name{max-width:45%}`，
  标题和描述挤在同一行，描述吃不到一半宽度就被截断。改成单列两行后，
  描述能显示约两倍信息量。
- **去掉左侧字母方块头像**：试过 30px 方块，但 400px 宽度里它吃掉 40px，
  剩下约 330px 给两行文字反而更挤；去掉后文字拿到整行宽度，
  行内才有余量做舒展排版。同时移除了配套的 `data-ss-letter` / `--ss-av-h` /
  `hueOf()` 一套逻辑（不再需要往行上写属性，顺带消除了
  「浮层先出空壳、后填内容」导致标记漏打的隐患）。
- **作用域收敛**：皮肤规则全部以 `.sk-picker` 开头，且都带 `data-ss-skin` 标记，
  不会泄漏到任何别的界面。想撤掉只需删掉那段 CSS 与 `installPickerSkin(ctx)` 调用。

### 修：插件「更新」功能一直是坏的（检测不到任何更新）
- **现象**：插件页/技能面板里从不出现「更新」按钮，永远显示「已是最新」，
  但 `npm` 上明明有新版本。
- **根因**：`marketVersionOutdated()` 里版本解析写成了
  `String(v).replace(/^v/i,'').split(/[.+]/)[0].split('.')`
  —— 先按 `.` 和 `+` 切开、再取**第 0 段**，于是 `'1.66.12'` 变成 `[1]`，只剩主版本号。
  结果只有**跨大版本**才会被判为有更新；同主版本的一律漏报。
  实测该接口 `updatesCount` 长期为 `0`，而目录里实际有 3 个更高版本。
- **影响面（实测到的漏报）**：`dshmarket 1.66.12 → 1.66.22`、
  `dsh-workbuddy-connect 0.7.1 → 0.7.5`、
  `dsh-plugin-wallpaper-engine 1.3.1 → 1.3.2` —— 全部被当成「已是最新」。
- **修法**：解析改为「去 `v` 前缀 → 去 `+build` 元数据 → 去 `-prerelease` 后缀 → 按 `.` 分段」。
  预发布后缀按正式版本号参与比较（不把 `1.0.0-rc.2` 当更新推给用户）。
- 回归测试：`test-version-outdated.mjs` 从 `lib/index.js` 里**抠出真实函数**执行，
  15 个用例（含 3 条本机真实数据）+ 反向断言「旧写法已移除」+ 语义断言
  「同主版本的 3 条真实更新必须全部能被检测到」。
  > 注：这个 bug 只修好了一半 —— 它让**比较**正确了，但**数据源**仍是滞后的第三方目录。
  > 真正让「自动检测」可用的是上面那条「数据源改用 npm」。

- 给那个浮层加了一层皮肤：**单列两行排版 —— 上标题（加粗、主色）、下描述（次要色）**，
  每行各自占满整行宽度；选中行用 `business` 语义色浅底高亮，鼠标悬停用同色更浅一档。
- **不碰它的源码**：按它自己声明的 `.sk-picker-*` 类名覆盖样式，
  再用一个 `MutationObserver` 给 `.sk-picker` 容器加上 `data-ss-skin` 标记属性
  （**只写属性、不增删节点**，避免与 React diff 冲突）。
- **修掉「太局促」**：根因是两处过小的间距 —— 列表 `gap` 只有 2px、行内边距 9/11px。
  现在列表 `gap:6px`、行内边距 `11px 13px`、浮层内边距 10px、圆角 16px，
  行与行之间成为可分辨的块，不再糊成一片。
- **修掉描述被压成半行**：它原来是 flex 平铺 + `.sk-picker-name{max-width:45%}`，
  标题和描述挤在同一行，描述吃不到一半宽度就被截断。改成单列两行后，
  描述能显示约两倍信息量。
- **去掉左侧字母方块头像**：试过 30px 方块，但 400px 宽度里它吃掉 40px，
  剩下约 330px 给两行文字反而更挤；去掉后文字拿到整行宽度，
  行内才有余量做舒展排版。同时移除了配套的 `data-ss-letter` / `--ss-av-h` /
  `hueOf()` 一套逻辑（不再需要往行上写属性，顺带消除了
  「浮层先出空壳、后填内容」导致标记漏打的隐患）。
- **作用域收敛**：9 条皮肤规则全部以 `.sk-picker` 开头，且都带 `data-ss-skin` 标记，
  不会泄漏到任何别的界面。想撤掉只需删掉那段 CSS 与 `installPickerSkin(ctx)` 调用。

### 「+ 技能」浮层显示中文分析
- 新增只读端点 `POST /api/dsh-curator/lookup`：输入 `[{name, description}]`，返回
  `{analyses: {name: {summary, usage, triggers}}}`。**服务端按 name 反查技能全文**后再查缓存，
  调用方不需要提供全文。
- **修**：分析缓存的键两侧不一致，导致「明明分析过、界面却仍显示英文」。
  写入侧 `/analyze` 用 `cacheSource = fullText || description`，而 `/harness` 历史上只按
  `description` 查。实测本机 22 条技能里旧逻辑只命中 **8** 条，14 条 miss。
  新增 `AnalysisCache.getEither(description, fullText)`（两个键都试），
  并把 4 处读取点（`/harness`、`/plugins`、`/scan`、`/lookup`）统一改过去 —— 命中 **22/22**。

### 插件管理：改用 DSH 官方 pluginManager 服务
- 启停 / 卸载 / 安装改为优先走宿主自己的 `pluginManager` 服务（`setBundleEnabled` /
  `setPluginEnabled` / `removeBundle` / `installBundle`），拿不到服务时自动退回原来的
  手写 YAML 路径，功能不消失。换来的好处是白拿官方那套：注释保留的 YAML 编辑、
  原子写、`withFileLock` 防并发、`protectedModules` 拒写、失败自动回滚
  （`restoreFiles`），以及精确的 `applied` / `restart-required` / `overridden` 回执。
- **修**：停用 bundle 型插件时会往 `cordis.patch.yml` 写一行 `disabled: true`，
  但同一步又把包从 `dsh.profile.bundles` 里摘掉 —— 那行补丁失去了目标，loader 只会
  打一条 `patch: entry not found` 然后跳过，永久残留。现在走官方通道只动 bundles；
  手写退路也改为写 `disabled` 后不再摘 bundles 造成孤儿。
- **修**：卸载插件时连带清理**该包自己**在补丁层留下的行（包已删除，那些 `- id: xxx`
  永远失去目标）。只删属于它的 id，不会误删被正常停用的其它行。
- **修**：`setPatchDisabled()` 在多 `insert id` 时行号失效。原实现只算一次块边界，
  却在循环里 `splice` 插行，第二个 id 起就在按过期行号操作，会把 `disabled`
  追加到文件末尾而原块没写上。现在每轮重算，并只认顶格两空格的**行级** `disabled`
  （避免改到 `config` 里同名的业务字段）。
- 新增 `dropPatchRows()`（整段删除补丁行）与 `officialHint()`（把官方回执翻成人话）。

### 界面
- **配色对齐主题**：状态色（成功 / 警告 / 危险）从写死的 iOS 数值改为宿主的
  `--dsw-alias-state-*` 语义 token。实测：`#34c759` / `#ff9500` / `#ff9f0a` 在
  鲸鱼娘皮肤**浅色主题**下压在本插件面板底色上的对比度只有 **2.12 / 2.10 / 1.96**，
  低于 WCAG AA 要求的 4.5 —— 那几支固定色是按纯白底挑的，遇到带蓝的浅底就崩。
  改走语义 token 后由宿主保证两个主题都成立，换肤也自动跟随。
- 面板底色由 `--dsw-alias-bg-layer-1` 改为显式不透明的 `--ss-surface`
  （`bg-layer-1` 88% + `bg-layer-3`）。实测 12 种「底色 × 壁纸（纯白/纯黑）」
  组合下 label-primary / label-secondary 对比度 7.38–14.12，全部通过 AA。
  **继续不碰 `--dsw-alias-bg-base`**：鲸鱼娘皮肤把它设为 `transparent` 让壁纸透出。
- **去掉默认 AI 配色**：头像是蓝紫渐变（`135deg #0a63d6 → #4b49c9`）+ 蓝色发光，
  换成中性描边块。首字母本来只是占位，不该是页面上最抢眼的元素；而且本机 14 个
  插件里 11 个首字母撞脸，按名字配彩色只会制造噪声。
- **视图切换改用内联 SVG**：原来是 `☰` / `▦` 两个借来的字符图标，字体一变就换长相。
  现在用「三横 = 行 / 四宫格 = 卡片」，形状本身就是语义，并补上 `aria-label` 与
  `aria-pressed`（原先只有 `title`，读屏读不到选中态）。
- 毛玻璃剂量收敛：设置页的分区大块（`.ss-section`）去掉 `backdrop-filter`。
  该文件自己早就写明「模糊留给容器/抽屉这类小面积元素」，而分区块恰恰可能很长。
  现在全插件实际应用模糊只剩 2 处（抽屉遮罩、吸附保存条），符合 antislop R-10。
- 卡片脚部补 `border-top` 分隔线，让「信息区 / 操作区」分开；`margin-top:auto`
  原有的底部对齐保留。
- 7 处 `transition:all` 改为列具体属性（避免无关属性也参与过渡）。

## 0.1.0 - 2026-10-12

**首个公开版本。**

### 技能来源与导入
- 自动发现本机十余种 coding agent 的技能目录（Claude Code / Codex / Cursor / 通义灵码 等），支持手动增删改与启停。
- 按来源分区展示；来源内部支持搜索、排序（默认 / 未导入优先 / 注入开销 / 字符数 / 只看未导入）。
- 单条导入与**批量导入**，撞名可选「跳过已存在」或「覆盖已存在」。
- 「是否已导入」按落盘目录名判定，与「只看未导入」「批量撞名策略」共用同一判据。

### 可见性治理
- 读写 DSH 原生 frontmatter 键 `disable-model-invocation` / `user-invocable`，控制技能是否进入模型目录、是否给用户直接调用。
- **技能级「禁用」总开关**：关闭时一次写两个键，两个消费面一起关 —— 模型侧 `dsh-tool-skill` 会直接拒绝（知道名字也调不动），用户侧手打 `/name` 也会被 `agent/pre-step` 跳过；启用则同时删掉两个键（不是写 `false`）。
- 详情页保留「高级：分别控制两个面」的两个细粒度开关，用于总开关表达不了的组合（例如留给模型、但不挂在 `/` 列表里）。
- 「部分禁用」中间态：只关了一边时显示琥珀色徽章，总开关不谎报为已启用。
- 只对可写来源开放；外部 agent 的技能库一律只读。

### 注入开销与溯源
- 估算每个技能的 name + description 占多少上下文（字符数 + ≈token，无第三方依赖）。
- 导入台账记录来源与导入时间，并检测来源目录是否仍然存在。

### 回收站
- 删除 = 移入 `$DSH_HOME/dsh-curator/trash/`，支持恢复 / 彻底删 / 一键清空。
- 同盘 rename 秒移，跨盘（EXDEV）自动降级为复制 + 删除。

### 插件管理
- 已安装插件的浏览、AI 分析、智能分类、启用 / 停用 / 卸载，以及「按包名安装」逃生舱；写前自动备份 profile 清单（保留最近 5 份）。
- 插件市场：直连公开目录，支持分类、排序、分页、安装、全部更新，并有详情抽屉（统计、高危能力警告、能力清单、安装标识、主页 / npm 外链）。
- 技能市场：SkillHub + ClawHub 双源目录，分类、排序、分页、一键安装。

### AI 分析
- 默认关闭；支持**宿主模型**与**自定义 OpenAI 兼容端点**两种通道，结果本地缓存。
- 发送前对结构化密钥形态做擦洗（`[REDACTED]`），提示词里另有「不要复述密钥、不要猜打码原值」的约束。
- 首次点分析弹一次确认，框里报出**真实的发送目标**；设置页有常驻的隐私提示块。

### 界面
- 一级页签三个：**技能 / 插件 / 设置**；「技能市场」「插件市场」分别是两边的二级项。
- 详情统一为右侧抽屉（技能库 / 其他 Agent / 已安装插件 / 技能市场 / 插件市场），`Esc` 可关。
- 所有「开 / 关」是同一种胶囊滑块，由原生 `checkbox` + `appearance:none` 绘制，键盘空格切换与读屏朗读都保留。
- 中英双语，跟随宿主语言切换；面板尺寸自适应量的是面板自身宽度，不是视口。
- **面板里不提供「重启 DSH」**：桌面版的 DSH 进程是桌面外壳监督的子进程，它自行退出会被判成「应用意外停止」，所以自动重启在桌面版下必然把 host 弄崩。插件的装 / 卸 / 启停只负责把变更写进 profile 配置并如实反馈；要生效请重开窗口。详见 README。

### 安全
- **第三方技能 README 里的链接与图片走协议白名单**（`http` / `https` / `mailto`，图片另放行 `data:`），不合法的一律退化成纯文本；对浏览器会忽略的嵌入控制字符做了同样清洗，`java\tscript:` 这类绕过被挡住。
- 可见性接口要求**严格布尔**入参，否则 400 —— 只判 `=== true` 会让 `"false"` 反过来执行。
- 所有落盘路径经 `safeFolderName` 清洗 + 界内断言；回收站条目 id 拒绝 `..` 与路径分隔符。
- 解压逐项校验（防 zip-slip 与符号链接逃逸），并有 64MB / 5000 文件上限。
- 写请求校验 `Origin` 白名单并要求 `application/json`（防针对 localhost 的 CSRF）；请求体上限 2MB。
- 全程用 React 元素构造，**零 `innerHTML`**；**零运行时依赖**。

### 兼容性
- 运行环境：Node ≥ 22.5，DSH ≥ 0.2.0-rc.1；**只在 Windows 上实测过**（macOS / Linux 做了兼容处理但未实测）。
- 插件自身写入的数据都在 `$DSH_HOME/dsh-curator/` 下，不会碰 DSH 自己的目录。
