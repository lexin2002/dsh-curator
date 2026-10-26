# 升级风险与应对（UPGRADE-RISKS）

> 一句话：curator 的插件管理**写操作全部在官方 `pluginManager` 手里**，那是官方内部接口、
> 不承诺版本间稳定。这份文档回答三件事：**下次 DSH 更新可能坏在哪**、**30 秒怎么判定**、
> **改哪个文件怎么修**；以及我们为此加的三道防线（契约自检 / 升级前快照 / 回读校验）。
>
> 维护方式：每次 DSH 升级后按 §4 走一遍，红了的条目按 §3 对照修，修完把新经验补进本文。

---

## 1. 架构边界：谁负责什么

| 职责 | 归属 | 说明 |
| --- | --- | --- |
| 依赖清单 / `dsh.profile.bundles` / `cordis.patch.yml` 补丁层的**写入** | **官方** | `setBundleEnabled` / `removeBundle` / `installBundle`。curator 一行都不复刻 |
| 安装失败的回滚 | **官方** | `installBundle` 内部把 `package.json` + `pnpm-lock.yaml` 恢复原样 |
| 供应链 / peer 兼容闸门 | **官方** | `minimumReleaseAge`（24h）、`allow-version` 例外、构建脚本审批 |
| **发现新版本** | **curator** | 官方没有这个能力。宿主端点 `POST /api/dsh-curator/plugin-updates` 问 registry 的 `dist-tags.latest` |
| 更新动作的编排 | **curator** | 官方只有"先卸载再装"，编排（卸→装→回读→回滚）+ 精确版本 + 原启停状态在 curator |
| 失败文案 / 中文 | **curator** | `humanizeFailure()` |
| 升级前本地快照 / 恢复 | **curator** | `POST /api/dsh-curator/backups`、`/backups/restore` |
| 技能库 / 技能市场 / AI 分析 | **curator 自研** | 不依赖官方 remote，不受本文风险影响 |

结论：**官方一改，最可能坏的是"插件页的四个动作"和"可更新标记"，不会影响技能侧。**

---

## 2. 我们依赖的官方契约（7 条）

逐条都有探针（§8）。少一条 = 对应功能静默失效。

| # | 契约 | 用在哪 | 破了会怎样 |
| --- | --- | --- | --- |
| C1 | `remote.pluginManager` 被注入，且 `listBundles / registries / inspect / installBundle / removeBundle / setBundleEnabled` 都是函数 | 全插件页 | 整块提示"官方插件管理器不可用" |
| C2 | `listBundles()` 返回数组，非内置行带 `name` + `version` + `enabled` 布尔 | 已装列表、回读校验、原启停状态 | 更新无法核对版本 / 开关状态错 |
| C3 | `inspect(已装包名)` 返回 `{ status: "refused", problem: "already-installed" }` | 我们据此**不用**它查更新 | 若改成会返回版本：我们的 registry 路径仍可用（只是多一层）；若改成抛错：新建安装会走异常分支 |
| C4 | `registries()` 返回 `{ registry: string\|null, fallbackRegistries: string[] }`（`registry: null` = 用 pnpm 自己配的那个） | 查更新时决定问哪个 registry、什么顺序 | 顺序错 → 镜像滞后时把旧版当最新；私有源可能被漏到公共源 |
| C5 | `installBundle(spec, { enabled, requestId, saveExact })` 接受这四个选项 | 升级时钉死版本、保留启停 | 传了不认的选项 → 安装报错 |
| C6 | `ChangeResult.value.application ∈ { applied, restart-required, overridden, failed, cancelled }` | 判断成功/失败 | 新状态出现时不能被当成成功（已用白名单兜住） |
| C7 | 前端插槽名 `sidebar.panellist` / `main` / `conversation.input.left` 仍存在 | 面板入口与主体 | 入口消失或白屏 |

---

## 3. 下次更新可能出现的问题预测

按"概率 × 影响"排序。**R1-R4 是我们最该先看的四条。**

