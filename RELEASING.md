# 发布指引（RELEASING）

这份文档是给**维护者**看的，不随 npm 包发布（`package.json` 的 `files` 里没有它）。

面向的场景：第一次把这个插件发布出去。下面每一条都对着本仓库的实际情况写，不是通用清单。

---

## 0. 现状体检

发布前先知道自己在哪。以下按 **2026-10-26** 的实测更新（早先 2026-10-11 的版本已过时）：

| 项目 | 状态 | 要做什么 |
|---|---|---|
| git 仓库 | 有历史，分支 `main`；远端 `origin` = github.com/lexin2002/dsh-curator | — |
| 与远端的关系 | 远端曾停在 `24c98f3`（2026-10-12），本地领先 23 个提交，**无分叉** | `git push` 即可，不需要 force |
| 提交身份 | 已设为 `lexin2002 <210155061+lexin2002@users.noreply.github.com>` | 已就绪 |
| 测试 | 仓库内已有 `npm test`（`test/unit.mjs`，50 项，零依赖） | `npm test` 必须全绿 |
| npm 登录 | 未登录（本机 `npm` 走 `.cmd`，PowerShell 需 `npm.cmd`） | 要发 npm 才需处理，见 §2.3 |
| 包名 `dsh-curator` | npm 上**仍可用**（2026-10-26 复查仍是 404） | 直接用这个 |
| 已发布的 tag | `v0.1.0` 打在 `b50aced`（旧代码，**早于本次全部功能**） | 本次发 `v0.1.1`，不要移动旧 tag |
| 版本 | `package.json` 已升到 `0.1.1` | CHANGELOG 已切好段 |
| 包名 `dsh-skill-station` | **已被别人占用** | 见 §2.2，这是个坑 |
| 同生态已占用的好名字 | `dsh-hub`（local plugin hub）· `dsh-catalog`（find & install DSH plugins）· `dsh-deck` · `dsh-console` · `dsh-atlas` · `dsh-workbench` | 起名时避开，否则用户会以为是同一家 |

---

## 1. 先决定发到哪

三条路，可以同时走，但**顺序有讲究**：

| 方案 | 适合 | 代价 |
|---|---|---|
| **A. 只发 GitHub** | 想让别人看到源码、自己安装 | 别人要 `git clone` 或 `dsh plugin add "link:..."` |
| **B. 只发 npm** | 想让 `npm i` / `dsh plugin add dsh-curator` 一行装好 | 必须先有 GitHub 仓库（npm 页面会链过去，没有会被当成可疑包） |
| **C. 两个都发** ← 推荐 | 开源项目的常规做法 | 多一步 npm 登录 |

**建议：先 A，确认没问题再 B。** 不要第一次就双发 —— 发到 npm 的版本号**永远不能撤回**（只能 `deprecate`），第一次很容易发错内容。

---

## 2. 账号与名字

### 2.1 GitHub

1. 注册账号（如果还没有），**开启两步验证（2FA）** —— 2024 年起 GitHub 对贡献者强制要求，不开会限制操作。
2. 建仓库。建议：
   - 名字：`dsh-curator`（和 npm 包名一致，最省事）
   - 可见性：**Public**
   - **不要**勾选 "Add a README" / ".gitignore" / "license" —— 你本地已经有这些文件了，勾了会产生一次冲突的初始提交。
3. 建完先**别推送**，先做完 §3 的身份配置。

### 2.2 ⚠️ 名字的坑：`dsh-skill-station` 已经被别人占了

npm 上有一个 **别的人**发布的、**功能高度重合**的包：

- 包名：`dsh-skill-station`，作者 `wilshi`，仓库 `github.com/WilShi/dsh-skill-station`
- 描述：「DSH 技能站：侧边栏技能中枢，扫描各家 agent 技能库一键导入……」
- 首次发布：2026-08-21

