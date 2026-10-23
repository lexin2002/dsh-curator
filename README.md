# dsh-curator（DSH 技能与插件控制台）

一个页面管住本机所有 coding agent 的技能，以及 DSH 自己的插件：**扫出来 → 挑着导入 → 想要就去市场装 → 不想要了停用或扔回收站**。

DSH 用户库（`~/.dsh/skills`）只会加载自己目录下的技能，而实际上技能往往散落在十几个地方：Claude Code、Codex、Cursor、通义灵码、各类共享池…… 这个插件把它们全扫到一屏里，让你决定哪些收编进 DSH，并对收编后的技能做可见性治理。DSH 插件本身也从同一处管理：启停、卸载、从插件市场装新的。

**最值得一提的是 AI 说明**：技能和插件的 description 常常只有一行英文，看不出到底干什么。开启 AI 分析后，面板会用中文给每个技能/插件写一句话说明、用法和中文短名，并在详情保留可核对的英文原名 —— 这一层是别处没有的。

## 功能

| 模块 | 做什么 |
|---|---|
| **技能库** | 分区展示 DSH 用户库 / 内置技能，支持搜索、卡片与列表两种视图 |
| **其他 Agent** | 扫描所有已配置来源，逐条或**批量**导入 DSH；撞名可跳过或覆盖 |
| **可见性治理** | 一个「禁用」总开关（同时关掉模型侧与用户侧），详情页里还能分别控制 `disable-model-invocation` / `user-invocable` 两个 DSH 原生 frontmatter 键 |
| **溯源** | 记录每个导入技能的来源与导入时间，并告诉你"来源是否还在、能不能重新导回来" |
| **回收站** | 删除 = 移入回收站，可恢复 / 彻底删 / 一键清空；不再需要手动去文件系统里 rm |
| **插件管理** | 列表显示 AI 中文短名并保留悬停/搜索英文原名；详情保留放大原名与主页链接，滑块启停、卸载，可按包名安装或在插件市场发现新插件。工具栏常驻「检查更新」，强制绕过 10 分钟缓存重查最新版本 |
| **插件详情** | 一屏一个插件：放大显示英文原名与中文副标题、运行状态徽标、AI 说明（有结果时可直接「重新分析」）、信息事实表（安装标识/安装目录/主页）作者注册的原生配置页、README 折叠阅读。作者没注册配置页时不显示空的「配置」标题 |
| **插件市场** | DSH 插件目录：浏览、搜索、看兼容性、一键安装 |
| **技能市场** | SkillHub + ClawHub 双源目录，分类、排序、分页、一键安装 |
| **AI 说明** | 用中文短名、一句话说明和用法标识技能/插件；详情保留英文原名。**默认关闭**，开启后可用宿主模型或自定义端点（⚠️ 会把技能全文发出去，见[数据与隐私](#数据与隐私)）。旧缓存没有中文名时会自动重新分析补齐 |

界面中英双语（跟随宿主语言切换）。

## 安装

**从 GitHub 装**：

```bash
git clone https://github.com/lexin2002/dsh-curator.git
dsh plugin --profile "${DSH_PROFILE:-desktop}" add "link:$(pwd)/dsh-curator"
```

**本机开发**同上，改代码即时生效（配合 HMR）。

装完重启一次 DSH，插件会被加载进来（`dsh plugin add` 只改 profile 清单）。装/卸/启停会写入 profile 的 `package.json` 与 `cordis.patch.yml`，两者都做了自动备份（保留最近 5 份）。

### 装 / 卸 / 启停走哪条通道

插件管理优先使用 **DSH 宿主自己的 `pluginManager` 服务**（和左边那个官方「插件」页是同一套代码）：

| 操作 | 官方服务 | 拿不到服务时 |
|---|---|---|
| 启用 / 停用 | `setBundleEnabled` —— 写 `dsh.profile.bundles` 并调 `reconcileProfilePatches` 热应用 | 手写补丁层 `disabled` + 改 bundles |
| 卸载 | `removeBundle` —— 先停用、热应用，再 `pnpm rm`，并拒绝卸载受保护包 | `dsh plugin rm` → `pnpm rm` 三级退路 |
| 安装 | `installBundle` —— pnpm add + 进 bundles + 热应用，失败回滚 `package.json` / `pnpm-lock.yaml` | `dsh plugin add` → `pnpm add` |
| 更新 | **不走官方服务**：`installBundle` 对已在 profile 里的包一律抛 `already-installed`（不区分目标版本），所以升级走 `dsh plugin add 包名@版本` → `pnpm add` | 同左（没有官方升级路径） |

服务不存在时（例如没有 `profileContext` 的部署）自动退回手写路径，功能不消失。响应里的 `via` 字段告诉你这次走的是 `official` 还是 `fallback`。

> 升级走 CLI 的原因：官方 `installBundle` 的语义是「社区插件升级请先卸载再装」，
> 见到 profile 里已有同名依赖就直接拒绝。升级完成后回执是 `restart-required`；
> 若目标版本的 peer 依赖与当前 DSH 运行时不一致，DSH 会拒绝安装并在错误里给出
> `dsh plugin allow-version` 命令 —— curator 只翻译它，不替你接受版本风险。

「设置 → 按包名安装」这个逃生舱除 npm 包名 / `github:owner/repo` 外，也接受**本地目录绝对路径**
（Windows `C:\...`、UNC `\\server\share\...`、POSIX `/...`）。内部转成 `link:<绝对路径>`，
与 `dsh plugin add "link:<dir>"` 同语义；目录不存在会当场 400，不会走到安装步骤。

**关于热生效**：DSH 把插件启停建模成 cordis 加载器入口树的增删，而不是进程重启，所以启停通常会当场生效；只有**改变模块解析图**的操作（装新包、换 `link:` 目标）才需要重启，此时回执是 `restart-required`（界面提示「下次启动生效」）。

**「重载插件代码」按钮（不用重启 DSH）**：改完插件源码后点它，等价于调一次宿主的
`pluginManager.reload()`（内部是 `hmr.reconcileProfile()` + `runExclusive`），会按磁盘上的文件
重新组合、替换掉改动的模块。实测过两件事：

- **只保存文件不会自动生效**：改 `lib/index.js` 后等 15 秒，新接口仍是旧行为。
- **点一次「重载插件代码」后 1-2 秒生效**：同一份改动立刻可用。

能覆盖 / 不能覆盖的边界：

| 场景 | 需要重启 DSH？ |
|---|---|
| 改前端 `lib/client.js` | 否（刷新页面） |
| 改宿主 `lib/index.js` | 否（点「重载插件代码」） |
| 启停某个插件 | 否（当场热应用） |
| 安装 / 卸载 / 升级插件 | **是**（模块解析图变了，宿主会拒绝替换并报告 `restart-required`） |
| 授权版本例外（allow-version） | 否（下一次组合生效） |

**开关与徽标是两个维度**：开关是 profile 里的**选择状态**（在 bundles 里、没被补丁层停用），徽标是宿主**实际加载状态**。DSH 的版本兼容闸门会在启动时跳过 peer 依赖不匹配的插件——这时开关是开的、插件却没加载。curator 会把宿主给出的原因显示为 **未加载**（详情页附 `dsh plugin allow-version ... --accept-risk` 命令），而不是只写「已关闭」。

### 平台支持

目前**在 Windows 上验证过**。代码里对 macOS / Linux 做了兼容处理（路径分隔符、大小写比较、`tar` 解压），但没有实测 —— 遇到问题欢迎提 issue。

### 为什么不提供「重启 DSH」

面板里没有「重启 DSH」这类按钮，装/卸/启停插件后也不会自动重启宿主机进程。

原因不是偷懒：桌面版（DeepSeek Harness 应用）里的 DSH 进程是桌面外壳 **spawn 出来并全程监督的子进程**，它一退出（不是外壳主动要求的那种退出），外壳就判定「应用无法启动或已意外停止」并弹框 —— **host 自杀在桌面版里被设计成致命错误**。任何"帮你自动重启"的实现都是让自己退出，在桌面版下点一次必然把 DSH 弄崩。

所以本插件对插件的装/卸/启停只做一件事：**把变更写进 profile 配置**，然后如实告诉你写完了。需要让变更生效时，自己关掉窗口重新打开 DSH 即可（真崩了的话，崩溃对话框里那个「重启」是有效的，它走的是外壳自己的 `app.relaunch()`）。

## 配置

**运行时真源是 `$DSH_HOME/dsh-curator/config.json`**，面板「设置」页写的就是它。`cordis.patch.yml` 里的 `config` 只在**首次安装**（`config.json` 尚不存在）时作为默认值，之后不会覆盖你在界面上改过的设置。

配置分三段，键名如下（改动前请对照 `lib/index.js` 的 `normalizeConfig`）：

```yaml
analyze:            # AI 分析
  enabled: false    #   默认关闭
  mode: host        #   host = 用宿主当前模型；endpoint = 自定义 OpenAI 兼容端点
  baseUrl: ''       #   仅 mode: endpoint 时使用
  apiKey: ''
  model: ''
  batchSize: 8      #   一次请求分析几个技能（1–40）
  concurrency: 2    #   并发请求数（1–10）
  cacheMaxEntries: 5000   # 分析结果缓存条数上限
scan:
  depth: 3          # 技能目录扫描深度（1–6）
  maxPerSource: 500 # 每个来源最多扫多少条（10–5000）
market:
  defaultSource: skillhub   # skillhub | clawhub
  pageSize: 6
sources: []         # 技能来源列表，由面板「设置」页维护
```

> 历史坑：更早的版本这里写过 `cachePath` / `translateBatchSize` / `scanDepth` / `maxSkillsPerSource`，那是扁平的旧键名，现行代码一个都不读。在界面里改了没反应，多半是踩到了这个。

## 数据与隐私

这个插件会读你本机的技能目录，所以把数据流向说清楚：

**不联网的操作**（改名、删技能、改可见性都不会外发任何东西）
- 扫描来源目录、导入技能、删除到回收站、改可见性、插件启停与卸载。

**会联网的操作**
- **AI 分析**（`analyze.enabled` 默认 **false**）：开启后会把技能的 name / description / 正文（截断到 8KB）发给**宿主当前模型**，或你填的自定义端点。关掉它，本插件一个字节都不外发。
- **技能市场**：浏览与安装会请求 SkillHub / ClawHub 的接口。

### ⚠️ 技能里的密钥会跟着 AI 分析一起发出去

技能文档里夹带 API Key、token 是很常见的做法 —— 有人直接写在 SKILL.md 的「配置」一节。而 AI 分析读的是**全文**，这些内容会原样出境，发给你选的那条通道。

本插件对此做了两层处理：

1. **发送前按形态打码**：识别各家的固定前缀（`sk-` / `ghp_` / `github_pat_` / `AKIA` / `xox*` / `AIza` / `glpat-` 等）、`api_key=tokensecret` 这类键值对、PEM 私钥块、JWT、`Bearer` 头，替换成 `[REDACTED]`。
2. **提示词里禁止复述**：要求模型不要在 summary/usage 里转述密钥或内网地址。这一步不能省 —— 分析结果会落盘到 `analyses.json` 并显示在卡片上，模型一旦把 key 抄进摘要，就是照着界面二次暴露了一遍。

**但打码是启发式的，覆盖不全**：改写成散文的 key、自定义前缀的、拆成两段拼的、写在代码注释里的，它一律认不出。所以：

> **技能来源不放心时，先自己打开看一眼再用 AI 分析。**
> 设置页常驻了这条提示，首次点击分析时还会再确认一次（之后不再打断）。

分析缓存只写在本地 `$DSH_HOME/dsh-curator/analyses.json`，不会上传到任何地方。

**本地写入清单**（除这些之外不会动你的磁盘）

| 路径 | 用途 |
|---|---|
| `$DSH_HOME/skills/<name>/` | 导入的技能；改可见性时改它里面的 `SKILL.md` frontmatter |
| `$DSH_HOME/dsh-curator/trash/` | 回收站：`<id>/` 目录本体 + `<id>.json` 元数据 |
| `$DSH_HOME/dsh-curator/config.json` | 插件配置（含 API Key，POSIX 下写成 0600） |
| `$DSH_HOME/dsh-curator/analyses.json` | AI 分析缓存 |
| `$DSH_HOME/dsh-curator/imports.json` | 导入台账（来源与导入时间） |
| `$DSH_HOME/profiles/<profile>/package.json`、`cordis.patch.yml` | 仅在装 / 卸 / 启停插件时写，写入前自动备份 |

**只读来源**：外部 agent（Claude Code、Codex 等）的技能目录只被读取，改可见性、删除等写操作一律拒绝。可见性能写的只有 DSH 用户库和未标记只读的共享池。

## 主题与可读性

颜色一律取宿主语义 token（`--dsw-alias-*`），**不写死色值**，所以明暗主题、第三方皮肤都会自动跟随。

**排版（2026-10-17 重做）**：面板按官方插件页的同一套规矩排——页面标题 20/28、分区标题 14/20、
正文 14/22、控件统一 32px 高、列表是「一个容器 + 发丝分隔线」而不是每行一张卡、全页只留一个实心主操作。
详情页头部简介、AI 说明和设置页段落仍收在 74ch 左右；「说明文档」全文用满可用宽度，
避免桌面端正文只占左半栏、右半整块空白。信息仍用「左标签 / 右值」的事实表补齐。

**窗口适配**：面板自己量宽度分五档（`xs/narrow/mid/wide/xwide`），不依赖视口 media query——
DSH 的主区可能比窗口窄得多。内容统一 1120px 居中（设置页 1040）；面板 ≥1500px 时详情页变成
「主栏 + 360px 信息侧栏」两列，最大化窗口下右半边不会再空着。

**详情形态统一**：技能库、其他 Agent、技能市场、插件市场、已装插件**都是二级页面**，
不再是右侧抽屉——浮层在手机上会盖住列表、和吸顶提示条争同一块屏幕。返回时还原列表滚动位置，
`Esc` 等同返回。动作栏同理：**放得下就直排**，已删除「⋯」收纳，窄屏靠换行。

**移动端**：触屏（`pointer: coarse`）下可点元素补到 44px 触区但视觉尺寸不变；
≤420px 容器下详情标题降一档、统计卡片两列、事实表改成「标签在上、值在下」，
任何宽度都不出现横向滚动。读 `SKILL.md` / README 时先按 UTF-8，遇到替换字符回退 GBK 解码，
避免 GBK 文档整篇显示成问号。

两条刻意遵守的约束，都是实测出来的：

1. **不拿 `--dsw-alias-bg-base` 当背景**。鲸鱼娘皮肤（`@smalltailqwq/dsh-client-ui-skin-maid-atelier`）把它设为 `transparent` 让壁纸透出来，任何用它当底色的面板，文字会直接叠在壁纸上。本插件用 `--ss-surface`（`bg-overlay` 94% + `bg-layer-3`），保证浅色主题配深色壁纸时灰字仍在 AA 之上。
2. **状态色不写死**。`#34c759` / `#ff9500` / `#ff9f0a` 这类 iOS 数值在鲸鱼娘皮肤的**浅色主题**下，压在本插件面板底色上的对比度只有 2.12 / 2.10 / 1.96，低于 WCAG AA 要求的 4.5。现在改用 `--dsw-alias-state-success-primary` / `-warn-label` / `-error-primary`，由宿主按主题成对调过。

实测数据：`tools/curator-contrast-audit.mjs` 覆盖浅/深主题 × 白/黑壁纸 × 面板底/卡片底 × 正文/次要/三级字与状态色，共 48 组，全部 ≥ 4.5。

## 可见性治理是 DSH 原生能力

`disable-model-invocation` 与 `user-invocable` 是 DSH 自己的 frontmatter 治理键（见 `@deepseek-ai/dsh-skill-filesystem`），本插件只是提供界面：

- `disable-model-invocation: true` → 技能不进模型目录，模型不会自动看到它，用户仍可手动调用。
- `user-invocable: false` → 不在列表里给用户直接调用。

**两个键都关 = 这个技能被禁用**：两个消费面都拦。模型侧 `dsh-tool-skill` 会直接报 `not available for model invocation`（知道名字也调不动），用户侧手打 `/name` 也会被 `agent/pre-step` 的钩子静默跳过。所以面板上的「禁用」总开关就是同时关掉这两个键 —— 文件仍在原处，随时可以启用回来。

⚠️ **不要**把 `modelInvocable` / `userInvocable` / `disableModelInvocation` 直接写进 frontmatter。DSH 会把这三个当成不支持的字段并抛错，而这个错**被上层 catch 掉、只留一行日志** —— 结果是**那个技能从目录里凭空消失**，界面上看不出任何原因（官方文档原话：模型侧分不清"技能不存在"和"技能写坏了"）。切开关请走面板，它写的是正确的键。

## 安全

本插件会读写磁盘上的技能文件、下载并解压第三方技能包，所以对不可信输入做了明确设防：

- **路径**：所有落盘路径经过 `safeFolderName` 清洗 + 界内断言（含回收站恢复）；回收站条目的 id 拒绝 `..` 与路径分隔符。
- **压缩包**：解压后逐项校验（防 zip-slip 与符号链接逃逸），并有 64MB / 5000 文件的解压上限。
- **本地接口**：写请求校验 `Origin` 白名单并要求 `application/json`（防针对 localhost 的 CSRF）；请求体上限 2MB。
- **渲染**：第三方技能 README 里的链接与图片走协议白名单（`http` / `https` / `mailto`，图片另放行 `data:`），「假链接」退化成纯文本；全程用 React 元素构造，无 `innerHTML`。
- **依赖**：**零运行时依赖**，没有供应链投毒面。

**报告安全问题**：请**不要**开公开 issue，直接通过 GitHub 私信或仓库主页留下的联系方式告诉我。

## 开发

```bash
npm run check      # node --check 双端（lib/index.js + lib/client.js）
```

- 服务端 `lib/index.js`：cordis 插件，导出 `apply(ctx, userConfig)`，通过 `ctx.webServer.register` 暴露 `/api/dsh-curator/*`。
- 客户端 `lib/client.js`：浏览器端自包含模块，**只能 `require("react")`**，没有构建步骤、不依赖任何 npm 包（连 `js-tiktoken` 都没引，token 数是自研启发式估算）。改完直接生效。
- 仓库内不含测试脚本；回归校验与端到端走查在开发工作区里跑。

## License

MIT，见 [LICENSE](./LICENSE)。