| 编号 | 预测的问题 | 现象 | 30 秒判定 | 概率 |
| --- | --- | --- | --- | --- |
| R1 | remote 方法改名 / 移除（如 `inspect` → `resolve`） | 插件页动作报"官方插件管理器不可用"或某个按钮全废 | 契约自检 | 中 |
| R2 | `inspect` 语义变化（开始对已装包返回版本/抛错） | 新建安装行为变；查更新不受影响 | 契约自检 C3 条 | 中 |
| R3 | `listBundles` 行字段改名（`version`→`installedVersion` 等） | 列表版本空、更新永远"已是最新"、升级后"更新没生效" | 契约自检 C2 条 | 中 |
| R4 | `ChangeResult.application` 新增状态 | 以前会**谎报成功**（已用白名单堵住），现在会明确报"没见过的状态" | 契约自检 C6 条 | 低-中 |
| R5 | `installBundle` 选项收紧（不再收 `saveExact` / 多一个必填） | 升级安装报参数错误 | 契约自检 C5 条 | 低 |
| R6 | 补丁层 `cordis.patch.yml` 的 `disabled` 语义/缩进规则变化 | 开关显示"开"但插件没加载，或反过来 | 面板列表的"被配置覆盖"徽标 + `test-behavior` | 低 |
| R7 | 前端插槽名或 `/plugins/<id>/client.js` 服务路径变化 | 左侧没有面板入口 / 点开白屏（控制台 404） | 刷新页面看 Console | 低-中 |
| R8 | pnpm 供应链策略默认值变化（24h 窗口改成 48h 等） | 更新被拦，提示"发布不满 N 小时" | 提示文案里就有 N | 低 |
| R9 | profile 目录结构变化（`$DSH_HOME/profiles/<name>` / 锚点文件） | 插件列表 0 条；快照说"没有可备份的文件" | `GET /api/dsh-curator/plugins` 看 total | 低 |
| R10 | 官方新增"查最新版本"API | ——（好消息） | 读官方 README / 契约自检里 C3 变红 | 低 |

### R1 remote 方法改名 / 移除

- **现象**：插件页顶部出现"官方插件管理器不可用（这个部署没加载它）"；或单个动作报 `xxx is not a function`。
- **判定**：
  ```powershell
  node C:\Users\lexin\Documents\deepseek-harness\default-workspace\tools\test-official-contract.mjs
  ```
  看哪条 `method.*` 红了。
- **修法**：改 `lib/client.js` 的 `officialPluginApi()`（方法存在性检查）和对应调用点；
  若官方把方法挪到了另一个服务（例如 `remote.pluginManager2`），同步改 `apply()` 里的
  `inject` 名单与 `can["remote.pluginManager"]` 探测。
- **不要**自己补一套 pnpm 兜底（历史教训：会和官方抢状态，见 CHANGELOG `a9e7412`）。

### R2 `inspect` 语义变化

- **现象**：契约自检的 `inspect.installed` 变红（返回 `accepted` 或直接抛错）。
- **判定**：同上，看 `actual` 字段。
- **修法**：
  - 若官方开始**返回最新版本**：可以把 `officialCheckUpdates` 改回"官方优先、registry 补缺"，
    少一层自研；但**不要删掉 registry 路径**（官方对 `link:`/git 依赖仍然答不了）。
  - 若官方改成**抛错**：`officialInstall` 里对 `inspect` 的 try/catch 要保留并降级为"跳过预检直接装"。

### R3 `listBundles` 字段改名

- **现象**：插件列表里版本列空；或者"检查更新"永远 0 个；或者升级后提示"更新没生效"。
- **判定**：契约自检 `listBundles.version` / `listBundles.enabled` 变红。
- **修法**：改两处读取点（都在 `lib/client.js`）：
  - `officialCheckUpdates()` 里建 `installed` Map 的那几行；
  - `officialUpdate()` 里的 `bundleRow()`。
  建议同时改成一个共用的小函数 `readBundleRow(row)`，避免两处再次分叉。