**本项目原来是 `dsh-skill-deck` 包名 + `skill-station` 插件 id**，2026-10-11 已统一改名成 `dsh-curator`（包名 / 仓库名 / 插件 id / `$DSH_HOME` 数据目录四处一致）。改名的直接动机就是这个：**插件 id 和数据目录都叫 `skill-station`，等于长期拿别人的项目名当自己的本地目录名**。现在这条已经不存在了，但下面几条仍然要守：

1. **不要**把包名改回 `dsh-skill-station` —— 那是别人的包名，会直接被 npm 拒。
2. GitHub 仓库名也**别叫** `dsh-skill-station`，避免让人觉得是同一个项目。
3. README 里**不要说**"和 X 一样"或"X 的替代品"，也别说"官方"。写自己的功能就行。
   （本项目此前已做过一轮措辞清理：注释里所有"移植自 / 同款 / 对齐某某官网"都改成了"参照……自写"。）

另外注意 npm 上的命名习惯：官方包都在 `@deepseek-ai` 作用域下（`@deepseek-ai/dsh-skill-badge`、`@deepseek-ai/dsh-web-app`……）。**这个作用域外人发不进去**，所以只有两个选择：
- 无作用域的 `dsh-curator`（可用，推荐）
- 你自己的作用域 `@<你的npm用户名>/dsh-curator`

### 2.3 npm（只有走方案 B/C 才需要）

1. 在 npmjs.com 注册，**开启 2FA**（现在新建账号默认强制，且发布时要求 OTP）。
2. 本机登录：

   ```bash
   npm login          # 会开浏览器；用户名/密码/邮箱 + 一次性验证码
   npm whoami         # 确认登录成功
   ```

3. **不要**把 token 写进任何文件。

---

## 3. 提交身份：必须改（当前是占位符）

现在仓库里的提交作者是 `local <dev@local>` —— 这是环境默认值，不是你的身份。不改的话，GitHub 上这些提交不会归到你的账号，也不会有头像链接。

**分两层改**（本地 + 全局，本地优先）：

```bash
cd dsh-curator
git config user.name  "你的名字"
git config user.email "你的邮箱"

# 可选：把以后所有仓库的默认身份也设好
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

**邮箱怎么选**（这关系到隐私）：

- 想隐藏真实邮箱 → 用 GitHub 提供的 `ID+用户名@users.noreply.github.com`（在 GitHub 设置 → Emails 里能看到），并在 GitHub 上勾选 "Keep my email addresses private"。
- 用真实邮箱 → 它会**永久留在每个提交里**，公开可见，且很难彻底清除（要重写历史）。

历史提交里的占位符身份**不改也能发**（旧的作者信息会保留成 `local`），但如果你在意，可以在推送前重写：

```bash
# ⚠️ 重写历史会改变所有 commit hash。只在还没推送到远端时做！
git rebase -i --root
# 或非交互式批量改：
git filter-branch --env-filter '
  export GIT_AUTHOR_NAME="你的名字"
  export GIT_AUTHOR_EMAIL="你的邮箱"
  export GIT_COMMITTER_NAME="你的名字"
  export GIT_COMMITTER_EMAIL="你的邮箱"
