# dsh-curator（DSH 技能与插件控制台）

一个页面管住本机所有 coding agent 的技能，以及 DSH 自己的插件：**扫出来 → 挑着导入 → 看得见花了多少上下文 → 想要就去市场装 → 不想要了停用或扔回收站**。

DSH 用户库（`~/.dsh/skills`）只会加载自己目录下的技能，而实际上技能往往散落在十几个地方：Claude Code、Codex、Cursor、通义灵码、各类共享池…… 这个插件把它们全扫到一屏里，让你决定哪些收编进 DSH，并对收编后的技能做可见性治理。DSH 插件本身也从同一处管理：启停、卸载、从插件市场装新的。

**最值得一提的是 AI 说明**：技能和插件的 description 常常只有一行英文，看不出到底干什么、什么时候会触发。开启 AI 分析后，面板会用中文把每个技能/插件的用途、触发时机、分类讲清楚 —— 这一层是别处没有的。

## 功能

| 模块 | 做什么 |
|---|---|
| **技能库** | 分区展示 DSH 用户库 / 内置技能，支持搜索、卡片与列表两种视图 |
| **其他 Agent** | 扫描所有已配置来源，逐条或**批量**导入 DSH；撞名可跳过或覆盖 |
| **可见性治理** | 一个「禁用」总开关（同时关掉模型侧与用户侧），详情页里还能分别控制 `disable-model-invocation` / `user-invocable` 两个 DSH 原生 frontmatter 键 |
| **注入开销** | 估算每个技能的 name + description 占多少上下文额度（字符数 + ≈token），可按开销排序 |
| **溯源** | 记录每个导入技能的来源与导入时间，并告诉你"来源是否还在、能不能重新导回来" |
| **回收站** | 删除 = 移入回收站，可恢复 / 彻底删 / 一键清空；不再需要手动去文件系统里 rm |
| **插件管理** | 列出本机已装的 DSH 插件，滑块启停、卸载；可按包名安装或在插件市场里发现新插件 |
| **插件市场** | DSH 插件目录：浏览、搜索、看兼容性、一键安装 |
| **技能市场** | SkillHub + ClawHub 双源目录，分类、排序、分页、一键安装 |
| **AI 说明** | 用中文概括技能/插件的用途、给出触发时机、自动分类；**默认关闭**，开启后可用宿主模型或自定义端点（⚠️ 会把技能全文发出去，见[数据与隐私](#数据与隐私)） |

界面中英双语（跟随宿主语言切换）。

## 安装

**从 GitHub 装**：

```bash
git clone https://github.com/lexin2002/dsh-curator.git
dsh plugin --profile "${DSH_PROFILE:-desktop}" add "link:$(pwd)/dsh-curator"
```

**本机开发**同上，改代码即时生效（配合 HMR）。

装完重启一次 DSH，插件会被加载进来（`dsh plugin add` 只改 profile 清单）。装/卸/启停会写入 profile 的 `package.json` 与 `cordis.patch.yml`，两者都做了自动备份（保留最近 5 份）。

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