### R4 `application` 新增状态

- **现象**：操作后提示"官方返回了没见过的结果状态「xxx」"。
- **判定**：提示原文就是判定。契约自检 C6 条（`application` 枚举）目前是软检查，
  以提示为准。
- **修法**：先查官方 README 里这个状态的含义；确认是"成功了但被覆盖"才加进
  `officialOutcome()` 的白名单，**默认按失败处理**。

### R5 `installBundle` 选项变化

- **现象**：升级/安装报 `invalid-options` 之类；或装完版本没钉住（`package.json` 变成 `^x.y.z`）。
- **判定**：看报错原文；`dsh plugin --profile desktop why <包名>` 看锁定版本。
- **修法**：改 `officialUpdate()` 里 `installBundle(spec, {...})` 的选项对象；
  `saveExact` 没了就只能装完自己改 `package.json`（不推荐，优先找官方新选项）。

### R6 补丁层格式变化

- **现象**：开关是"开"但徽标"未加载"；或"被配置覆盖"徽标误报。
- **判定**：`test-behavior`（11 项）里的 `readPatchDisabled` 相关断言；或直接看
  `~/.dsh/profiles/desktop/cordis.patch.yml` 的实际结构。
- **修法**：改 `lib/index.js` 的 `readPatchDisabled()` 正则（只认顶格 `- id:` 块里缩进两格的
  `disabled:`）。这是历史上修过两次的地方，别放宽到"任意缩进"。

### R7 前端插槽 / 资源路径变化

- **现象**：刷新后左侧没有 curator 图标；或点开白屏，Console 里 `client.js` 404。
- **判定**：打开开发者工具 Network，看 `/plugins/dsh-curator/client.js` 是否 200；
  Console 里有没有 `slot not found`。
- **修法**：改 `lib/client.js` 的 `apply()` 里三处 `ctx.slots.register({ name: ... })`；
  资源路径由宿主的 client-modules 决定，curator 不需要改（只依赖 package.json 的 `dsh.client` 声明）。

### R8 pnpm 供应链策略变化