' -- --all
```

**没推送之前重写是安全的；推送之后就别动了**（别人 clone 过的仓库会全部对不上）。

---

## 4. 版权与许可

### 已经做好的

- `LICENSE`：MIT，版权行是 `Copyright (c) 2026 dsh-curator contributors`。
- `package.json`: `"license": "MIT"`。

### 你要决定的一件事

版权署名写谁。现在是 **`dsh-curator contributors`**（泛指贡献者）。三种常见写法：

| 写法 | 含义 | 适合 |
|---|---|---|
| `dsh-curator contributors` ← 现状 | 归全体贡献者 | 打算接受外部 PR |
| `你的名字` | 明确归你个人 | 个人项目，想保留署名权 |
| `你的名字 and contributors` | 你的名字在前 | 最折中，也最常见 |

**这只是署名格式，不影响 MIT 赋予别人的权利**（MIT 允许别人商用、修改、闭源再分发，只要保留版权声明和许可全文）。

### MIT 之外要考虑的

- **第三方代码**：本项目**零运行时依赖**（`peerDependencies` 里的 `@deepseek-ai/cordis` 由宿主提供），所以没有第三方代码要附带许可。这条是优势，发布说明里值得写一句。
- **第三方数据的许可**：插件会连 SkillHub / ClawHub 市场、读别的 agent 的技能目录。**别人的技能内容不归你**，你只是读取与导入，不打包、不转发。README 里已经说明这一点（"数据与隐私"一节）。
- **商标**：不要在名字、描述、README 里暗示与 DeepSeek 官方或 SkillHub 官方有隶属关系。可以用"for DeepSeek Harness"这种**描述兼容性**的措辞，不能用作名字前缀制造官方感。

---

## 5. 版本与更新

### 语义化版本（SemVer）：`主.次.补丁`

| 何时升 | 例子 |
|---|---|
| **补丁** `0.1.0 → 0.1.1` | 修 bug、改文案，不改行为契约 |
| **次版本** `0.1.1 → 0.2.0` | 加功能，向后兼容（比如这次加的「禁用」总开关） |
| **主版本** `0.2.0 → 1.0.0` | 有破坏性变更（配置键改名、接口路径变了、行为反转） |

**`0.x` 的特殊规则**：主版本是 0 时，SemVer 允许任何版本都可能破坏兼容 —— 但**别滥用**，用户仍会按"次版本=兼容"来预期。所以：
- 破坏性变更 → 升到 `0.2.0` 并在 CHANGELOG 里**明确写 BREAKING**。
- 本项目现在 `engines.dsh: ">=0.2.0-rc.1"`，DSH 本体还在 rc，说明接口可能变 —— 至少在 README 里提示这一点。

### 本项目的"公开契约"有哪些

升级前先认清哪些东西算契约、动了就得升版本：

1. **HTTP 路由**：`/api/dsh-curator/*`（前后端都是这个插件自己，内部改不算破坏，但第三方插件若调用就算）
2. **配置文件键名**：`config.json` 的 `analyze` / `scan` / `market` 三段
3. **磁盘布局**：`$DSH_HOME/dsh-curator/` 下的 `trash/`、`imports.json`、`analyses.json`、`backups/`
4. **写进技能文件的 frontmatter 键**：`disable-model-invocation` / `user-invocable`
   —— 这一条最要紧，见 §6.3
5. **插件 id**：`dsh-curator`（在 `cordis.patch.yml` 里）。**改 id = 破坏性变更**：
   旧的 `skill-station` 行会被当成另一个插件，profile 里必须做一次「删旧 id + 加新 id」，
   数据目录也要跟着搬 —— 这次改名（`skill-station` → `dsh-curator`）就是按这条走的，
   因为当时**还没发布、没有外部用户**；一旦发出去，同样的事成本会高得多。

### CHANGELOG 怎么写

`CHANGELOG.md` 已经在仓库里。约定：
- 顶部一个 `## [未发布]` 段，攒下一次版本的内容；
- 发版时把它改成 `## [0.2.0] - 2026-10-12`，下面按 **新增 / 修复 / 变更 / 破坏性** 分节；
- **破坏性变更单独一节并加粗**，不要混在"修复"里。

---

## 6. 兼容性

### 6.1 运行环境

| 维度 | 现状 | 说明 |
|---|---|---|
| Node | `engines.node: ">=22.5"` | 实测只用到 Node 16-17 级别的 API（`fs.cp`、`Object.hasOwn`、`AbortSignal.timeout`），这个下限**故意留得保守**，因为 DSH 本身就要求现代 Node。想放宽可以，但要真在新版本上跑一遍 |
| DSH | `engines.dsh: ">=0.2.0-rc.1"` | DSH 还在 rc，接口可能变 |
| 操作系统 | 只实测过 **Windows** | 见下 |

### 6.2 ⚠️ 跨平台：这是目前最大的兼容性缺口

代码在写的时候**处处照顾了 Windows**（路径分隔符、大小写不敏感比较、`tar` 解压），但：

- **macOS / Linux 从未实测过**。README 里如果写"支持三平台"，那是没根据的。
- 已知需要单独验证的点：
  - `tar -xf` 解压 zip，Linux 上 GNU tar 能处理，但某些精简发行版可能没有；
  - 权限位（`chmod +x` 的脚本被导入技能库后是否还能执行）。

**建议**：README 里先如实写"主要在 Windows 上验证"。等真有人报 macOS/Linux 的问题再修 —— 比声称支持然后被打脸好。

### 6.3 ⚠️ 和 DSH 的兼容性：写 frontmatter 是单向门

这是**最容易造成用户数据损坏**的地方，务必理解：

`SKILL.md` 的 frontmatter 里，DSH 只认这两个键：
- `disable-model-invocation: true`
- `user-invocable: false`

**写错**（比如写成 `modelInvocable:`）会导致 `dsh-skill-filesystem` 抛错，而这个错**被外层 catch 掉、只留一行 `logger.warn`** —— 结果是**那个技能从目录里凭空消失**，用户完全看不出原因。DSH 官方 README 的原话是模型侧 `cannot distinguish an absent skill from an invalid one`。

所以：
- 这两个键名**写死在代码里，不要"重构"成动态拼接**；
- 关闭 = 写值，**打开 = 删键**（不要写 `false`，那会留下一个"被治理过"的痕迹，别的工具读到的状态就不干净了）；
- 任何改动这条路径的提交，都必须跑一遍后端回归的第 21 节（可见性写入 / 回收站 / 台账 / 非法入参拒绝）
  以及前端渲染管线的协议白名单用例。**⚠️ 这两个脚本目前不在本仓库里**（在开发工作区的 `scripts/` 下），
  见 §9「长期维护」最后一条 —— 这是本项目当前最该补的一块。

### 6.4 升级怎么不砸用户的配置

- `cordis.patch.yml` 里的 `config` **只在首次安装时生效**（`config.json` 不存在时）。用户改过的设置在升级后不会被覆盖 —— 这是刻意的。
- 但**改 config 键名 = 破坏性变更**。如果一定要改，必须写迁移逻辑（本项目已有先例：`translate` → `analyze`，两处都做了兼容读取）。
- 磁盘上的 `trash/`、`imports.json` 是用户数据，**格式变更要写迁移**，不能直接换 schema。

---

## 7. 安全

### 7.1 这个插件为什么天然是高危的

它做的事情：**读写用户磁盘上的技能文件、下载并解压第三方压缩包、改 profile 清单（等价于装/卸 npm 包）**。任何一处疏忽都是本地任意代码执行。所以审计的重点不是"有没有 bug"，而是**每条不可信输入的去向**。

### 7.2 已做的防护（发布前复核过）

| 风险 | 防护 | 位置 |
|---|---|---|
| 路径穿越（`../`） | `safeFolderName` 清洗 + `assertInside` 前缀比对（带尾分隔符、大小写不敏感） | `lib/index.js` |
| 回收站恢复写到任意路径 | 恢复前 `assertInside(用户库)`，元数据不当可信输入 | `restoreTrash` |
| 回收站 id 穿越 | `validTrashId` 挡 `/` `\` `..` | `validTrashId` |
| 快照恢复写回任意路径 | 快照 id 必须匹配 `/^\d{13}-[a-z0-9-]{1,32}$/`；写回前逐个校验 `sha256`（半截快照拒绝落盘） | `restoreSnapshot` |
| zip-slip / 符号链接逃逸 | 解压后遍历校验路径 + 64MB / 5000 文件上限 | `assertExtractionSafe` |
| 包名 / spec 注入 shell | 装/卸/启停全部走官方 `remote.pluginManager`（**本插件不再自己拼 pnpm 命令**）；本机唯一一次起子进程是快照恢复：用 `cmd.exe /d /s /c "<dsh.cmd 绝对路径>" plugin --profile <名> install --frozen-lockfile`，参数全由代码拼、`profile` 名过白名单正则，**没有用户字符串进来**；刻意不用 `execFile(..., { shell: true })`（会按空格切断带空格的安装目录） | `runProfileInstall` |
| 解压参数注入 | `tar` 走 argv 数组且**不带** `shell` | `extractArchive` |
| 针对 localhost 的 CSRF | 写请求校验 `Origin` 白名单 + 要求 `application/json`（新增的快照/恢复路由也走同一个守卫） | `originAllowed` |
| 请求体撑爆内存 | 2MB 上限 → 413 | `readBody` |
| README 里的恶意链接 | 链接/图片协议白名单（`http` / `https` / `mailto`，图片另放行 `data:`） | `safeHref` / `safeImageSrc` |
| XSS | 全程 `h()` 构造元素，**唯一的 `innerHTML` 是注入静态样式常量 `SKILL_BTN_CSS`** | 全局 |

> `uninstallPluginPackage` / `marketInstallPackage` 这一批"自写 pnpm 通道"已在
> commit `a9e7412` 整段删除（插件写操作全部改调官方 remote），上面的表已经按现状更新。

### 7.3 发布前必须再自查一次

```bash
# 一条命令跑完：双端语法 + 打包完整性 + 安全红线 + 纯函数正确性（50 项，零依赖）
npm test
```

它等价于下面这些手工 grep（保留成对照，出问题时可以单独跑）：

```bash
# 确认没有打开 shell:true（注释里解释"为什么不这么写"不算）
grep -n "shell:" lib/index.js

# 确认没有动态代码执行
grep -nE "eval\(|new Function|document\.write" lib/*.js

# 确认没有写死本机路径 / 密钥 / 内网地址
grep -nE "C:\\\\Users|[A-Za-z0-9_-]{40,}|192\.168\." lib/*.js
```

### 7.4 供应链

- **零运行时依赖** → 没有依赖投毒面。这是本项目的核心优势，**不要为了省事引入 `js-tiktoken` 之类的包**（注入开销那段用的是自研启发式，就是为了保住零依赖）。
- `peerDependencies` 只有 `@deepseek-ai/cordis`，由宿主提供。
- 如果你以后要加依赖：**锁版本 + 提交 `package-lock.json`**，并开启 GitHub 的 Dependabot 告警。

### 7.5 漏洞怎么报

在 README 里加一段"安全"：

> 发现安全问题请不要开公开 issue，直接邮件/私信我。

否则别人一开 issue 就等于公开了 0day。

---

## 8. 发布流程

### 8.1 推 GitHub

远端已经建好（`origin` = github.com/lexin2002/dsh-curator），本地只是领先若干提交，
所以是**普通 fast-forward push**，不需要 `--force`：

```bash
cd dsh-curator

# 1) 确认身份（已配好，列一下确认没跑偏）
git config user.name; git config user.email

# 2) 跑一遍发布前回归
npm test

# 3) 确认没有未提交的改动
git status

# 4) 推送（远端只领先不落后；如果提示 non-fast-forward，先 git pull --rebase 再推）
git push origin main
```

推送时如果不通，多半是 **HTTPS 需要 token**：GitHub 已不支持密码推送，要在设置里生成 **Personal Access Token (classic, `repo` 权限)**，用它当密码；或者配置 SSH key。

### 8.2 打 tag 并建 Release

**在网页上做更保险**：仓库 → Releases → Draft a new release → 选一个 tag（如 `v0.2.0`，GitHub 会顺便建 tag）→ 标题 `v0.2.0` → 内容直接贴 CHANGELOG 里对应的那一段 → 发布。

### 8.3 发 npm（可选）

```bash
# 一定要先看清单再发！
npm pack --dry-run

# 真的打一个包出来，本地解压检查
npm pack
tar -tzf dsh-curator-0.2.0.tgz

# 确认无误再发
npm publish --access public   # 无作用域包其实不需要 --access，加上也无害
```

**发之前逐项确认**：

- [ ] `version` 是这次要发的号，且 npm 上**没有**同号（npm 不允许覆盖已发布版本）
- [ ] `files` 白名单正确。实测当前打包内容 = **8 个文件**：`package.json` / `LICENSE` /
      `README.md` / `CHANGELOG.md` / `cordis.patch.yml` / `docs/UPGRADE-RISKS.md` /
      `lib/client.js` / `lib/index.js`，约 240 kB。
      `RELEASING.md` / `DESIGN.md` / `test/` / `docs/screenshots/` **不进包**（截图是给
      README 用的，走 GitHub raw URL，所以 npm 页面上也能显示）
- [ ] 包解压后**能直接用**：`package.json` 的 `main` / `exports` / `dsh.bundle.patch` 指向的文件都在包里
- [ ] `repository` 字段已填（✅ 现在有），并和仓库地址一致

发完立刻验证：

```bash
npm view dsh-curator          # 能看到版本就成功了
npm i -g dsh-curator@0.2.0    # 或者装一次试试
```

### 8.4 发布后 5 分钟内的检查

- [ ] npm 页面能打开，README 渲染正常（**中文 README 里的相对链接和图片路径在 npm 上会失效**，要在 `README.md` 里用绝对 URL 或干脆不放图）
- [ ] GitHub 仓库首页能打开，`LICENSE` 被识别（右上角显示 "MIT license"）
- [ ] Release 页面能看到
- [ ] 从干净的临时目录 `dsh plugin add "link:<clone 路径>"` 装一次，确认**真的能装上**（别只信本地开发环境）

---

## 9. 发布之后

### 用户怎么拿到更新

| 分发方式 | 用户更新方式 |
|---|---|
| 从 GitHub 装（`link:`） | `git pull` |
| 从 npm 装 | `npm update` / 重新 `dsh plugin add dsh-curator@latest` |
| DSH 插件市场 | 看市场同步策略 |

你要做的是：**改完 → 升版本 → 更新 CHANGELOG → 打 tag → 发 Release（+ 可选 npm publish）**。别只 push 代码不升版本 —— 用 npm 装的人永远拿不到。

### 长期维护的最低要求

1. **别删已发布的版本**（npm 侧实际也删不掉）。发错了只能发新版本覆盖，或 `npm deprecate` 标记。
2. **响应 issue**。第一次开源最容易犯的错是"发完就不管"，反而伤口碑。
3. **CI（已具备条件）**：仓库里已经有 `npm test`（`test/unit.mjs`，50 项、零依赖、
   不需要运行 DSH），可以直接接 GitHub Actions：
   ```yaml
   - run: npm test
   ```
   完整的回归（真 DSH 接口 + jsdom 真渲染 + 真 registry）仍在开发工作区，不随包发布；
   想把它们也搬进来，优先搬"纯函数切片"那一类（成本最低，已经搬了版本比较与失败文案）。

---

## 10. 一页检查清单

**动手前**
- [ ] `git config user.name` / `user.email` 已从 `local <dev@local>` 改掉
- [ ] GitHub 账号 + 2FA 已开
- [ ] 决定 `LICENSE` 署名写谁（现在：`dsh-curator contributors`）
- [ ] 决定仓库名：用 `dsh-curator`（**别用 `dsh-skill-station`**，见 §2.2）
- [ ] 决定去哪发：只 GitHub / 只 npm / 两个都发

**发之前**
- [ ] `npm test` 通过（双端语法 + 打包完整性 + 安全红线 + 纯函数，50 项）
- [ ] `README.md` 里的安装命令、功能表、配置键名与实际一致
- [ ] `CHANGELOG.md` 有这次版本的内容（版本号与 `package.json` 一致）
- [ ] `npm pack --dry-run` 的清单里没有测试、脚本、本机路径
- [ ] 没有密钥、token、内网地址被提交（`npm test` 里已含这几条 grep）
- [ ] 代码里**没有残留的旧名字**：`grep -rn "skill-station\|dsh-skill-deck" lib/ cordis.patch.yml package.json` 应只在注释里说明历史时出现
- [ ] `docs/screenshots/` 里的图能被 README 的绝对 URL 打开（仓库切到 public 之后再点一次）

**发出后**
- [ ] npm 页面 / GitHub 首页都能打开
- [ ] 从干净目录真装一次成功
- [ ] `repository` 字段补上并重发一次（或等下次版本一起）

---

## 附：本次发布前完成的审计修复

供下次审计对照，这些是在 2026-10-11 那轮改掉的：

1. **README 链接协议白名单缺失**（真问题）：第三方技能的 README 里 `<a href="javascript:...">` 会被原样渲染成可点链接，点击即在同源执行脚本。已加 `safeHref` / `safeImageSrc`，并对浏览器会忽略的嵌入控制字符做了同样的清洗（`java\tscript:` 这类绕过也挡住）。插件市场页的 `p.url` 同一处修掉。
2. **可见性路由入参类型不严**：`enabled: "false"` 这种字符串会被判成 false，也就是**反向执行**（用户想开、结果关）。改成严格布尔校验，非布尔直接 400。
3. 细节：`catch {}` 空块补注释；外链统一 `rel="noreferrer noopener"`。

## 附：改名 `skill-station` → `dsh-curator`（同一天稍后）

包名、仓库名、插件 id、`$DSH_HOME` 数据目录四处统一。**没有任何对外接口被破坏**，因为当时还没发布。

改到的位置（**下次再改名照这张单子走**）：

| 位置 | 内容 |
|---|---|
| `lib/index.js` | 插件 id 1 处 + `$DSH_HOME` 数据目录 14 处 + 日志前缀 + 路由前缀 34 处 |
| `lib/client.js` | 面板 id / `data-dsh-plugin` / 日志前缀 5 处 + 路由前缀 30 处 |
| `cordis.patch.yml` | `id` 与 `name` 两行 |
| `package.json` | `name`（顺带补 `plugin-management` 关键词、重写 description） |
| `LICENSE` / `README.md` / `CHANGELOG.md` / `RELEASING.md` | 署名与所有路径引用 |
| **profile**（仓库之外，容易漏） | `~/.dsh/profiles/<profile>/package.json` 的依赖键与 `dsh.profile.bundles` 条目；`pnpm-lock.yaml`；`node_modules/<包名>` 软链；`cordis.patch.yml` 里的 HMR root 路径 |
| **用户数据**（仓库之外，漏了会丢东西） | `$DSH_HOME/skill-station/` → `$DSH_HOME/dsh-curator/`，含 `analyses.json`（AI 分析结果）/ `translations.json` / `config.json` / `backups/` / `cache/` |

**⚠️ 两条容易踩的**：

1. `replace_all` 旧名时要先检查有没有**更长的同名串**。本项目里 `skill-station` 是 `dsh-skill-station` 的子串，而 `dsh-skill-station` 是**别人的 npm 包名**（见 §2.2），无脑全局替换会把它改成 `dsh-dsh-curator`。所以 `RELEASING.md` / `cordis.patch.yml` **只能手改**，不能用全局替换。
2. 数据目录要**搬**不要**重建**。重建等于把用户的 AI 分析缓存和回收站清空。
   本次实测：`analyses.json` 123 KB + `translations.json` 99 KB，搬完后 `diff -r` 为空才算成。