- **现象**：更新报"发布还不满 N 小时"。
- **判定**：提示里带了 N 和包名。
- **修法**：不用改代码；等窗口过去，或用户自己在
  `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加该版本
  （这是明确的风险接受，curator 不代劳）。

### R9 profile 结构变化

- **现象**：插件列表 0 条；快照/恢复说"没有可备份的文件"。
- **判定**：
  ```powershell
  (Invoke-WebRequest http://127.0.0.1:51761/api/dsh-curator/plugins).Content
  ```
- **修法**：改 `lib/index.js` 的 `profileDirPath()` / `readProfileManifest()` /
  `listDshPlugins()` 三处路径推导（都基于 `resolveDshHome()` + `resolveProfileName()`）。

### R10 官方新增查更新 API

- **做法**：先读官方 README 的语义（是否对已装包返回版本、是否走 registry）；确认后把
  `officialCheckUpdates()` 改成"官方优先，registry 兜底"，并把契约自检加一条新检查。
  **不要**直接删 registry 路径 —— 它是 `link:`/git 依赖与旧版 DSH 的唯一退路。

---

## 4. DSH 升级之后的标准动作（SOP）

按顺序做，**先确认"面板还活着"，再确认"能力还在"**：

1. **刷新页面**，打开插件页：左侧有图标、能列出 17 个插件、能点开详情。
2. **契约自检**（30 秒，最重要）：
   ```powershell
   node C:\Users\lexin\Documents\deepseek-harness\default-workspace\tools\test-official-contract.mjs
   ```
   期望 `13 passed / 0 failed`。红了 → 直接看 §3 对应条目。
3. **查更新**：点「检查更新」，期望能报出可更新条数（不是"已是最新"）。
4. **回归**（约 2 分钟）：
   ```powershell
   cd C:\Users\lexin\Documents\deepseek-harness\default-workspace
   node dsh-frontend-env\test-behavior.mjs
   node dsh-frontend-env\test-update-check.mjs
   node dsh-frontend-env\test-update-apply.mjs
   node dsh-frontend-env\test-backup-ui.mjs
   node dsh-frontend-env\test-ui-simplify.mjs
   node tools\test-humanize-failure.mjs
   node tools\test-version-outdated.mjs
   node tools\test-official-contract.mjs
   ```
5. **真动手前**：设置页点一次「立即备份」，确认能列出来、能恢复（恢复会重装依赖，约 1-5 秒）。

> 只要第 2 步全绿，插件管理的四个动作和查更新就不会静默坏掉；
> 如果第 1 步就白屏，那是 R7（前端插槽/资源），与官方数据无关，改插槽名即可。

---

## 5. 插件升级 SOP（日常操作）

1. **分批**：先低风险（工具类，如 `dsh-free-search`、`dsh-read-url`）；
   面板自身（`dshmarket`、`dsh-curator`）最后单独做。
2. **24 小时窗口**：发布不满 24 小时的版本会被 pnpm 拦；提示里会写包名，等就行。
3. **升级前快照自动生成**（每次点「更新」都会）。想额外留一份就在设置页点「立即备份」。
4. **看回执，不看按钮变灰**：
   - 成功 → `已更新，重启 DSH 后加载新版本`；
   - 版本没动 → `更新没生效：磁盘上还是 vX，目标是 vY`；
   - 失败 → 原文原因（已人话化）+ 是否已回滚旧版本。
5. **重启后自检**：插件页版本号是否真的变了；开关是否仍是原来的状态（升级会保留启停）。
6. **`allow-version` 不要顺手点**：那是"我接受这个版本与当前 DSH 不兼容的风险"，
   只有你确认知道后果时才做。

---

## 6. 回退手册（三档粒度）

### A. 整份 profile 回退（推荐，一次点击）

设置页 →「快照与恢复」→ 选一张 →「恢复」。宿主会：

1. 先自动拍一张"恢复前"快照（**所以这一步本身可逆**）；
2. 校验快照文件 sha256（半截文件不写）；
3. 把 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` / `compatibility.json` 写回；
4. 跑 `dsh plugin --profile <名> install --frozen-lockfile` 把 `node_modules` 拉回 lockfile 的样子；
5. 提示重启 DSH。

### B. 单个插件回退（只想要老版本，不想整份退）

```powershell
# 先备份（等价于设置页的「立即备份」）
$body = '{"reason":"manual","label":"before rollback"}'
Invoke-WebRequest http://127.0.0.1:51761/api/dsh-curator/backups -Method POST -ContentType 'application/json' -Body $body

# 钉回老版本（官方 CLI，等价于面板的「更新」但目标是你指定的版本）
dsh plugin --profile desktop add dsh-free-search@0.9.11
```

然后重启 DSH。（面板不提供"降级"按钮：降级是有意为之的操作，不该被误点。）

### C. 极端情况：DSH 起不来 / 面板打不开

不需要打开 DSH，直接命令行把文件退回去：

```powershell
$profile = "C:\Users\lexin\.dsh\profiles\desktop"
$snap = "C:\Users\lexin\.dsh\dsh-curator\backups\<快照 id>"
Get-ChildItem $snap -File | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $profile $_.Name) -Force
}
cd $profile
dsh plugin --profile desktop install --frozen-lockfile
```

`<快照 id>` 就是 `backups` 目录下的文件夹名（形如 `1792996330886-before-update`）。

### D. 连快照都没有

`pnpm-lock.yaml` 里记录了每个包解析到的确切版本，`package.json` 是声明：
先把这两个文件改成你记得的样子，再 `dsh plugin --profile desktop install --frozen-lockfile`。
实在不行，删掉 `node_modules` 重装（`pnpm install`），再把 `dsh.profile.bundles` 里不想要的插件去掉。

---

## 7. 已知缺点与补全状态

| # | 缺点 | 现状 | 说明 |
| --- | --- | --- | --- |
| D1 | 查更新只覆盖 registry 版本依赖 | **设计如此** | `link:` / `file:` / git 依赖的版本由源头决定，问 registry 只会造出"本地插件永远可更新"的假信号 |
| D2 | 未知错误截到 300 字 | 已补 | 优先保留 `ERR_*` / error 行；已知类型全部翻成完整人话（见 `test-humanize-failure`） |
| D3 | 恢复要联网重装依赖 | 已提示 | 断网时只能写回文件、`node_modules` 保持原样；提示里会说 |
| D4 | 快照只存 4 个状态文件 | **设计如此** | 不存 `node_modules`（几个 G，且 lockfile 可重建）；不备份技能库与 AI 缓存（它们不在 profile 里） |
| D5 | 装完重启才发现坏，没有自动回滚 | 已知，未做 | 自动回滚需要"重启后自检 + 自动触发恢复"，跨进程且风险高；目前靠升级前快照 + 一键恢复 |
| D6 | `restoreInFlight` 只防本进程并发 | 已知 | 多窗口同时点恢复仍可能撞；文件写入是原子的单个 copyFile，最坏是两份快照互相覆盖，可用"恢复前快照"退回 |
| D7 | 没有"更新前影响预览"（这个插件被谁依赖） | 已知，未做 | `listPlugins()` 能算出 closure，但会把面板变复杂；暂不做 |
| D8 | 契约自检不覆盖前端插槽 | 已知 | 插槽破了表现为白屏，肉眼可见，不值得做自动探针 |
| D9 | `humanizeFailure` 是基于正则的 | 已知 | 官方/pnpm 改措辞就退化成"挑错误行"兜底；不会崩，只是不够好读 |
| D10 | 官方若新增"更新"API，我们这套自研就多余 | 已写进 R10 | 届时应切换，但保留 registry 兜底 |

---

## 8. 防线清单（新增的三道 + 已有测试）

| 防线 | 位置 | 作用 |
| --- | --- | --- |
| **契约自检端点** `GET /api/dsh-curator/official-contract` | `lib/index.js` → `official-contract` 路由；测试 `tools/test-official-contract.mjs` | 把"我们依赖的官方语义"逐条问运行中的宿主，13 项；DSH 升级后一跑就知道语义有没有变 |
| **升级前快照** | `lib/index.js` → `createSnapshot` / `restoreSnapshot`；`POST /api/dsh-curator/backups`、`/backups/restore`；前端 `doUpdate` 自动调用 | 跨进程、跨重启的兜底；官方的回滚只覆盖单次 install 内部失败 |
| **装完回读 + 失败回滚** | `lib/client.js` → `officialUpdate()` | 装完再读 `listBundles` 的真实版本，不变就报"更新没生效"；失败把旧版本装回 |
| **application 白名单** | `lib/client.js` → `officialOutcome()` | 官方新增状态不会被当成成功（防"提示成功但没生效"） |
| **registry 顺序与官方一致** | `lib/client.js` → `officialRegistries()` | 私有源不会被漏到公共源；镜像滞后时不会把旧版当最新 |
| 回归测试 | `dsh-frontend-env/test-*.mjs`、`tools/test-*.mjs` | 查更新 19、更新动作 18、快照 16、行为 11、UI 30、文案 19、版本 31、契约 13 |

历史上踩过、现在有测试钉住的四个坑（别再犯）：

1. **拿官方 `inspect` 查更新** → 对已装包一律 refused，界面永远"已是最新"（`d383646`）。
2. **版本比较截断成主版本号** → 同主版本更新全漏（`test-version-outdated`）。
3. **`pnpm add` 不带版本号** → caret 范围内什么都不装却返回成功（`test-update-apply` 第 1 组）。
4. **测试桩照着想象写** → `inspect` 返回了现实中不存在的 `accepted`，绿灯掩盖了 100% 失效
   （`test-behavior` / `test-ui-simplify` 已改成真实行为）。
