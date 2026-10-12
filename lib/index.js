/**
 * dsh-curator — host 半边。
 *
 * 四个能力，全部由可视化配置驱动（配置落 $DSH_HOME/dsh-curator/config.json）：
 *
 *   1. 技能来源管理——增删改 + 启停，扫描本机各 coding agent 的技能目录
 *   2. 三类区分——harness 用户库 / 其他 agent 的 / 共享池，各带导入按钮
 *   3. 中文翻译——**默认关闭**，需在设置里显式开启并填端点；结果落本地缓存
 *   4. 技能市场——SkillHub + ClawHub 双源，分类、排序、分页、安装
 *
 * @module dsh-curator
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dsh-curator'

/**
 * 本插件自己的 npm 包名，启动时从自身 package.json 读一次。
 * 「不许在面板里停用自己」要用它来判断——写死字符串的话，包一改名就会漏改，
 * 用户就能把自己的管理入口关掉、再也开不回来。
 */
const SELF_PACKAGE_NAME = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.name === 'string' ? pkg.name : ''
  } catch {
    return ''
  }
})()

/**
 * 需要的宿主服务。
 * llm + agentDefaultModel 是「用 Harness 当前模型跑 AI 分析」用的——不声明
 * 就拿不到（cordis 会抛 cannot get property "llm" without inject），
 * 这也是之前宿主通道一直空转的原因。webServer 之外的服务缺了不影响其余功能。
 */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/* ------------------------------------------------------------------ *
 * paths & defaults
 * ------------------------------------------------------------------ */

/** DSH 家目录（与宿主 dsh-home 同规则）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 当前 profile 名。
 * 桌面端是 `desktop`，但 DSH 支持多个 profile（本机就并存 desktop 和 web）。
 * 写死 `desktop` 的话，在别的 profile 上运行的 DSH 里，插件启停 / 卸载 /
 * 按包名安装 / 重启会全部失效——它们读的 profile 清单根本不存在。
 * 宿主会把当前 profile 名放在 DSH_PROFILE 里；取不到就沿用历史默认值。
 */
function resolveProfileName() {
  const fromEnv = process.env.DSH_PROFILE?.trim()
  return fromEnv || 'desktop'
}

/** 展开 `~` 前缀。 */
function expandHome(value) {
  const raw = String(value ?? '').trim()
  if (raw === '' || raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/** 把绝对路径缩成 `~` 形式，便于显示。 */
function tildify(path) {
  const home = homedir()
  const p = resolve(String(path))
  return p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p
}

export function configPath() {
  return join(resolveDshHome(), 'dsh-curator', 'config.json')
}

export function cachePath() {
  return join(resolveDshHome(), 'dsh-curator', 'analyses.json')
}

/** 旧版缓存文件名（功能原名 translate），load 时做一次性迁移。 */
export function legacyCachePath() {
  return join(resolveDshHome(), 'dsh-curator', 'translations.json')
}

/** DSH 用户库——收编后的技能都落这里，模型才看得到。 */
function harnessSkillsDir() {
  return join(resolveDshHome(), 'skills')
}

/** 已知 agent 的显示名。 */
const SOURCE_LABELS = {
  workbuddy: 'WorkBuddy',
  hermes: 'Hermes',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  lingma: '通义灵码',
  codebuddy: 'CodeBuddy',
  doubao: '豆包',
  molili: 'Molili',
  reasonix: 'Reasonix',
  opencode: 'OpenCode',
  windsurf: 'Windsurf',
  cline: 'Cline',
  roo: 'Roo Code',
  zed: 'Zed',
}

/** 自动发现时要跳过的家目录项（不是 agent 技能目录）。 */
const SKIP_HOME_DIRS = /^(cache|config|npm|pnpm|gradle|cargo|rustup|conda|anaconda|ssh|vscode|vscode-shared|android|bun|local|venv.*|matplotlib|streamlit|cili-test|echobird|fntv|objection|dsh-wallpaper-engine|workbuddy-key-fallback|dsh-market|mcp)$/i

/** 出厂默认配置。 */
function defaultConfig() {
  const home = homedir()
  return {
    version: 1,
    /** 技能来源。type 决定它在界面上归到哪一类。 */
    sources: [
      { key: 'dsh', label: 'DSH 用户库', path: tildify(harnessSkillsDir()), enabled: true, type: 'harness', builtin: true, readonly: true },
      { key: 'agents', label: 'Agents 共享池', path: '~/.agents/skills', enabled: true, type: 'shared', builtin: true, readonly: false },
      ...autoDiscoverSources(home),
    ],
    /** AI 分析：默认走宿主模型（零配置）；也可以切到自定义 OpenAI 兼容端点。 */
    analyze: {
      /** 'host' = 用 Harness 当前模型（推荐）；'endpoint' = 自定义端点 */
      mode: 'host',
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      batchSize: 1,
      concurrency: 1,
      /** 0 = 不发送 max_tokens，由端点自定上限（有些模型给大了会直接 400） */
      maxTokens: 16000,
      timeoutMs: 120000,
      useHostFallback: true,
      /** 分析结果缓存条数上限，超了按时间淘汰最旧的 */
      cacheMaxEntries: 5000,
    },
    market: {
      skillhubApiBase: 'https://api.skillhub.cn',
      clawhubApiBase: 'https://clawhub.ai',
      defaultSource: 'skillhub',
      pageSize: 24,
    },
    scan: {
      depth: 3,
      maxPerSource: 500,
    },
  }
}

/** 自动发现家目录下遵循 `~/.xxx/skills` 约定的来源。 */
function autoDiscoverSources(home) {
  const found = []
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.')) continue
      const key = entry.name.slice(1)
      if (SKIP_HOME_DIRS.test(key)) continue
      const skillsDir = join(home, entry.name, 'skills')
      if (!statSyncSafe(skillsDir)) continue
      found.push({
        key,
        label: SOURCE_LABELS[key] ?? key,
        path: `~/${entry.name}/skills`,
        enabled: true,
        type: 'external',
        builtin: false,
        readonly: false,
      })
    }
  } catch {
    // 家目录不可读就返回空
  }
  return found
}

/** 同步判断目录是否存在（仅用于生成默认配置）。 */
function statSyncSafe(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * config store（带 mtime 校验的轻量缓存）
 * ------------------------------------------------------------------ */

class ConfigStore {
  constructor(path) {
    this.path = path
    this.data = undefined
    this.mtime = 0
  }

  /** 读取配置；文件不存在则写入默认值。 */
  async load() {
    try {
      const info = await stat(this.path)
      if (this.data !== undefined && info.mtimeMs === this.mtime) return this.data
      const text = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(text)
      this.data = normalizeConfig(parsed)
      this.mtime = info.mtimeMs
      return this.data
    } catch {
      if (this.data !== undefined) return this.data
      this.data = defaultConfig()
      await this.save(this.data)
      return this.data
    }
  }

  /** 原子保存。 */
  async save(next) {
    const normalized = normalizeConfig(next)
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    // 配置里有 API Key：POSIX 下限制成仅本人可读（Windows 走用户目录 ACL）
    await writeFile(tmp, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.path)
    this.data = normalized
    try {
      this.mtime = (await stat(this.path)).mtimeMs
    } catch {
      this.mtime = 0
    }
    return normalized
  }
}

/** 补齐缺失字段，剔除脏值；不做过度校验（配置是用户自己的）。 */
function normalizeConfig(input) {
  const base = defaultConfig()
  const raw = input && typeof input === 'object' ? input : {}
  const sources = Array.isArray(raw.sources) ? raw.sources : base.sources
  // 兼容旧配置键：这个功能早期叫 translate，读到旧键也认，写回一律用 analyze
  const rawAnalyze = raw.analyze ?? raw.translate ?? {}
  return {
    version: 1,
    sources: sources
      .filter((s) => s && typeof s === 'object' && typeof s.path === 'string' && s.path.trim() !== '')
      .map((s, index) => ({
        key: String(s.key ?? `source-${index}`),
        label: String(s.label ?? s.key ?? `source-${index}`),
        path: String(s.path),
        enabled: s.enabled !== false,
        type: ['harness', 'shared', 'external'].includes(s.type) ? s.type : 'external',
        builtin: s.builtin === true,
        readonly: s.readonly === true,
      })),
    analyze: {
      // 老配置（填过端点、没写 mode）保持走端点，不惊吓；新装/没端点的默认宿主模型
      mode:
        rawAnalyze.mode === 'endpoint' || rawAnalyze.mode === 'host'
          ? rawAnalyze.mode
          : String(rawAnalyze.baseUrl ?? '') !== ''
            ? 'endpoint'
            : 'host',
      enabled: rawAnalyze.enabled === true,
      baseUrl: String(rawAnalyze.baseUrl ?? ''),
      apiKey: String(rawAnalyze.apiKey ?? ''),
      model: String(rawAnalyze.model ?? ''),
      batchSize: clampInt(rawAnalyze.batchSize, 1, 40, base.analyze.batchSize),
      concurrency: clampInt(rawAnalyze.concurrency, 1, 10, base.analyze.concurrency),
      // 允许 0：表示不发送 max_tokens，交给端点决定
      maxTokens: clampInt(rawAnalyze.maxTokens, 0, 65536, base.analyze.maxTokens),
      timeoutMs: clampInt(rawAnalyze.timeoutMs, 5000, 300000, base.analyze.timeoutMs),
      useHostFallback: rawAnalyze.useHostFallback !== false,
      cacheMaxEntries: clampInt(rawAnalyze.cacheMaxEntries, 200, 500000, base.analyze.cacheMaxEntries),
    },
    market: {
      skillhubApiBase: String(raw.market?.skillhubApiBase ?? base.market.skillhubApiBase),
      clawhubApiBase: String(raw.market?.clawhubApiBase ?? base.market.clawhubApiBase),
      defaultSource: raw.market?.defaultSource === 'clawhub' ? 'clawhub' : 'skillhub',
      pageSize: clampInt(raw.market?.pageSize, 6, 60, base.market.pageSize),
    },
    scan: {
      depth: clampInt(raw.scan?.depth, 1, 6, base.scan.depth),
      maxPerSource: clampInt(raw.scan?.maxPerSource, 10, 5000, base.scan.maxPerSource),
    },
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 脱敏：只留头尾，够用户确认"填了哪个 key"。 */
function maskKey(key) {
  const s = String(key ?? '')
  if (s === '') return ''
  if (s.length <= 10) return '***'
  return `${s.slice(0, 5)}***${s.slice(-4)}`
}

/** 给前端看的配置（key 脱敏）。 */
function publicConfig(config) {
  return {
    ...config,
    analyze: { ...config.analyze, apiKey: maskKey(config.analyze.apiKey), hasApiKey: config.analyze.apiKey !== '' },
  }
}

/** 错误信息里把 API Key 抹掉，避免端点回显导致密钥飘到界面上。 */
function redactKey(text, apiKey) {
  const s = String(text ?? '')
  const key = String(apiKey ?? '')
  if (key.length < 8) return s
  return s.split(key).join('***')
}

/* ------------------------------------------------------------------ *
 * frontmatter / skill scanning
 * ------------------------------------------------------------------ */

/**
 * 极简 frontmatter 解析：支持标量、引号、以及 YAML 折叠块（`key: >` / `key: |`）。
 * 折叠块很关键——不少技能的 description 就是多行写法，只取第一行会得到 `>`。
 */
export function parseFrontmatter(text) {
  const out = {}
  const raw = String(text ?? '')
  if (!raw.startsWith('---')) return out
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return out
  const lines = raw.slice(3, end).split(/\r?\n/)
  let blockKey
  let blockLines = []
  let blockFolded = false

  const flushBlock = () => {
    if (blockKey === undefined) return
    const joined = blockFolded ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n').trim()
    if (joined !== '') out[blockKey] = joined
    blockKey = undefined
    blockLines = []
  }

  for (const line of lines) {
    if (blockKey !== undefined) {
      if (line === '' || /^\s/.test(line)) {
        blockLines.push(line.trim())
        continue
      }
      flushBlock()
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    const rawValue = m[2].trim()
    if (rawValue === '>' || rawValue === '|' || rawValue === '>-' || rawValue === '|-') {
      blockKey = key
      blockFolded = rawValue.startsWith('>')
      blockLines = []
      continue
    }
    let value = rawValue
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  flushBlock()
  return out
}

/** 判断文本是否以中文为主。 */
function looksChinese(text) {
  const s = String(text ?? '')
  if (s === '') return false
  const chars = [...s]
  let cjk = 0
  for (const ch of chars) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x3400 && cp <= 0x9fff) cjk++
  }
  return chars.length > 0 && cjk / chars.length > 0.2
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 在 root 下递归找含 SKILL.md 的技能目录。 */
async function collectSkillDirs(root, depth, max) {
  const out = []
  // 原生 DeepSeek Harness 的技能市场会扫出全部（含 .archive 等归档目录），
  // 这里不跳过 . 开头目录，与原生对齐；只跳过明确的非技能元数据目录。
  const skipDirs = new Set(['.git', '.locks', '.tmp', 'node_modules', '__pycache__'])
  const walk = async (dir, level) => {
    if (level > depth || out.length >= max) return
    const entries = await safeReaddir(dir)
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(dir)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (skipDirs.has(entry.name)) continue
      if (out.length >= max) return
      await walk(join(dir, entry.name), level + 1)
    }
  }
  await walk(root, 0)
  return out
}

/* ------------------------------------------------------------------ *
 * 技能可见性：DSH 原生的 frontmatter 治理键
 *
 * 这两个状态一直存在技能自己的 SKILL.md 里，是 DSH 的内置能力
 * （@deepseek-ai/dsh-skill-filesystem 的 parseInvocationPolicy）：
 *
 *   disable-model-invocation: true → modelInvocable = false
 *      技能不进模型目录，模型不会自动看到它（用户仍可手动调用）
 *   user-invocable: false          → userInvocable = false
 *      不给用户显式调用（列表里也点不动）
 *
 * 判定规则与 DSH 逐字对齐：布尔原样；1/"1" → true；0/"0" → false；
 * 其余字符串按 true/yes/on 与 false/no/off 做大小写不敏感匹配；
 * 认不出的写法视为"没设置"，走默认值（两个都默认为 true）。
 *
 * ⚠️ 只能写上面这两个键。DSH 会**主动抛错**拒绝 `modelInvocable` /
 * `userInvocable` / `disableModelInvocation` 这几个看起来更顺手的写法
 * （rejectLegacyInvocationKey，报 "frontmatter field ... is unsupported"），
 * 写错键名会让技能直接加载失败 —— 这是本功能最容易犯、后果最重的错。
 * ------------------------------------------------------------------ */

/** 解析 DSH 风格的 frontmatter 布尔值；未设置或认不出时返回 undefined。 */
function frontmatterFlag(fm, key) {
  if (!Object.hasOwn(fm, key)) return undefined
  const value = String(fm[key] ?? '').trim()
  if (value === '1') return true
  if (value === '0') return false
  const lowered = value.toLowerCase()
  if (['true', 'yes', 'on'].includes(lowered)) return true
  if (['false', 'no', 'off'].includes(lowered)) return false
  return undefined
}

/**
 * 从 frontmatter 读可见性。
 * 两个键都没写时返回 undefined —— 前端据此不渲染开关（保持列表干净），
 * 而不是渲染两个"开着但没意义"的摆设。
 */
function readInvocation(fm) {
  const dmi = frontmatterFlag(fm, 'disable-model-invocation')
  const ui = frontmatterFlag(fm, 'user-invocable')
  if (dmi === undefined && ui === undefined) return undefined
  return { modelInvocable: dmi !== true, userInvocable: ui !== false }
}

/**
 * 改 SKILL.md 里的一个可见性键，其余 frontmatter 行与正文原样保留。
 *
 * value === undefined 表示"删掉这个键、回到默认"。两个键的默认值都是"可见"，
 * 所以把开关拨回开就删键而不是写 false —— 少留一个键，DSH 自带的技能页和
 * 第三方技能管理器读到的都是"没被治理过"的干净状态。
 *
 * frontmatter 压根不存在时，只有需要"关掉"（写 true）才新建一个块：
 * 为了打开一个默认就开的开关而凭空造 frontmatter 没有意义。
 */
function setFrontmatterFlag(content, key, value) {
  const text = String(content ?? '')
  const lines = text.split(/\r?\n/)
  const dropKey = new RegExp('^' + key + '\\s*:')
  if (lines[0] === undefined || lines[0].trim() !== '---') {
    if (value === undefined) return text
    return '---\n' + key + ': ' + (value === true ? 'true' : 'false') + '\n---\n\n' + text
  }
  let closer = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closer = i
      break
    }
  }
  // 前块没闭合（文件被改坏了）：原样返回，绝不把正文当成 frontmatter 处理
  if (closer === -1) return text
  const kept = lines.slice(1, closer).filter((l) => !dropKey.test(l.trim()))
  // 先收掉尾部空行，避免出现 `键` 挂在空行后面这种读起来莫名其妙的东西
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (value !== undefined) kept.push(key + ': ' + (value === true ? 'true' : 'false'))
  return [...lines.slice(0, 1), ...kept, ...lines.slice(closer)].join('\n')
}

/** 原子写：先写临时文件再 rename，避免中断时留下半个 SKILL.md。 */
async function atomicWrite(file, content) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/**
 * 注入开销估算。
 *
 * 技能的 name + description 会随技能目录一起注入模型上下文（正文按需加载，
 * 不计在内），这两个数就是它占的额度 —— 面板上用来回答"我装了这么多技能，
 * 光目录就吃掉多少上下文"。
 *
 * token 数是**无依赖的启发式估算**，没有引 js-tiktoken：
 *   - CJK（中日韩文字 + 全角标点）一字 ≈ 1 token；
 *   - 其余按 4 字符 ≈ 1 token（英文的常见经验值）。
 * 中文技能上这个规则与 cl100k 词表的偏差通常在个位数百分比，足够支撑
 * "哪个技能更占额度"的横向比较；绝对值只当量级参考。
 * 本插件是零依赖的（客户端连 npm 都拿不到，只能 require react），
 * 为了显示一个约等号而背一张分词表进来不划算。
 */
const USAGE_CJK_RE =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

function estimateUsage(name, description) {
  const text = String(name ?? '') + '\n' + String(description ?? '')
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (USAGE_CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  return { chars: text.length, tokens: cjk + Math.round(other / 4) }
}

/**
 * 读一个技能的元信息。
 *
 * 第二个参数是 DSH 用户库里**已存在的目录名集合**（小写）。
 * 「有没有导入过」必须按落盘目录名比对，不能按技能自己的路径：
 * 导入的落点是 `~/.dsh/skills/<safeFolderName(name, basename(dir))>`，
 * 而外部来源里的技能路径永远不在用户库下 —— 用路径判会把来源技能一律判成
 * "未导入"，那个判断此前就从来没生效过（前端「已在 DSH」徽章一直是死的）。
 * 这里改成和 importSkill 用同一把尺子（同一个 safeFolderName），
 * 于是「已在 DSH / 覆盖导入」「只看未导入」「批量导入的撞名策略」用的是同一个判据。
 */
async function readSkillMeta(dir, harnessFolders = new Set()) {
  const file = join(dir, 'SKILL.md')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const fm = parseFrontmatter(text)
  const description = String(fm.description ?? '').trim()
  const invocation = readInvocation(fm)
  const absolute = resolve(dir)
  const name = String(fm.name ?? basename(dir)).trim()
  const importFolder = safeFolderName(name, basename(absolute))
  return {
    id: createHash('sha1').update(absolute).digest('hex').slice(0, 12),
    name,
    description,
    descriptionIsZh: looksChinese(description),
    dir: absolute,
    chars: text.length,
    /**
     * SKILL.md 全文截断版（给解释用）：解释要看正文才知道实际能力和触发时机，
     * 只发 description 会漏掉正文里的关键信息。8KB 截断足够模型归纳。
     */
    fullText: text.slice(0, 8192),
    /** 导入后会落成的目录名（前端回显 / 排错用） */
    importFolder,
    /** 用户库里已有同名目录（决定"导入"按钮形态，以及"只看未导入"筛选） */
    imported: harnessFolders.has(importFolder.toLowerCase()),
    /**
     * 可见性。undefined = 技能没写这两个 frontmatter 键（走 DSH 默认：都可见）。
     * 字段名沿用 DSH 的 invocation.modelInvocable / userInvocable；
     * 但**写回磁盘时用的是 disable-model-invocation / user-invocable**，
     * 别把这两个名字当成可以直接写进 frontmatter 的键（会被 DSH 拒绝）。
     */
    modelInvocable: invocation?.modelInvocable,
    userInvocable: invocation?.userInvocable,
    /** 注入开销（name + description 的字符数 / token 估算） */
    usage: estimateUsage(name, description),
    /**
     * 同名来源：除了自己所在的位置，还有哪些来源/目录里有同名技能。
     * 用途是回答"这个技能从哪来的、删了之后还能不能找回来"（删除确认框要写清楚）。
     * 由 scanAll 统一回填，单点读元信息时没有这个信息。
     */
    alsoIn: [],
  }
}

/** 扫描所有启用的来源，按 type 分组返回。 */
async function scanAll(config) {
  const harnessDir = harnessSkillsDir()
  /**
   * 用户库顶层的目录名（小写）。导入的落点就是这里的 `<name>`，
   * 所以这一集合就是「哪些技能已经导入过」的权威判据 —— 与 importSkill
   * 里的 `existsSync(dest)` 判的是同一个东西，不需要真的去 stat 每一个。
   */
  const harnessFolders = new Set(
    (await safeReaddir(harnessDir)).filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()),
  )
  const enabled = config.sources.filter((s) => s.enabled)
  const groups = { harness: [], shared: [], external: [] }

  for (const source of enabled) {
    const root = resolve(expandHome(source.path))
    if (!(await isDir(root))) {
      groups[source.type]?.push({ ...source, path: tildify(root), skills: [], count: 0, missing: true })
      continue
    }
    const dirs = await collectSkillDirs(root, config.scan.depth, config.scan.maxPerSource)
    const skills = []
    for (const dir of dirs) {
      const meta = await readSkillMeta(dir, harnessFolders)
      if (meta) skills.push(meta)
    }
    skills.sort((a, b) => a.name.localeCompare(b.name))
    groups[source.type]?.push({
      key: source.key,
      label: source.label,
      path: tildify(root),
      type: source.type,
      readonly: source.readonly,
      skills,
      count: skills.length,
      missing: false,
    })
  }

  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
  // 同名来源索引：某个技能名在哪些来源/目录里出现过。
  //
  // 这是"反向链接"在本插件里的等价物。参考实现那版是给软链池做的
  // （池里的目录 ← 哪个来源软链到了它）；我们的数据模型里没有软链，
  // 有的是"同名技能散落在多个来源中、用户库里那份是从其中之一导入的"。
  // 它要回答的问题也因此是：这个技能是从哪来的、删了之后还能不能找回来。
  //
  // 键用 importFolder（小写）—— 与 imported、批量导入撞名判据同一把尺子，
  // 所以"这里说有来源能找回"与"导入按钮说会撞名"必然是同一个判断，
  // 不会出现一处说能找回、另一处说库里没有的情况。
  const byFolder = new Map()
  for (const g of Object.values(groups).flat()) {
    if (g.missing) continue
    for (const s of g.skills) {
      const key = String(s.importFolder ?? '').toLowerCase()
      if (key === '') continue
      if (!byFolder.has(key)) byFolder.set(key, [])
      byFolder.get(key).push({ label: g.label, path: g.path, dir: s.dir, readonly: g.readonly === true })
    }
  }
  // 只回填用户库那一组：其他来源的技能不承担"被导入"的角色
  for (const g of groups.harness) {
    for (const s of g.skills) {
      s.alsoIn = (byFolder.get(String(s.importFolder ?? '').toLowerCase()) ?? []).filter(
        (o) => resolve(o.dir) !== resolve(s.dir),
      )
    }
  }

  const total = Object.values(groups).reduce((sum, list) => sum + list.reduce((s, g) => s + g.count, 0), 0)
  return { groups, total, harnessDir: tildify(harnessDir) }
}

/* ------------------------------------------------------------------ *
 * import / delete
 * ------------------------------------------------------------------ */

/** 递归复制目录。 */
async function copyDir(src, dest) {
  await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
}

/** 校验一个目录是否是合法技能。 */
async function assertSkillDir(dir) {
  const raw = String(dir ?? '').trim()
  // resolve('') 会返回 cwd，必须先挡掉空值，否则会去校验当前工作目录
  if (raw === '') throw new Error('目录不存在')
  const target = resolve(raw)
  if (!(await isDir(target))) throw new Error('目录不存在')
  const skillFile = join(target, 'SKILL.md')
  try {
    await stat(skillFile)
  } catch {
    throw new Error('该目录没有 SKILL.md，不是技能')
  }
  return target
}

/**
 * 把任意字符串压成一个安全的目录名。
 * 市场列表的 displayName 是第三方可控数据，直接 join 到用户库路径上
 * 可以带 `..\` 越界写出（甚至配合覆盖导入删到库外），所以必须清洗。
 */
function safeFolderName(raw, fallback) {
  const clean = (value) =>
    String(value ?? '')
      // 去掉路径分隔符与 Windows 保留字符
      .replace(/[\\/:*?"<>|]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, '')
      // 去掉开头/结尾的点与空白，避免 `.` `..` 和 Windows 尾点问题
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '')
      .trim()
      .slice(0, 80)
  const primary = clean(raw)
  if (primary !== '') return primary
  const secondary = clean(fallback)
  return secondary !== '' ? secondary : 'skill'
}

/** 断言 dest 落在 base 之内（两侧都已 resolve）。 */
function assertInside(base, dest, message) {
  const prefix = base.endsWith(sep) ? base : base + sep
  if (!dest.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(message)
  return dest
}

/** 导入台账文件。 */
function importsFile() {
  return join(resolveDshHome(), 'dsh-curator', 'imports.json')
}

/**
 * 导入台账：记下每个落盘目录是从哪个来源导入的、什么时候。
 *
 * 为什么非要单独记一份：技能导入后会拍平成 `~/.dsh/skills/<name>`，
 * 与来源的联系在文件系统上就断了（既没有软链，也没有标记文件）。
 * 不记的话，面板最多只能回答"还有哪些来源里有同名技能"（那是猜的），
 * 回答不了"我这份到底从哪来、那个来源还在不在"。
 *
 * 删除技能时**不**删台账：删掉之后更应该留着它的来历，
 * 否则恢复回来又成了不知出处的孤儿。
 */
class ImportLedger {
  constructor() {
    this.path = importsFile()
    this.data = { version: 1, entries: {} }
    this.loaded = false
  }

  async load() {
    if (this.loaded) return this.data
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.entries) this.data = parsed
    } catch {
      /* 首次运行 */
    }
    this.loaded = true
    return this.data
  }

  /** 键是落盘目录名（小写）—— 与 imported / importFolder 用的是同一把尺子。 */
  get(folder) {
    return this.data.entries[String(folder ?? '').toLowerCase()]
  }

  async put(folder, entry) {
    const key = String(folder ?? '').toLowerCase()
    if (key === '') return
    this.data.entries[key] = entry
    await mkdir(dirname(this.path), { recursive: true })
    await atomicWrite(this.path, JSON.stringify(this.data, null, 2))
  }
}

/**
 * 反查一个目录属于哪个来源，给台账记"从哪来"用。
 * 取最长匹配：来源目录互相嵌套时（比如某来源就指在共享池里面），
 * 只有更具体的那个才是它真正的归属。
 */
function sourceLabelFor(config, dir) {
  const t = resolve(dir).toLowerCase()
  let best
  for (const s of config.sources) {
    const root = resolve(expandHome(s.path)).toLowerCase()
    const prefix = root.endsWith(sep) ? root : root + sep
    if (!t.startsWith(prefix)) continue
    if (best === undefined || root.length > best.root.length) {
      best = { root, label: String(s.label ?? s.key ?? '') }
    }
  }
  return best === undefined ? '' : best.label
}

/**
 * 遍历两种返回结构里的每个技能：
 *   - scanAll:      { groups: { harness: [group…], shared: […], external: […] } }
 *   - /harness:     { groups: [group…] }
 * 两种都出现过，写死一种就会静默遍历不到（不报错、只是字段全空）。
 */
function* eachSkill(data) {
  const groups = data?.groups
  const lists = Array.isArray(groups) ? [groups] : Object.values(groups ?? {})
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const g of list) {
      for (const s of g?.skills ?? []) yield s
    }
  }
}

/** 把台账里的来源信息挂到技能上（/harness 与 /scan 共用）。 */
async function attachOrigin(data, ledger) {
  await ledger.load()
  for (const s of eachSkill(data)) {
    const e = ledger.get(s.importFolder)
    if (!e) continue
    s.origin = {
      fromDir: String(e.fromDir ?? ''),
      fromLabel: String(e.fromLabel ?? ''),
      kind: String(e.kind ?? 'import'),
      marketSource: String(e.marketSource ?? ''),
      at: String(e.at ?? ''),
      /**
       * 来源目录还在不在：决定"删了之后能不能从原处再导一次"。
       * 面板据此把溯源说成"可重新导入"或"来源已不在"，
       * 而不是让用户自己去翻文件系统。
       */
      available: String(e.fromDir ?? '') !== '' && existsSync(String(e.fromDir)),
    }
  }
}

/** 把技能导入 DSH 用户库。 */
async function importSkill(sourceDir, name, overwrite, ledger, origin) {
  const src = await assertSkillDir(sourceDir)
  const harness = resolve(harnessSkillsDir())
  await mkdir(harness, { recursive: true })
  const folder = safeFolderName(name ?? basename(src), basename(src))
  const dest = assertInside(harness, resolve(join(harness, folder)), '非法的技能目录名')
  if (existsSync(dest)) {
    if (!overwrite) return { ok: false, error: 'exists', dest: tildify(dest) }
    // 双保险：删除前再确认一次目标确实在库内
    assertInside(harness, resolve(dest), '拒绝删除用户库外的目录')
    await rm(dest, { recursive: true, force: true })
  }
  await copyDir(src, dest)
  // 记台账。这一步失败不该让导入失败（技能已经落盘了），所以吞掉异常。
  if (ledger) {
    try {
      await ledger.put(folder, {
        name: String(name ?? folder),
        /** 来源目录：市场安装传空（那份临时解压目录马上就被删了，记了也是假的） */
        fromDir: String(origin?.fromDir ?? src),
        fromLabel: String(origin?.fromLabel ?? ''),
        /** 'import' = 从本机某个来源搬过来；'market' = 从技能市场下载安装 */
        kind: String(origin?.kind ?? 'import'),
        marketSource: String(origin?.marketSource ?? ''),
        at: new Date().toISOString(),
      })
    } catch {
      /* 台账写不进去不影响这次导入 */
    }
  }
  return { ok: true, dest: tildify(dest), name: folder }
}

/* ------------------------------------------------------------------ *
 * 回收站
 *
 * 「删除」= 移进 `$DSH_HOME/dsh-curator/trash/`，不真删。
 * 每条是一对：
 *   trash/<id>/        技能目录本体
 *   trash/<id>.json    元数据：原名 / 原始绝对路径 / 删除时间
 *
 * 为什么不用系统回收站：面板要能列出、恢复、彻底删，而系统回收站没有
 * 统一的可编程接口（Windows 要走 COM、macOS 要 AppleScript、Linux 各家
 * 命令不一），三者都拿不到"原始路径"，恢复这一步就无从谈起。
 *
 * 为什么回收站放在 dsh-curator 下而不是 skills 下：扫描器会递归扫
 * skills/ 的子树（scan.depth），放进 skills/.trash 会被当成技能再扫回来。
 * ------------------------------------------------------------------ */

function trashDir() {
  return join(resolveDshHome(), 'dsh-curator', 'trash')
}

/** 回收站 id 里的名字段：清洗掉路径分隔符，防它变成目录层级。 */
function trashSlug(name) {
  return String(name).replace(/[\\/]+/g, '--').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'skill'
}

/** 挡掉 `..`、路径分隔符、超长 —— 这些 id 最终会被 join 到路径上。 */
function validTrashId(id) {
  return (
    typeof id === 'string' &&
    id !== '' &&
    id.length <= 200 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..')
  )
}

/** 同盘 rename 秒移；跨盘（EXDEV）降级成复制 + 删除。 */
async function movePath(src, dest) {
  try {
    await rename(src, dest)
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    await cp(src, dest, { recursive: true, force: true })
    await rm(src, { recursive: true, force: true })
  }
}

/**
 * 把技能目录移进回收站。
 * 先写元数据再搬目录：搬失败要把元数据删掉，不留一堆没有本体的空壳条目。
 */
async function moveToTrash(sourceDir, name) {
  const dir = trashDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const slug = trashSlug(name)
  let id = stamp + '-' + slug
  for (let n = 2; existsSync(join(dir, id)) || existsSync(join(dir, id + '.json')); n += 1) {
    id = stamp + '-' + slug + '-' + n
  }
  const meta = {
    id,
    name: String(name),
    originalDir: resolve(sourceDir),
    deletedAt: new Date().toISOString(),
  }
  await writeFile(join(dir, id + '.json'), JSON.stringify(meta, null, 2), 'utf8')
  try {
    await movePath(resolve(sourceDir), join(dir, id))
  } catch (e) {
    // 元数据先落盘是为了"宁可留下一条可清理的空壳，也不要有搬走了却忘了记的孤儿目录"；
    // 搬失败这条前提就不成立了，回滚元数据
    await rm(join(dir, id + '.json'), { force: true }).catch(() => {})
    throw e
  }
  return meta
}

/** 读回收站清单（删除时间倒序）。坏掉的元数据跳过，不让一条坏文件拖垮整个列表。 */
async function listTrash() {
  const dir = trashDir()
  const items = []
  for (const e of await safeReaddir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, e.name), 'utf8'))
      const id = String(meta.id ?? e.name.slice(0, -5))
      if (!validTrashId(id)) continue
      const body = join(dir, id)
      items.push({
        id,
        name: String(meta.name ?? id),
        originalDir: String(meta.originalDir ?? ''),
        originalDirShort: tildify(String(meta.originalDir ?? '')),
        deletedAt: String(meta.deletedAt ?? ''),
        /** 目录本体还在吗。不在 = 残缺项（比如被手动删过），前端只让它"清理" */
        intact: existsSync(body),
      })
    } catch {
      /* 单条读不动就跳过 */
    }
  }
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  return items
}

/** 从回收站恢复：放回原始路径。原位置已有东西就拒绝，绝不覆盖。 */
async function restoreTrash(id) {
  if (!validTrashId(id)) throw new Error('非法的回收站条目')
  const dir = trashDir()
  const metaFile = join(dir, id + '.json')
  const body = join(dir, id)
  if (!existsSync(metaFile)) throw new Error('回收站里没有这一条')
  const meta = JSON.parse(await readFile(metaFile, 'utf8'))
  const dest = String(meta.originalDir ?? '')
  if (dest === '') throw new Error('元数据里没有原始路径，无法恢复')
  const target = resolve(dest)
  // 元数据是磁盘上的普通文件，不能当可信输入：只允许放回用户库内，
  // 否则改一行 json 就能把任意目录写到任意位置
  assertInside(resolve(harnessSkillsDir()), target, '原始路径不在 DSH 用户库内，拒绝恢复')
  if (!existsSync(body)) throw new Error('回收站里的目录已经不在了（可能被手动删过）')
  if (existsSync(target)) throw new Error('原位置已经有同名技能了，先处理它再恢复')
  await mkdir(dirname(target), { recursive: true })
  await movePath(body, target)
  await rm(metaFile, { force: true })
  return { ok: true, restored: tildify(target) }
}

/** 彻底删除一条（不可恢复）。 */
async function purgeTrash(id) {
  if (!validTrashId(id)) throw new Error('非法的回收站条目')
  const dir = trashDir()
  await rm(join(dir, id), { recursive: true, force: true })
  await rm(join(dir, id + '.json'), { force: true })
  return { ok: true, id }
}

/** 清空回收站。 */
async function emptyTrash() {
  const items = await listTrash()
  for (const it of items) {
    await rm(join(trashDir(), it.id), { recursive: true, force: true })
    await rm(join(trashDir(), it.id + '.json'), { force: true })
  }
  return { ok: true, removed: items.length }
}

/**
 * 从 DSH 用户库删除一个技能 —— 移进回收站，不真删。
 * 只允许删用户库内的：来源目录归别的工具管，删了是砸别人的场子。
 */
async function removeSkill(dir, name) {
  const raw = String(dir ?? '').trim()
  if (raw === '') throw new Error('目录不存在')
  const target = resolve(raw)
  const harness = resolve(harnessSkillsDir())
  const trash = resolve(trashDir())
  assertInside(harness, target, '只能删除 DSH 用户库内的技能')
  // 保险：回收站必须在用户库之外，否则搬进去的技能会被扫描器再扫回来，
  // 表现为"删了还在"
  if (trash.toLowerCase().startsWith(harness.toLowerCase() + sep.toLowerCase())) {
    throw new Error('内部错误：回收站不能位于 DSH 用户库内')
  }
  if (!existsSync(target)) throw new Error('目录不存在')
  const meta = await moveToTrash(target, name ?? basename(target))
  return { ok: true, removed: tildify(target), trashId: meta.id }
}

/**
 * 这个位置允许我们改技能的 frontmatter 吗。
 *
 * 用户库（type=harness）必须可写 —— 模型能看到的就是用户库里的技能，
 * 可见性治理不落在这里就等于没用。注意用户库的 readonly 默认是 true，
 * 但那个标记管的是"能不能被导入覆盖 / 删除"，不是"能不能改技能自己的开关"。
 *
 * 别的 coding agent 的技能库（type=external）一律不写：那是别人的目录，
 * 替它们改 frontmatter 是越界，也绕过了用户对那个来源的控制。
 * 共享池跟随它自己的 readonly 标记。
 */
function visibilityWritable(config, target) {
  const t = resolve(target).toLowerCase()
  const inside = (root) => t.startsWith(resolve(root).toLowerCase() + sep.toLowerCase())
  if (inside(harnessSkillsDir())) return true
  return config.sources.some((s) => s.type === 'shared' && s.readonly !== true && inside(expandHome(s.path)))
}

/* ------------------------------------------------------------------ *
 * translation
 * ------------------------------------------------------------------ */

/** AI 分析缓存的读写；键是 SKILL.md 全文的 hash。 */
class AnalysisCache {
  constructor(path, legacyPath) {
    this.path = path
    this.legacyPath = legacyPath
    this.data = { version: 2, entries: {} }
    this.loaded = false
    /** 条数上限，超了按 at 时间淘汰最旧的；0 = 不限。 */
    this.maxEntries = 0
  }

  async load() {
    if (this.loaded) return this.data
    const readEntries = async (file) => {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return parsed && typeof parsed === 'object' && parsed.entries ? parsed : undefined
    }
    try {
      this.data = (await readEntries(this.path)) ?? this.data
    } catch {
      // 新文件不存在时，尝试从旧名字迁移，避免用户丢掉已付过费的分析结果
      try {
        const legacy = await readEntries(this.legacyPath)
        if (legacy) {
          this.data = legacy
          await this.flush()
        }
      } catch {
        /* 首次运行 */
      }
    }
    this.loaded = true
    return this.data
  }

  key(text) {
    return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
  }

  /** 归一化成 {summary, usage, triggers}；旧版缓存里可能只是字符串。 */
  normalize(value) {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'string') {
      const s = value.trim()
      return s === '' ? undefined : { summary: s, usage: '', triggers: [] }
    }
    if (typeof value === 'object') {
      const summary = String(value.summary ?? value.zh ?? '').trim()
      if (summary === '') return undefined
      return {
        summary,
        usage: String(value.usage ?? '').trim(),
        triggers: Array.isArray(value.triggers) ? value.triggers.filter((t) => typeof t === 'string' && t.trim()).slice(0, 8) : [],
        category: ANALYZE_CATEGORY_SET.has(value.category) ? value.category : '',
      }
    }
    return undefined
  }

  get(text) {
    const entry = this.data.entries[this.key(text)]
    return this.normalize(entry?.zh ?? entry?.analysis)
  }

  async put(text, analysis) {
    this.data.entries[this.key(text)] = { analysis, at: new Date().toISOString() }
    this.prune()
    await this.flush()
  }

  /** 超过上限时淘汰最旧的条目（按 at 排序）。 */
  prune() {
    const limit = Number(this.maxEntries) || 0
    if (limit <= 0) return
    const keys = Object.keys(this.data.entries)
    if (keys.length <= limit) return
    keys
      .sort((a, b) => String(this.data.entries[a]?.at ?? '').localeCompare(String(this.data.entries[b]?.at ?? '')))
      .slice(0, keys.length - limit)
      .forEach((k) => delete this.data.entries[k])
  }

  /** 把内存里的数据一次性写盘（并发时避免每个worker都写文件）。 */
  async flush() {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.path)
  }

  stats() {
    return { size: Object.keys(this.data.entries).length, path: this.path, maxEntries: this.maxEntries || 0 }
  }

  async clear() {
    this.data = { version: 2, entries: {} }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8')
  }
}

/** 智能分类的固定词表：模型只输出 key，显示文案归前端 i18n。 */
const ANALYZE_CATEGORIES = ['dev', 'search', 'memory', 'comms', 'ui', 'docs', 'media', 'productivity', 'other']
const ANALYZE_CATEGORY_SET = new Set(ANALYZE_CATEGORIES)

/** AI 分析用系统提示词：输出结构化对象，供卡片直接渲染。 */
const ANALYZE_SYSTEM = [
  '你是技能/插件分析助手。用户会给你若干个条目，每个条目是一份 SKILL.md 全文或一份插件 README。',
  '请为每一个条目分析并输出一个 JSON 对象，字段如下：',
  '  summary:  一句话核心能力，简体中文，30-60 字，卡片描述位用；',
  '  usage:    具体怎么用/操作步骤，1-2 句简体中文，告诉用户触发后会做什么；',
  '  triggers: 触发钩子数组，3-5 个短词（2-6 字），表示什么场景/关键词下该用，例如 ["PDF处理","文档总结","英文写作"]；',
  '  category: 智能分类，必须且只能从这些 key 里选一个：' + ANALYZE_CATEGORIES.map((k) => k).join(' / ') + '。',
  '要求：',
  // ↓ 安全约束，不是为了输出质量。放在最前面，免得被后面那几条风格要求盖过去。
  // 摘要是要落盘到 analyses.json、还要显示在卡片上的 —— 模型一旦把密钥抄进 summary，
  // 就等于在界面上二次暴露了一遍。发送前的 redactSecrets 只挡得住"形态规整"的密钥，
  // 这条提示词是第二道网。
  '- 【安全】正文里若出现密钥、令牌、密码、私钥或内网地址（IP/内部主机名），',
  '  不要在 summary/usage 里复述、转述或举例，只写"需要配置密钥""填你自己的 API Key"这类说法；',
  '  哪怕原文自己就是把它当示例写的，也不要把那个具体值抄进来。',
  '  正文里出现的 [REDACTED] 是发送前打的码，不要试图猜测它的原值。',
  '- 基于全文内容归纳，不要逐句翻译；正文里写了但描述没提的能力也要涵盖。',
  '- 保留必要技术术语英文原词（Docker、API、Remotion、React 等）。',
  '- 直接说能力和用法，不要"该技能"/"该插件"这类开头。',
  '- 只输出 JSON 数组，元素是上述对象，顺序与输入一致，不要任何解释和 markdown 代码块。',
].join('\n')

/** 从模型输出里稳健地取出对象数组 [{summary,usage,triggers}, ...]。 */
export function analyzeObjectArray(text) {
  const cleaned = String(text ?? '')
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
    .trim()

  const normalizeOne = (x) => {
    if (!x || typeof x !== 'object') return undefined
    const summary = String(x.summary ?? '').trim()
    if (summary === '') return undefined
    return {
      summary,
      usage: String(x.usage ?? '').trim(),
      triggers: Array.isArray(x.triggers) ? x.triggers.filter((t) => typeof t === 'string' && t.trim()).slice(0, 8) : [],
      // 旧缓存没有 category → 空串，前端显示"未分类"，不报错
      category: ANALYZE_CATEGORY_SET.has(x.category) ? x.category : '',
    }
  }

  // 1) 优先找数组 [...]
  const segments = balancedArraySegments(cleaned)
  for (const segment of segments) {
    let parsed = undefined
    try { parsed = JSON.parse(segment) } catch { continue }
    if (Array.isArray(parsed)) {
      const arr = parsed.map(normalizeOne).filter(Boolean)
      if (arr.length > 0) return arr
    }
  }

  // 2) fallback：模型可能直接输出单个对象 {...}（batchSize=1 时常见）
  try {
    const obj = JSON.parse(cleaned)
    const one = normalizeOne(obj)
    if (one) return [one]
  } catch { /* ignore */ }

  // 3) fallback：从文本里抠第一个 {...} 片段
  const m = cleaned.match(/\{[\s\S]*"summary"[\s\S]*\}/)
  if (m) {
    try {
      const one = normalizeOne(JSON.parse(m[0]))
      if (one) return [one]
    } catch { /* ignore */ }
  }

  // 4) 终极兜底：直接正则提取 summary/usage/triggers 字段值，不管JSON合不合法
  const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (summaryMatch) {
    const summary = summaryMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim()
    if (summary) {
      const usageMatch = cleaned.match(/"usage"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      const trigMatch = cleaned.match(/"triggers"\s*:\s*\[([^\]]*)\]/)
      const triggers = trigMatch
        ? trigMatch[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, '')).filter(Boolean).slice(0, 8) ?? []
        : []
      return [{ summary, usage: usageMatch ? usageMatch[1].replace(/\\n/g, ' ').trim() : '', triggers }]
    }
  }

  return undefined
}

/** 带指数退避的重试执行 fn，最多 tries 次。 */
async function withRetry(fn, tries = 3, label = '') {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * Math.pow(2, i)))
    }
  }
  throw lastErr
}

/** 切出所有「括号平衡的顶层数组」，引号内的括号不计深度。 */
function balancedArraySegments(text) {
  const segments = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === ']' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        segments.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return segments
}

/* ------------------------------------------------------------------ *
 * 密钥擦洗
 *
 * 背景：AI 分析要把 SKILL.md 全文发给模型（自建端点或宿主模型）。
 * 而技能文档里夹带密钥是常态 —— 有人把 API key 直接写进 SKILL.md 的
 * "配置"一节，有人写进脚本示例。这些内容一旦发出去就收不回来。
 *
 * 只认**结构化特征**：固定的厂商前缀 + 长度，或者 `key: value` 里那个像密钥的值。
 * 不做"看起来像随机串就删"的泛化判断 —— 那会把技能里正常的 hash、版本号、
 * UUID、base64 主题色一起打掉，分析质量白降，还容易让人以为插件坏了。
 * ------------------------------------------------------------------ */

/**
 * @type {RegExp[]}
 * 每个元素要么无捕获组（整体替换），要么第 1 个捕获组是"要保留的前缀"
 * （如 `api_key=` 这半截），只替换后面的值。
 */
const SECRET_PATTERNS = [
  // 厂商固定前缀：前缀本身足够独特，不需要看上下文
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / 各类兼容端点
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub 新版 PAT
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z._-]{20,}/g, // Google OAuth
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  // PEM 私钥块：跨行，必须放在单行规则后面
  /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
  // key: value / key=value。值要求 ≥12 位且不含空格，
  // 这样 `token: 上限 4096` 这种说明不受影响，而 `apiKey = "sk-..."` 会被打掉。
  /((?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|auth)[a-z_]*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+]{12,})/gi,
  // Authorization 头
  /(\bBearer\s+)[A-Za-z0-9_\-.=+/]{16,}/gi,
]

/**
 * 把文本里像密钥的片段换成 `[REDACTED]`。
 *
 * 用 `[REDACTED]` 而不是空串：模型看到这个标记就知道"这里原本有东西但我看不到"，
 * 不会去猜、也不会在 summary 里编一个出来。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const re of SECRET_PATTERNS) {
    // ⚠️ 无捕获组的正则，回调第二个参数收到的是 offset（数字）而不是 undefined，
    // 所以要判 typeof string，不能判 `=== undefined`。
    out = out.replace(re, (match, prefix) => (typeof prefix === 'string' ? prefix + '[REDACTED]' : '[REDACTED]'))
  }
  return out
}

/** 解释用用户提示词构造：每条带 name + 正文（可能是技能的 SKILL.md，也可能是插件的 README）。 */
function explainPayload(items) {
  return items
    .map((item, index) => {
      const full = String(item.fullText ?? '').trim()
      const body = full !== '' ? full : String(item.description ?? '')
      // 名称也过一遍：有人把 token 写进目录名或 frontmatter 的 name。
      return `【条目 ${index + 1}】名称: ${redactSecrets(item.name)}\n内容:\n${redactSecrets(body)}`
    })
    .join('\n\n───────\n\n')
}

/** 分析类任务不需要发散，固定低温。 */
const ANALYZE_TEMPERATURE = 0.2

/** 调 OpenAI 兼容端点为一批技能做结构化 AI 分析。 */
async function analyzeBatch(cfg, items, deadline) {
  const base = String(cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') throw new Error('未配置分析端点（baseUrl）')
  if (String(cfg.model ?? '').trim() === '') throw new Error('未配置分析模型（model）')
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
  const payload = explainPayload(items)
  // maxTokens <= 0 表示不发送该字段，由端点自定上限（发大了有些模型直接 400）
  const maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : undefined

  return await withRetry(async () => {
    // 单次尝试也不能越过总时限：否则一批最坏跑满 tries × timeoutMs，
    // deadline 只能挡住"重新排队"，挡不住这一次本身就超时。
    const budget = deadline === undefined
      ? cfg.timeoutMs
      : Math.max(2000, Math.min(cfg.timeoutMs, deadline - Date.now()))
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          { role: 'user', content: payload },
        ],
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        temperature: ANALYZE_TEMPERATURE,
      }),
      signal: AbortSignal.timeout(budget),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(redactKey(`分析端点 HTTP ${res.status}：${body.slice(0, 300)}`, cfg.apiKey))
    }
    const json = await res.json()
    const text = json?.choices?.[0]?.message?.content ?? ''
    const arr = analyzeObjectArray(text)
    if (arr === undefined) throw new Error(`分析结果无法解析，原始输出前 160 字：${String(text).trim().slice(0, 160)}`)
    const out = {}
    items.forEach((item, index) => {
      const a = arr[index]
      if (a && a.summary) out[item.key] = a
    })
    return out
  }, 3, 'analyze')
}

/** 用宿主 LLM 做结构化 AI 分析（直连没配时回退）。 */
async function analyzeBatchViaHost(ctx, cfg, items) {
  // 宿主没注入 llm 服务时直接失败，别让它去 withRetry 里白等 3 轮退避
  if (typeof ctx?.llm?.stream !== 'function') throw new Error('宿主没有 llm 服务，无法回退')
  let route
  try {
    const sel = ctx?.agentDefaultModel?.currentSelection?.()
    if (sel?.provider && sel?.model) route = { provider: sel.provider, model: sel.model }
  } catch { /* 服务不可用 */ }
  if (!route) throw new Error('宿主没有可用的默认模型')

  const payload = explainPayload(items)
  return await withRetry(async () => {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: ANALYZE_SYSTEM }], source: { kind: 'plugin:dsh-curator' } },
        { role: 'user', content: [{ type: 'text', text: payload }], source: { kind: 'plugin:dsh-curator' } },
      ],
    })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? chunk.delta ?? ''
    }
    if (text.trim() === '') throw new Error('宿主模型返回空正文')
    const arr = analyzeObjectArray(text)
    if (arr === undefined) throw new Error('宿主模型输出无法解析')
    const out = {}
    items.forEach((item, index) => {
      const a = arr[index]
      if (a && a.summary) out[item.key] = a
    })
    return out
  }, 3, 'analyze-host')
}

/* ------------------------------------------------------------------ *
 * market
 * ------------------------------------------------------------------ */

async function httpGetJson(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-curator' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

/** SkillHub 分类目录（中文标签 + 图标计数）。 */
async function skillhubCategories(apiBase) {
  try {
    const json = await httpGetJson(`${apiBase}/api/v1/categories`)
    const items = json?.items ?? []
    return items.map((c) => ({ key: c.key, name: c.name ?? c.nameEn ?? c.key, nameEn: c.nameEn }))
  } catch {
    return []
  }
}

/**
 * SkillHub 搜索——字段与官网 skillhub.cn/skills 一致。
 * 原生返回 summary_zh（中文摘要）、tags、iconUrl、downloads、labels.requires_api_key 等。
 * sortBy 有效值：score(全部/综合) / installs(近期飙升) / downloads(下载量) / updated_at(最近上新)。
 * source 有效值：''(所有来源,后端已聚合) / community(SkillHub) / clawhub(ClawHub) / enterprise。
 */
async function searchSkillHub(apiBase, { q, category, sort, source, page, pageSize }) {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  params.set('order', 'desc')
  if (q) params.set('keyword', q)
  if (category) params.set('category', category)
  if (source) params.set('source', source)
  // 官网 tab：全部(score) / 近期飙升(installs) / 下载量(downloads) / 最近上新(updated_at)
  const sortBy = ['downloads', 'installs', 'updated_at'].includes(sort) ? sort : 'score'
  params.set('sortBy', sortBy)

  const json = await httpGetJson(`${apiBase}/api/skills?${params}`)
  const list = json?.data?.skills ?? []
  const total = json?.data?.total ?? list.length
  return {
    items: list.map((item) => ({
      source: 'skillhub',
      marketSource: item.source ?? 'community',
      slug: String(item.slug ?? item.name ?? ''),
      name: String(item.displayName ?? item.name ?? item.slug ?? ''),
      description: String(item.description_zh ?? item.summary_zh ?? item.description ?? item.summary ?? ''),
      author: item.ownerName ?? item.namespace?.handle ?? item.upstream_owner_login ?? undefined,
      downloads: item.downloads ?? 0,
      installs: item.installs ?? 0,
      stars: item.stars ?? 0,
      category: item.category ?? '',
      subCategories: (item.subCategories ?? []).map((c) => c?.name ?? c?.key ?? c).filter(Boolean),
      tags: (item.tags ?? []).map((tag) => (typeof tag === 'string' ? tag : tag.name)).filter(Boolean),
      iconUrl: item.iconUrl ?? '',
      verified: item.verified === true,
      version: item.version ?? '',
      updatedAt: item.updated_at ?? undefined,
      homepage: item.homepage ?? '',
      requiresApiKey: item.labels?.requires_api_key === 'true' || item.labels?.requires_api_key === true,
    })),
    total,
  }
}

/** 清掉 tmp 目录里超过 24h 的残留（安装中断会留下压缩包和 x-* 解压目录）。 */
async function sweepTmp(dir) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const entry of await safeReaddir(dir)) {
    const full = join(dir, entry.name)
    try {
      if ((await stat(full)).mtimeMs < cutoff) await rm(full, { recursive: true, force: true })
    } catch {
      /* 并发删除或权限问题，忽略 */
    }
  }
}

/** 下载技能包到临时文件。 */
async function downloadSkillPackage(cfg, source, slug) {
  const base = source === 'clawhub' ? cfg.clawhubApiBase : cfg.skillhubApiBase
  const url =
    source === 'clawhub'
      ? `${base}/api/v1/download?ref=${encodeURIComponent(slug)}`
      : `${base}/api/v1/download?slug=${encodeURIComponent(slug)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dsh-curator' },
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) throw new Error('下载内容为空')
  const tmpDir = join(resolveDshHome(), 'dsh-curator', 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const ext = buffer[0] === 0x50 && buffer[1] === 0x4b ? 'zip' : 'tar.gz'
  const file = join(tmpDir, `${slug.replace(/[^\w.-]/g, '_')}-${Date.now()}.${ext}`)
  await writeFile(file, buffer)
  return file
}

/** 解压到目标目录（Windows 自带 tar/bsdtar，能处理 zip 与 tar.gz）。 */
/** 解压大小/条目上限：市场技能包通常几十 KB，给足余量同时防 zip bomb。 */
const EXTRACT_MAX_BYTES = 64 << 20
const EXTRACT_MAX_FILES = 5000

async function extractPackage(file, dest) {
  const info = await stat(file)
  if (info.size > EXTRACT_MAX_BYTES) {
    throw new Error(`安装包过大（${Math.round(info.size / 1048576)}MB，上限 ${EXTRACT_MAX_BYTES >> 20}MB）`)
  }
  await mkdir(dest, { recursive: true })
  try {
    await execFileAsync('tar', ['-xf', file, '-C', dest], { windowsHide: true, timeout: 60000 })
  } catch (error) {
    throw new Error(`解压失败：${String(error?.message ?? error)}`)
  }
  await assertExtractionSafe(dest)
}

/**
 * 校验解压结果。市场技能包是第三方内容：
 *   - 带 `../` 的条目（zip-slip）会把文件写到目标目录外；
 *   - 包内符号链接可能指向库外，随后被 cp -r 带进用户库；
 *   - 超大/超多文件可以撑爆磁盘。
 */
async function assertExtractionSafe(dest) {
  const root = resolve(dest)
  const prefix = root.endsWith(sep) ? root : root + sep
  const stack = [root]
  let files = 0
  let bytes = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of await safeReaddir(dir)) {
      const full = join(dir, entry.name)
      const real = resolve(full)
      if (real !== root && !real.toLowerCase().startsWith(prefix.toLowerCase())) {
        throw new Error('安装包内含越界路径（zip-slip），已拒绝安装')
      }
      if (entry.isSymbolicLink()) throw new Error('安装包内含符号链接，已拒绝安装')
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      files += 1
      if (files > EXTRACT_MAX_FILES) throw new Error(`安装包内文件过多（>${EXTRACT_MAX_FILES}），已拒绝安装`)
      try {
        bytes += (await stat(full)).size
      } catch {
        /* 解压出来又消失的条目，忽略 */
      }
      if (bytes > EXTRACT_MAX_BYTES) throw new Error('安装包解压后体积过大，已拒绝安装')
    }
  }
}

/** 解压后定位真正的技能目录（有些包多一层顶层目录）。 */
async function locateExtractedSkill(dest) {
  if (existsSync(join(dest, 'SKILL.md'))) return dest
  const entries = await safeReaddir(dest)
  const dirs = entries.filter((e) => e.isDirectory())
  for (const dir of dirs) {
    const candidate = join(dest, dir.name)
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate
  }
  // 再深一层
  for (const dir of dirs) {
    const inner = await safeReaddir(join(dest, dir.name))
    for (const sub of inner.filter((e) => e.isDirectory())) {
      const candidate = join(dest, dir.name, sub.name)
      if (existsSync(join(candidate, 'SKILL.md'))) return candidate
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * http helpers
 * ------------------------------------------------------------------ */

/** 请求体超限：单独一个错误类型，路由层据此回 413 而不是 500。 */
class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`请求体超过上限（${Math.round(limit / 1048576)}MB）`)
    this.name = 'PayloadTooLargeError'
    this.code = 'payload-too-large'
  }
}

function readBody(req, limit = 2 << 20) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        chunks.length = 0
        // 不在这里 req.destroy()：先让路由层把 413 写回去，
        // 直接 destroy 客户端只会看到连接被重置，拿不到原因。
        req.resume()
        reject(new PayloadTooLargeError(limit))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** 请求体超限 → 413，其余 → 500。 */
function errorStatus(error) {
  return error?.code === 'payload-too-large' ? 413 : 500
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/* ------------------------------------------------------------------ *
 * 同源校验：挡住针对 localhost 的 CSRF
 * ------------------------------------------------------------------ */

/** 本机来源：127.0.0.1 / localhost / [::1]，端口不限（DSH 端口会变）。 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/**
 * 写请求的同源校验。
 *
 * 为什么需要：这些路由能装任意 npm 包、能删本地文件、能改用户的技能文件，
 * 而服务只监听本机。用户随便打开一个恶意网页，那个页面就能朝
 * 127.0.0.1:<port> 发写请求（针对 localhost 的 CSRF / DNS rebinding）。
 *
 * 两道关，缺一不可：
 *   ① Origin 白名单——浏览器发跨站写请求时必定带 Origin，值就是攻击者站点，
 *      直接拒。不带 Origin 的是 curl / 测试脚本这类非浏览器客户端，放行。
 *   ② content-type 必须是 JSON——浏览器想发 application/json 只能走 CORS，
 *      而跨站 CORS 要先过 OPTIONS 预检，本服务不给预检放行（路由只认 POST，
 *      其它方法回 405 且不带 CORS 头）。no-cors 模式压根不允许自定义
 *      content-type，只能用 text/plain 那几个，同样过不去。
 *      两道合起来，`Origin: null`（sandboxed iframe / data: / file:）这种
 *      单看分不出敌我的情况也就安全了——所以这里不拦 null，
 *      免得把从 file:// 加载的渲染进程一起打死。
 */
function originAllowed(req) {
  const method = String(req.method ?? 'GET').toUpperCase()
  // 只读方法放行：读不出凭据，也没什么可被利用的
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true

  // ① 来源
  const origin = req.headers?.origin
  if (origin !== undefined && origin !== '') {
    const value = String(origin).trim()
    if (value.toLowerCase() !== 'null' && !LOCAL_ORIGIN_RE.test(value)) return false
  } else {
    const referer = req.headers?.referer ?? req.headers?.referrer
    if (referer !== undefined && referer !== '') {
      try {
        if (!LOCAL_ORIGIN_RE.test(new URL(String(referer)).origin)) return false
      } catch {
        return false
      }
    }
  }

  // ② 请求体类型
  const contentType = String(req.headers?.['content-type'] ?? '')
  if (contentType !== '' && !/^application\/json\b/i.test(contentType)) return false

  return true
}

/* ------------------------------------------------------------------ *
 * plugin body
 * ------------------------------------------------------------------ */

export function apply(ctx, userConfig = {}) {
  // 插件配置层只提供"首次生成默认值"的机会；运行时真源是 config.json。
  const store = new ConfigStore(configPath())
  /**
   * config.json 是否已存在。
   * 必须在任何 store.load() 之前取 —— ConfigStore.load() 在文件不存在时会顺手把它创建出来。
   */
  const firstRun = !existsSync(configPath())
  const cache = new AnalysisCache(cachePath(), legacyCachePath())
  /** 导入台账：记住每个已导入技能是从哪个来源来的（见 ImportLedger）。 */
  const ledger = new ImportLedger()
  if (firstRun && userConfig && Object.keys(userConfig).length > 0) {
    /**
     * patch 层（cordis.patch.yml 的 config）给的初值，只在**首次安装**时落盘。
     *
     * 这里以前是无条件 save，也就是每次启动都拿 patch 覆盖用户在面板里改过的设置 ——
     * 它之所以一直没出事，是因为 patch 里写的键名（translateBatchSize / scanDepth /
     * maxSkillsPerSource / cachePath）早就跟 normalizeConfig 对不上了，读出来全是
     * undefined。所以「把 patch 里的键名改对」这件事必须连这里一起修，
     * 否则一改就会变成"设置改了不生效、重启又变回去"。
     *
     * analyze 段兼容旧名 translate；scan / market 段一并接受，省得 patch 里写了个
     * 看起来生效、实际没人读的配置。
     */
    const patchConfig = {}
    const analyzePatch = userConfig.analyze ?? userConfig.translate
    if (analyzePatch) patchConfig.analyze = analyzePatch
    if (userConfig.scan) patchConfig.scan = userConfig.scan
    if (userConfig.market) patchConfig.market = userConfig.market
    if (Object.keys(patchConfig).length > 0) {
      store
        .load()
        .then((current) => store.save({ ...current, ...patchConfig }))
        .catch(() => {})
    }
  }

  /** 统一取配置；顺带把缓存条数上限同步过来。 */
  const cfg = async () => {
    const current = await store.load()
    cache.maxEntries = current.analyze?.cacheMaxEntries ?? 0
    return current
  }

  /**
   * 插件管理（启停/卸载）用的 profile 层工具。
   * 机制对齐官方插件页的开关：官方页读的是 profile package.json 的
   * dsh.profile.bundles（组合层），运行时真值还在用户补丁层 cordis.patch.yml
   * 的 disabled 行（HMR ~1s 内热应用）。两层一起写才不会出现"两边说的不一样"。
   */

  function profileManifestPath() {
    return join(resolveDshHome(), 'profiles', resolveProfileName(), 'package.json')
  }

  function userPatchPath() {
    return join(resolveDshHome(), 'profiles', resolveProfileName(), 'cordis.patch.yml')
  }

  /** profile 清单：dependencies（来源判断，link: 前缀 = 自建本地链接）+ bundles（启停状态）。 */
  function readProfileManifest() {
    let pkg = {}
    try { pkg = JSON.parse(readFileSync(profileManifestPath(), 'utf8')) } catch { pkg = {} }
    const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    const bundles = pkg.dsh?.profile?.bundles ?? []
    return {
      deps,
      bundles: Array.isArray(bundles) ? bundles.map(String) : [],
    }
  }

  /** 收集插件自己 cordis.patch.yml 里 insert 的 loader 行 id（启停时要写 disabled 的目标）。 */
  function insertedRowIds(pkgDir) {
    let text = ''
    try { text = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8') } catch { return [] }
    const ids = []
    for (const m of text.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)) {
      const id = m[1].replace(/^['"]|['"]$/g, '')
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /** 写操作前把 package.json 和 cordis.patch.yml 备份到插件缓存目录（保留最近 5 份）。 */
  async function backupProfileFiles() {
    const dir = join(resolveDshHome(), 'dsh-curator', 'backups', String(Date.now()))
    await mkdir(dir, { recursive: true })
    for (const file of [profileManifestPath(), userPatchPath()]) {
      if (existsSync(file)) await copyFile(file, join(dir, basename(file))).catch(() => {})
    }
    const root = dirname(dir)
    try {
      const stamps = (await readdir(root)).filter((n) => /^\d+$/.test(n)).sort()
      for (const old of stamps.slice(0, Math.max(0, stamps.length - 5))) {
        await rm(join(root, old), { recursive: true, force: true })
      }
    } catch {
      /* 旧备份清理失败不影响本次备份 */
    }
    return dir
  }

  /** 在用户补丁层给指定行 id 写 disabled 标志：已有行就地改值，没有的追加新行。返回新文本。 */
  function setPatchDisabled(text, ids, disabled) {
    const lines = text.split(/\r?\n/)
    const starts = []
    for (let i = 0; i < lines.length; i++) {
      if (/^- id:/.test(lines[i])) starts.push(i)
    }
    starts.push(lines.length)
    const value = disabled ? 'true' : 'false'
    for (const id of ids) {
      let at = -1
      for (let k = 0; k < starts.length - 1; k++) {
        const m = /^- id:\s*(.+?)\s*$/.exec(lines[starts[k]])
        if (m && m[1].replace(/^['"]|['"]$/g, '') === id) { at = k; break }
      }
      if (at >= 0) {
        const end = starts[at + 1]
        let wrote = false
        for (let i = starts[at] + 1; i < end; i++) {
          if (/^\s+disabled:/.test(lines[i])) {
            lines[i] = lines[i].replace(/(disabled:\s*).*$/, '$1' + value)
            wrote = true
            break
          }
        }
        if (!wrote) lines.splice(starts[at] + 1, 0, '  disabled: ' + value)
      } else {
        lines.push('- id: ' + id, '  disabled: ' + value)
      }
    }
    return lines.join('\n')
  }

  /** 用户补丁层是否以 name: 引用了这个包（insert 或配置覆盖行都会挡卸载，宁紧勿松）。 */
  function patchReferencesPackage(text, name) {
    const re = new RegExp('^\\s*name:\\s*[\'"]?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]?\\s*$', 'm')
    return re.test(text)
  }

  /** npm 包名白名单：卸载参数要拼进 shell 命令，先保证它进不了注入。 */
  const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

  /**
   * 卸载一个插件：优先 dsh CLI（内部是 pnpm rm，会同步改 package.json 和 node_modules），
   * CLI 不可用就退回直接在 profile 目录跑 pnpm rm。只删 profile 里的包；
   * link: 自建插件的本地源码目录不受影响。
   */
  async function uninstallPluginPackage(name) {
    if (!NPM_NAME_RE.test(name)) throw new Error('非法包名: ' + name)
    const rmArgs = ['plugin', '--profile', resolveProfileName(), 'rm', name]
    const attempts = []
    const cliFromEnv = process.env.DSH_CLI_PATH?.trim()
    if (cliFromEnv) attempts.push({ cmd: cliFromEnv, args: rmArgs, cwd: undefined })
    attempts.push({ cmd: 'dsh', args: rmArgs, cwd: undefined })
    attempts.push({ cmd: 'pnpm', args: ['rm', name], cwd: profileManifestDir() })
    let lastErr
    for (const a of attempts) {
      try {
        await execFileAsync(a.cmd, a.args, { cwd: a.cwd, shell: true, timeout: 120000 })
        return a.cmd
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error('没有可用的卸载通道')
  }

  /* ------------------------------------------------------------------ *
   * 插件市场（独立实现：直连 awesome-dsh-plugin.com 公开目录，不依赖 dshmarket）
   * ------------------------------------------------------------------ */

  const MARKET_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
  /** 缓存结构版本：归一化字段一改就要 +1，否则旧缓存喂给新 UI（分类会空） */
  const MARKET_CACHE_VERSION = 2
  /** 安装 spec：npm 名（可带版本）、github:owner/repo。冒号来自 github: 前缀。 */
  const MARKET_SPEC_RE = /^[a-zA-Z0-9@][a-zA-Z0-9@._\/:-]*$/

  function marketCacheFile() {
    return join(resolveDshHome(), 'dsh-curator', 'cache', 'market-catalog.json')
  }

  /** 从目录条目推导安装 spec：npm 名优先，没有就走 github:owner/repo。 */
  function marketInstallSpec(plugin) {
    if (typeof plugin?.npm === 'string' && plugin.npm) return plugin.npm
    const m = String(plugin?.url ?? '').match(/github\.com\/([^/\s]+\/[^/\s#?]+)/)
    return m ? 'github:' + m[1] : ''
  }

  /**
   * 目录顶层的 categories 是 id → {zh,en} 的映射对象（不是数组）；
   * 老版本给过数组，所以两种都兼容，统一成 [{id, zh, en}]。
   */
  function normalizeMarketCategories(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map((c) => ({ id: String(c?.id ?? c ?? ''), zh: String(c?.zh ?? c?.en ?? ''), en: String(c?.en ?? '') }))
        .filter((c) => c.id)
        .map((c) => ({ ...c, zh: c.zh || c.id }))
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([id, v]) => ({
        id,
        zh: String(v?.zh ?? v?.en ?? id),
        en: String(v?.en ?? ''),
      }))
    }
    return []
  }

  /** 目录条目归一化：只留 UI 用得到的字段，坏条目直接丢。 */
  function normalizeMarketCatalog(raw) {
    const plugins = Array.isArray(raw?.plugins) ? raw.plugins : []
    return {
      updated: String(raw?.updated ?? ''),
      count: plugins.length,
      categories: normalizeMarketCategories(raw?.categories),
      plugins: plugins
        .map((p) => ({
          name: String(p?.name ?? ''),
          owner: String(p?.owner ?? ''),
          npm: typeof p?.npm === 'string' ? p.npm : '',
          version: String(p?.version ?? ''),
          url: String(p?.url ?? ''),
          page: String(p?.page ?? ''),
          zh: String(p?.description?.zh ?? p?.description?.en ?? ''),
          en: String(p?.description?.en ?? ''),
          categories: (Array.isArray(p?.category) ? p.category : [p?.category]).filter((c) => typeof c === 'string' && c),
          stars: Number(p?.stars ?? 0) || 0,
          downloads: Number(p?.downloads ?? 0) || 0,
          /** 近 30 天下载统计窗口（统计区间的起止，纯粹给 tooltip 用） */
          window: p?.downloadsStart && p?.downloadsEnd ? String(p.downloadsStart) + ' ~ ' + String(p.downloadsEnd) : '',
          /** 上架日期（YYYY-MM-DD），时间范围筛选用 */
          added: String(p?.added ?? ''),
          capabilities: Array.isArray(p?.capabilities) ? p.capabilities.slice(0, 8) : [],
          /** 高危能力项：命中就先在卡片上提醒 */
          redLines: Array.isArray(p?.capabilityRedLines) ? p.capabilityRedLines.map(String) : [],
          spec: marketInstallSpec(p),
        }))
        .filter((p) => p.name && p.spec),
    }
  }

  /**
   * 读插件市场目录：本地缓存 1 小时；refresh=true 强制重拉；
   * 拉取失败时退回旧缓存（标 stale），完全没有才抛错。
   */
  async function loadMarketCatalog(refresh = false) {
    const file = marketCacheFile()
    let cached = null
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed?.catalog?.plugins && parsed.v === MARKET_CACHE_VERSION) {
          cached = { catalog: parsed.catalog, cachedAt: String(parsed.cachedAt ?? '') }
        }
      }
    } catch { cached = null }
    const cacheAge = cached ? Date.now() - Date.parse(cached.cachedAt || 0) : Infinity
    if (cached && cacheAge < 3600_000 && !refresh) return { ...cached, fromCache: true }
    try {
      const res = await fetch(MARKET_CATALOG_URL, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const payload = {
        v: MARKET_CACHE_VERSION,
        catalog: normalizeMarketCatalog(await res.json()),
        cachedAt: new Date().toISOString(),
      }
      if (payload.catalog.plugins.length === 0) throw new Error('目录为空')
      await mkdir(join(resolveDshHome(), 'dsh-curator', 'cache'), { recursive: true })
      await writeFile(file, JSON.stringify(payload), 'utf8')
      return { ...payload, fromCache: false }
    } catch (e) {
      if (cached) return { ...cached, fromCache: true, stale: true, warning: String(e?.message ?? e) }
      throw e
    }
  }

  /** 简单三段版本比较：latest > current 才算有过更新。 */
  function marketVersionOutdated(current, latest) {
    if (!current || !latest) return false
    const parse = (v) => String(v).replace(/^v/i, '').split(/[.+]/)[0].split('.').map((x) => parseInt(x, 10) || 0)
    const a = parse(current)
    const b = parse(latest)
    for (let i = 0; i < 3; i++) {
      if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0)
    }
    return false
  }

  /** 从 npm 安装 spec 反推包名：@scope/name@1.2.3 → @scope/name；name@1.2.3 → name。 */
  function npmNameFromSpec(spec) {
    const scoped = spec.match(/^(@[^/]+\/[^@]+)(?:@[\w.-]+)?$/)
    if (scoped) return scoped[1]
    const plain = spec.match(/^([^@/]+)(?:@[\w.-]+)?$/)
    return plain ? plain[1] : ''
  }

  /**
   * 安装一个插件：dsh CLI（DSH_CLI_PATH → dsh）→ pnpm add 三级退路。
   * 成功后对比 profile dependencies 找出新装包名，交给调用方写 bundles。
   */
  async function marketInstallPackage(spec) {
    if (!MARKET_SPEC_RE.test(spec)) throw new Error('非法包名或 spec: ' + spec)
    const before = JSON.parse(readFileSync(profileManifestPath(), 'utf8'))
    const beforeDeps = Object.keys(before.dependencies ?? {})
    const addArgs = ['plugin', '--profile', resolveProfileName(), 'add', spec]
    const attempts = []
    const cliFromEnv = process.env.DSH_CLI_PATH?.trim()
    if (cliFromEnv) attempts.push({ cmd: cliFromEnv, args: addArgs, cwd: undefined })
    attempts.push({ cmd: 'dsh', args: addArgs, cwd: undefined })
    attempts.push({ cmd: 'pnpm', args: ['add', spec], cwd: profileManifestDir() })
    let lastErr
    for (const a of attempts) {
      try {
        await execFileAsync(a.cmd, a.args, { cwd: a.cwd, shell: true, timeout: 180000 })
        const after = JSON.parse(readFileSync(profileManifestPath(), 'utf8'))
        const added = Object.keys(after.dependencies ?? {}).find((k) => !beforeDeps.includes(k))
        return { via: a.cmd, pkgName: added || npmNameFromSpec(spec) }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error('没有可用的安装通道')
  }


  function profileManifestDir() {
    return join(resolveDshHome(), 'profiles', resolveProfileName())
  }

  /**
   * 扫描桌面端 profile 里已装的 dsh 插件（只读：不装、不卸、不改）。
   * 识别规则：package.json 带 dsh.bundle 或 dsh.client，且不是 @deepseek-ai 官方包。
   * scoped 包（@scope/name）要多走一层目录。
   */
  function listDshPlugins() {
    const root = join(resolveDshHome(), 'profiles', resolveProfileName(), 'node_modules')
    const found = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        // isDirectory() 对 pnpm link 出来的软链接返回 false，会把已装插件漏掉
        //（本机就漏了 dsh-curator 自己和 dsh-workbuddy-off-effort-fix），
        // 所以软链接也要当作目录继续走；depth 上限已经兜住了循环软链接。
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const pkgDir = join(dir, entry.name)
        let pkg
        try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { pkg = undefined }
        if (pkg && typeof pkg.name === 'string' && !pkg.name.startsWith('@deepseek-ai/') && pkg.dsh && (pkg.dsh.bundle || pkg.dsh.client)) {
          found.push({ pkgDir, pkg })
        }
        walk(pkgDir, depth + 1)
      }
    }
    walk(root, 0)
    return found
  }

  /** 给插件挑一份"最可能是中文、最有信息量"的 README 当分析素材。 */
  function pickReadme(pkgDir) {
    let files
    try { files = readdirSync(pkgDir) } catch { return undefined }
    const mds = files.filter((f) => /^readme/i.test(f))
    if (mds.length === 0) return undefined
    const score = (f) =>
      (/zh/i.test(f) ? 2 : 0) - (/[._-]en\b/i.test(f) ? 3 : 0) - (/beginner|changelog|notice|third[-_]party/i.test(f) ? 2 : 0)
    return [...mds].sort((a, b) => score(b) - score(a))[0]
  }

  /** 插件的分析素材：README（截断）+ description + keywords，总体积控制在 8KB 内。 */
  function pluginFullText(pkgDir, pkg) {
    const head = [
      String(pkg.description ?? '').trim(),
      Array.isArray(pkg.keywords) && pkg.keywords.length > 0 ? '关键词: ' + pkg.keywords.join(', ') : '',
    ].filter(Boolean).join('\n')
    let body = ''
    const readme = pickReadme(pkgDir)
    if (readme !== undefined) {
      try { body = readFileSync(join(pkgDir, readme), 'utf8') } catch { body = '' }
    }
    const budget = Math.max(0, 8192 - head.length - 16)
    return (head + (body ? '\n\n# README（节选）\n\n' + body.slice(0, budget) : '')).trim()
  }

  /**
   * DSH 内置技能：随程序打包在 app.asar 里（@deepseek-ai 包的 assets/skills 子目录）。
   * Electron 主进程的 fs 能透读 asar，普通 node 环境（测试）读不到就返回空。
   */
  async function scanBundledDshSkills() {
    try {
      const res = process.resourcesPath
      if (!res) return []
      const nm = join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
      const pkgs = readdirSync(nm, { withFileTypes: true }).filter((e) => e.isDirectory())
      const out = []
      for (const p of pkgs) {
        const pkgDir = join(nm, p.name)
        for (const sub of ['assets', 'skills']) {
          let subs
          try { subs = readdirSync(join(pkgDir, sub), { withFileTypes: true }) } catch { continue }
          for (const e of subs) {
            if (!e.isDirectory()) continue
            const dir = join(pkgDir, sub, e.name)
            if (!existsSync(join(dir, 'SKILL.md'))) continue
            const meta = await readSkillMeta(dir, undefined)
            if (meta) out.push({ ...meta, provider: 'bundled' })
          }
        }
      }
      out.sort((a, b) => a.name.localeCompare(b.name))
      return out
    } catch {
      return []
    }
  }

  /**
   * 自己扫 DSH 的技能。
   * 之前这里代理 @linxin666/dsh-client-ui-skill-explorer 的 /list 接口，
   * 但那个插件已被卸载（而且它新版会拦非浏览器请求），改为本插件直接扫描：
   * 1) 用户库 ~/.dsh/skills —— 真正可管理的技能
   * 2) 程序内置技能（app.asar 包内）—— 只读展示
   * 代价：skill-explorer 独有的 modelInvocable / userInvocable 启停状态
   * 拿不到了——前端在字段缺失时不渲染那两个开关。
   */
  async function scanHarnessSkills(config) {
    const harnessDir = harnessSkillsDir()
    // 用户库里的技能按落盘名比对必然命中自己 → imported 恒为 true，语义上对（它们确实在库里）
    const harnessFolders = new Set(
      (await safeReaddir(harnessDir)).filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()),
    )
    const groups = []
    const dirs = await collectSkillDirs(harnessDir, config.scan?.depth, config.scan?.maxPerSource)
    const userSkills = []
    for (const dir of dirs) {
      const meta = await readSkillMeta(dir, harnessFolders)
      if (meta) userSkills.push({ ...meta, provider: 'dsh' })
    }
    userSkills.sort((a, b) => a.name.localeCompare(b.name))
    groups.push({ key: 'dsh-user', title: '用户库', hint: tildify(harnessDir), skills: userSkills })
    const bundled = await scanBundledDshSkills()
    if (bundled.length > 0) groups.push({ key: 'dsh-bundled', title: 'DSH 内置', hint: '程序自带', skills: bundled })
    return {
      groups,
      total: userSkills.length + bundled.length,
      harnessDir: tildify(harnessDir),
    }
  }

  const routes = [
    /* ---------------- harness 技能（自扫 ~/.dsh/skills） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/harness',
      async handler(_req, res) {
        try {
          const current = await cfg()
          const data = await scanHarnessSkills(current)
          // 把缓存里已有的 AI 分析结果注入到技能上（和 /scan 对称）。
          // 缓存键用 description —— 前端分析时发的 fullText 是空串，服务端就落在了 description 上。
          await cache.load()
          for (const g of data.groups) {
            for (const s of g.skills) {
              const a = s.description ? cache.get(s.description) : undefined
              if (a) s.aiAnalysis = a
            }
          }
          await attachOrigin(data, ledger)
          sendJson(res, 200, data)
        } catch (error) {
          sendJson(res, 500, { groups: [], error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- plugins（本机已装的 dsh 插件，只读） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/plugins',
      async handler(_req, res) {
        try {
          const groups = [{ key: 'plugins', title: 'DSH 插件', hint: '本机已装', skills: [] }]
          await cache.load()
          const manifest = readProfileManifest()
          for (const { pkgDir, pkg } of listDshPlugins()) {
            const fullText = pluginFullText(pkgDir, pkg)
            const spec = String(manifest.deps[pkg.name] ?? '')
            const item = {
              id: 'plugin:' + String(pkg.name),
              name: String(pkg.name),
              version: String(pkg.version ?? ''),
              description: String(pkg.description ?? ''),
              keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 12) : [],
              dir: tildify(pkgDir),
              chars: fullText.length,
              fullText,
              // 来源：link: 前缀 = 本地链接的自建插件，其他 = 从 npm 拉取
              source: spec.startsWith('link:') ? 'link' : 'npm',
              sourceSpec: spec,
              // 启停状态与官方插件页同源：在 dsh.profile.bundles 里 = 启用
              enabled: manifest.bundles.includes(String(pkg.name)),
            }
            const a = fullText !== '' ? cache.get(fullText) : undefined
            if (a) item.aiAnalysis = a
            groups[0].skills.push(item)
          }
          sendJson(res, 200, { groups, total: groups[0].skills.length })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 插件启停（bundles + 用户补丁层双层写） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/plugins/toggle',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          const enabled = body.enabled === true
          // 只拦「停用」：自己被停了 UI 就没了；dshmarket 停了下次想装/卸就没有现成通道。
          // 「启用」是安全的，放行（之前不分方向连启用也拦，导致 dshmarket 启动不了）。
          const isSelf = SELF_PACKAGE_NAME !== '' && name === SELF_PACKAGE_NAME
          if (!enabled && (isSelf || name === 'dshmarket')) {
            sendJson(res, 400, { error: `${name} 不能在这里停用（会把管理入口本身关掉）` })
            return
          }
          const found = listDshPlugins().find((p) => p.pkg.name === name)
          if (!found) {
            sendJson(res, 400, { error: '插件不存在或已卸载: ' + name })
            return
          }
          await backupProfileFiles()
          // 补丁层：插件 insert 的行写 disabled 标志 —— HMR ~1s 内热应用
          const ids = insertedRowIds(found.pkgDir)
          const patchFile = userPatchPath()
          const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '# patch layer\n'
          await writeFile(patchFile, setPatchDisabled(patchText, ids, !enabled), 'utf8')
          // 组合层：官方插件页的开关读 bundles，两层保持一致
          const manifestFile = profileManifestPath()
          const pkg = JSON.parse(readFileSync(manifestFile, 'utf8'))
          const list = pkg.dsh?.profile?.bundles
          if (Array.isArray(list)) {
            const idx = list.indexOf(name)
            if (enabled && idx < 0) list.push(name)
            if (!enabled && idx >= 0) list.splice(idx, 1)
            await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
          }
          sendJson(res, 200, { ok: true, name, enabled, hint: enabled ? '已启用：已写入 profile 配置' : '已停用：已写入 profile 配置' })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 插件卸载（dsh plugin rm = pnpm rm） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/plugins/uninstall',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (SELF_PACKAGE_NAME !== '' && name === SELF_PACKAGE_NAME) {
            sendJson(res, 400, { error: '不能卸载插件自己（会把正在用的页面删掉）；请用 DSH 自带插件页或 dsh CLI' })
            return
          }
          const found = listDshPlugins().find((p) => p.pkg.name === name)
          if (!found) {
            sendJson(res, 400, { error: '插件不存在或已卸载: ' + name })
            return
          }
          const patchText = existsSync(userPatchPath()) ? readFileSync(userPatchPath(), 'utf8') : ''
          if (patchReferencesPackage(patchText, name)) {
            sendJson(res, 409, {
              error: `无法卸载 ${name}：cordis.patch.yml 仍引用它，先移除相关补丁行再卸载（改坏了启动会报错）`,
            })
            return
          }
          await backupProfileFiles()
          await uninstallPluginPackage(name)
          // pnpm 只管 dependencies；bundles 里的残留行要去掉，不然下次启动找不到包
          const manifestFile = profileManifestPath()
          const pkg = JSON.parse(readFileSync(manifestFile, 'utf8'))
          const list = pkg.dsh?.profile?.bundles
          if (Array.isArray(list)) {
            const idx = list.indexOf(name)
            if (idx >= 0) {
              list.splice(idx, 1)
              await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
            }
          }
          sendJson(res, 200, { ok: true, name, hint: '已卸载：已写入 profile 配置' })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 插件市场：目录（公开 JSON，1h 缓存，?refresh=1 强制刷） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/catalog',
      async handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET only' })
          return
        }
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const refresh = url.searchParams.get('refresh') === '1'
          const data = await loadMarketCatalog(refresh)
          sendJson(res, 200, data)
        } catch (error) {
          sendJson(res, 502, { error: '插件市场目录拉取失败: ' + String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 插件市场：更新状态（已装 × 目录版本对比） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/status',
      async handler(_req, res) {
        try {
          let catalogPlugins = []
          try {
            const data = await loadMarketCatalog(false)
            catalogPlugins = data.catalog.plugins
          } catch { /* 目录拉不动时更新检测退化为"无更新"，不挡已安装列表 */ }
          const byNpm = new Map(catalogPlugins.filter((p) => p.npm).map((p) => [p.npm, p]))
          const manifest = readProfileManifest()
          const items = []
          for (const { pkg } of listDshPlugins()) {
            const entry = byNpm.get(String(pkg.name))
            const latest = entry?.version ?? ''
            const hasUpdate = marketVersionOutdated(String(pkg.version ?? ''), latest)
            const spec = String(manifest.deps[pkg.name] ?? '')
            items.push({
              name: String(pkg.name),
              version: String(pkg.version ?? ''),
              latest,
              hasUpdate,
              spec: entry?.spec ?? String(pkg.name),
              description: entry?.zh || String(pkg.description ?? ''),
              /** 和「插件」tab 同源：在 bundles 里 = 启用中 */
              enabled: manifest.bundles.includes(String(pkg.name)),
              /** link: 前缀 = 自建，其余 = 网络拉取 */
              source: spec.startsWith('link:') ? 'link' : 'npm',
            })
          }
          sendJson(res, 200, { updatesCount: items.filter((i) => i.hasUpdate).length, items })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 插件安装（dsh plugin add → pnpm add，成功自动进 bundles） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/plugins/install',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const spec = typeof body.spec === 'string' ? body.spec.trim() : ''
          const expectedName = typeof body.name === 'string' ? body.name.trim() : ''
          // spec 格式在这里先拦（400），marketInstallPackage 里再拦是防其他调用方
          if (!spec || !MARKET_SPEC_RE.test(spec)) {
            sendJson(res, 400, { error: '非法 spec（只允许 npm 包名/带版本、github:owner/repo）: ' + spec })
            return
          }
          if (SELF_PACKAGE_NAME !== '' && expectedName === SELF_PACKAGE_NAME) {
            sendJson(res, 400, { error: SELF_PACKAGE_NAME + ' 已在运行，不需要安装' })
            return
          }
          await backupProfileFiles()
          const { via, pkgName } = await marketInstallPackage(spec)
          const finalName = expectedName || pkgName
          // 自动进 bundles：官方插件页和我们的启停开关都以 bundles 为准
          const manifestFile = profileManifestPath()
          const pkg = JSON.parse(readFileSync(manifestFile, 'utf8'))
          const list = pkg.dsh?.profile?.bundles
          let bundled = false
          if (finalName && Array.isArray(list) && !list.includes(finalName)) {
            list.push(finalName)
            await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
            bundled = true
          }
          sendJson(res, 200, {
            ok: true,
            spec,
            name: finalName,
            via,
            bundled,
            hint: bundled ? '已安装并启用：已写入 profile 配置' : '已安装：已写入 profile 配置',
          })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: '安装失败: ' + String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- config ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/config',
      async handler(req, res) {
        try {
          const current = await cfg()
          if (req.method === 'GET') {
            // 把宿主当前默认模型也带出去：设置页要显示「用 Harness 当前模型」具体是哪一只
            let hostModel = null
            try {
              const sel = ctx?.agentDefaultModel?.currentSelection?.()
              if (sel?.provider && sel?.model) hostModel = { provider: String(sel.provider), model: String(sel.model) }
            } catch {
              /* 服务不可用时就不显示 */
            }
            sendJson(res, 200, {
              config: publicConfig(current),
              paths: { config: tildify(configPath()), cache: tildify(cachePath()) },
              hostModel,
            })
            return
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')
            const next = { ...current }
            if (Array.isArray(body.sources)) next.sources = body.sources
            // 兼容旧客户端的 translate 键
            const incomingSection = body.analyze ?? body.translate
            if (incomingSection && typeof incomingSection === 'object') {
              const incoming = { ...incomingSection }
              // 空 key 或回传的脱敏值 = 保持原 key 不变
              if (incoming.apiKey === undefined || incoming.apiKey === '' || maskKey(incoming.apiKey) === incoming.apiKey) {
                delete incoming.apiKey
              }
              next.analyze = { ...current.analyze, ...incoming }
            }
            if (body.market && typeof body.market === 'object') next.market = { ...current.market, ...body.market }
            if (body.scan && typeof body.scan === 'object') next.scan = { ...current.scan, ...body.scan }
            const saved = await store.save(next)
            cache.maxEntries = saved.analyze?.cacheMaxEntries ?? 0
            cache.prune()
            sendJson(res, 200, { config: publicConfig(saved) })
            return
          }
          sendJson(res, 404, { error: 'not-found' })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/config/reset',
      async handler(req, res) {
        try {
          const saved = await store.save(defaultConfig())
          sendJson(res, 200, { config: publicConfig(saved) })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },

    /* ---------------- scan ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/scan',
      async handler(_req, res) {
        try {
          const current = await cfg()
          const result = await scanAll(current)
          // 把缓存里已有的 AI 分析结果注入到 skill 上，前端刷新即可看到
          await cache.load()
          for (const groupList of Object.values(result.groups ?? {})) {
            for (const g of groupList) {
              for (const s of g.skills ?? []) {
                const src = s.fullText && s.fullText.length > 0 ? s.fullText : s.description
                const a = src ? cache.get(src) : undefined
                if (a) s.aiAnalysis = a
              }
            }
          }
          await attachOrigin(result, ledger)
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/skill',
      async handler(req, res) {
        try {
          const url = new URL(req.url, 'http://localhost')
          const dir = url.searchParams.get('dir') ?? ''
          if (dir === '') {
            sendJson(res, 400, { error: 'missing-dir' })
            return
          }
          const file = join(resolve(expandHome(dir)), 'SKILL.md')
          const text = await readFile(file, 'utf8')
          sendJson(res, 200, { dir, content: text, chars: text.length })
        } catch (error) {
          sendJson(res, 404, { error: String(error?.message ?? error) })
        }
      },
    },

    /* ---------------- import / remove ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/import',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const current = await cfg()
          // 来源标签由服务端反查，不信前端传的：前端只掌握自己渲染出来的那份数据，
          // 而台账要长期保存，写错就永久错
          const fromLabel = sourceLabelFor(current, String(body.dir ?? ''))
          const result = await importSkill(body.dir, body.name, body.overwrite === true, ledger, {
            fromDir: String(body.dir ?? ''),
            fromLabel,
            kind: 'import',
          })
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/remove',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const result = await removeSkill(body.dir, body.name)
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 技能可见性（DSH 原生 frontmatter 键） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/skill/visibility',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const key = String(body.key ?? '')
          /*
           * 两种入参：
           *   { dir, key, enabled } —— 单键（详情页的细粒度开关）
           *   { dir, disabled }     —— 总开关：一次写两个键
           *
           * 总开关走服务端一次落盘，而不是让前端连发两次请求：两次请求之间
           * SKILL.md 会短暂停在"只关了一边"的半截状态，而 DSH 在用 chokidar
           * 监听这些目录，可能正好在那个瞬间重扫，把半截状态当正式状态读进去。
           */
          const both = Object.hasOwn(body, 'disabled')
          if (!both && key !== 'modelInvocable' && key !== 'userInvocable') {
            sendJson(res, 400, { ok: false, error: '不支持的可见性键: ' + key })
            return
          }
          /*
           * 开关值必须是真布尔。
           *
           * 不能只写 `body.enabled === true` 了事：那样 `enabled: "false"`
           * 这种字符串会被判成 false，也就是"关掉"—— 而调用方本来想说的是
           * "别关"。传错类型时**反过来执行**是这条路由最危险的失败模式，
           * 宁可 400。
           */
          const flagValue = both ? body.disabled : body.enabled
          if (typeof flagValue !== 'boolean') {
            sendJson(res, 400, {
              ok: false,
              error: (both ? 'disabled' : 'enabled') + ' 必须是布尔值',
            })
            return
          }
          const target = await assertSkillDir(body.dir)
          const current = await cfg()
          if (!visibilityWritable(current, target)) {
            sendJson(res, 400, { ok: false, error: '这个来源是只读的，不能改可见性' })
            return
          }
          const file = join(target, 'SKILL.md')
          const text = await readFile(file, 'utf8')
          /*
           * 键名必须是 DSH 认的那两个连字符形式。写 modelInvocable /
           * userInvocable / disableModelInvocation 会让 dsh-skill-filesystem
           * 抛 "frontmatter field ... is unsupported"，该技能会被**静默跳过、
           * 从目录里凭空消失**（只有一行 logger.warn）—— 这里错一次就是坏的。
           *
           * 两个键的默认值都是"可见"：拨回开 = 删键（而不是写 false），
           * 少留一个键，别的读同一份 frontmatter 的工具看到的仍是干净状态。
           */
          const off = flagValue === true
          const edits = both
            ? [
                ['disable-model-invocation', off ? true : undefined],
                ['user-invocable', off ? false : undefined],
              ]
            : [
                [
                  key === 'modelInvocable' ? 'disable-model-invocation' : 'user-invocable',
                  flagValue === true ? undefined : key === 'modelInvocable',
                ],
              ]
          let next = text
          for (const [field, value] of edits) next = setFrontmatterFlag(next, field, value)
          await atomicWrite(file, next)
          sendJson(
            res,
            200,
            both
              ? { ok: true, both: true, disabled: off }
              : { ok: true, key, enabled: flagValue, field: edits[0][0] },
          )
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    /* ---------------- 回收站 ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/trash',
      async handler(req, res) {
        try {
          const items = await listTrash()
          sendJson(res, 200, { items, dir: tildify(trashDir()), total: items.length })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/trash/restore',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          sendJson(res, 200, await restoreTrash(String(body.id ?? '')))
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/trash/purge',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          sendJson(res, 200, await purgeTrash(String(body.id ?? '')))
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/trash/empty',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        try {
          sendJson(res, 200, await emptyTrash())
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/analyze/cache',
      async handler(req, res) {
        try {
          await cache.load()
          if (req.method === 'DELETE') {
            await cache.clear()
            sendJson(res, 200, { ok: true, ...cache.stats() })
            return
          }
          sendJson(res, 200, cache.stats())
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },

    /* ---------------- AI 分析（结构化：summary/usage/triggers） ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/analyze',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        try {
          const current = await cfg()
          const body = JSON.parse((await readBody(req)) || '{}')
          const incoming = Array.isArray(body.items) ? body.items : []
          if (incoming.length === 0) {
            sendJson(res, 400, { error: 'no-items' })
            return
          }
          if (current.analyze.enabled !== true) {
            // 只回错误码，文案交给前端 i18n；hint 留着给不认识 code 的老前端兜底
            sendJson(res, 200, {
              analyses: {},
              analyzed: 0,
              disabled: true,
              code: 'analyze-disabled',
              hint: 'AI 分析未启用：请在「设置」里勾选启用并填写端点与模型，然后点底部"保存"。',
            })
            return
          }
          // 设置页的「测试连接」会带 noCache：探针不该在正式缓存里占一条
          const useCache = body.noCache !== true
          await cache.load()

          const result = {}
          const pending = []
          for (const item of incoming) {
            const key = String(item.key ?? '')
            const description = String(item.description ?? '')
            const fullText = String(item.fullText ?? '')
            const cacheSource = fullText !== '' ? fullText : description
            if (key === '' || cacheSource === '') continue
            if (useCache) {
              const cached = cache.get(cacheSource)
              if (cached !== undefined) {
                result[key] = cached
                continue
              }
            }
            pending.push({ key, name: String(item.name ?? ''), description, fullText, cacheSource })
          }
          if (pending.length === 0) {
            sendJson(res, 200, { analyses: result, analyzed: 0, cached: Object.keys(result).length })
            return
          }

          const acfg = current.analyze
          const hasHttp = acfg.baseUrl.trim() !== '' && acfg.model.trim() !== ''
          // 通道由 mode 决定：宿主模型优先（零配置），自定义端点作为可选项/兜底
          const mode = acfg.mode === 'endpoint' ? 'endpoint' : 'host'
          let usedPath = mode === 'host' ? 'host' : hasHttp ? 'http' : 'none'
          // 切批并发跑，不要串行等
          const batches = []
          for (let i = 0; i < pending.length; i += acfg.batchSize) {
            batches.push(pending.slice(i, i + acfg.batchSize))
          }
          const CONCURRENCY = Math.max(1, acfg.concurrency || 2)
          const MAX_ROUNDS = 3
          // 每个批次带自己的尝试计数（历史上这里是"失败就无条件 push 回队列"，
          // 导致 while 永远退不出去、端点不可用时热自旋或挂死，已修正为计数 + deadline 双保险）
          const queue = batches.map((items) => ({ items, attempts: 0 }))
          // 全局兜底：不管重试怎么排，总时长不超过这个上限
          const deadline = Date.now() + Math.min(600000, Math.max(120000, acfg.timeoutMs * MAX_ROUNDS))
          const failedMap = {}
          // 上一次落盘时的结果条数：用来跳过"这一批没有新东西"时的空写
          let flushedEntries = Object.keys(result).length

          /**
           * 增量落盘。跑一次全量可能要十几分钟，中途刷新页面/关窗口/退出桌面端都会让
           * 已经花掉的模型调用作废 —— 所以在每批有结果之后就写盘，而不是等最后一次性写。
           * 节流 2s，避免批次很小的时候把磁盘写爆；收尾再强制写一次。
           */
          let lastFlushAt = 0
          async function flushCache(force = false) {
            const now = Date.now()
            if (!force && now - lastFlushAt < 2000) return
            lastFlushAt = now
            const count = Object.keys(result).length
            if (count === flushedEntries && !force) return
            flushedEntries = count
            cache.prune()
            await cache.flush().catch(() => {})
          }

          // 一个 worker 退出（超时/中止）后，其余 worker 也要尽快收敛，别继续开新请求
          let aborted = false
          const DEADLINE_MSG = '总时长超过上限，已中止（未跑完的条目下次会接着分析）'

          async function runWorker() {
            while (queue.length > 0) {
              const job = queue.shift()
              if (job === undefined) break
              // deadline 是硬中断：原来只在"要不要重排队"时判定，首次尝试拦不住，
              // 端点超时时每个批次仍会跑满 3×timeoutMs，176 批能挂十几个小时。
              if (aborted || Date.now() >= deadline) {
                aborted = true
                for (const item of job.items) {
                  if (result[item.key] === undefined) failedMap[item.key] = DEADLINE_MSG
                }
                continue
              }
              const batch = job.items
              let fresh
              let lastErr
              try {
                if (mode === 'host') {
                  // 宿主模型优先；只有它挂了、又配了端点时才退到端点
                  fresh = await analyzeBatchViaHost(ctx, acfg, batch)
                  usedPath = 'host'
                } else if (hasHttp) {
                  fresh = await analyzeBatch(acfg, batch, deadline)
                  usedPath = 'http'
                } else if (acfg.useHostFallback) {
                  fresh = await analyzeBatchViaHost(ctx, acfg, batch)
                  usedPath = 'host'
                } else {
                  throw new Error('未配置分析端点，且已关闭宿主模型回退')
                }
              } catch (error) {
                lastErr = String(error?.message ?? error)
                fresh = undefined
                if (mode === 'host' && hasHttp) {
                  try {
                    fresh = await analyzeBatch(acfg, batch, deadline)
                    usedPath = 'http-fallback'
                    lastErr = undefined
                  } catch (e2) {
                    lastErr = lastErr + ' | endpoint: ' + String(e2?.message ?? e2)
                  }
                } else if (mode === 'endpoint' && hasHttp && acfg.useHostFallback) {
                  try {
                    fresh = await analyzeBatchViaHost(ctx, acfg, batch)
                    usedPath = 'host-fallback'
                    lastErr = undefined
                  } catch (e2) {
                    lastErr = lastErr + ' | host: ' + String(e2?.message ?? e2)
                  }
                }
              }
              let got = 0
              for (const item of batch) {
                const a = fresh?.[item.key]
                if (a && a.summary) {
                  result[item.key] = a
                  if (useCache) {
                    cache.data.entries[cache.key(item.cacheSource)] = { analysis: a, at: new Date().toISOString() }
                  }
                  got++
                }
              }
              // 每批拿到结果就落盘，别攒到最后
              if (got > 0 && useCache) await flushCache()
              // 整批都拿到结果，收工
              if (got === batch.length) continue
              // 只有整批全失败才重排队，且次数有限
              if (got === 0) {
                job.attempts += 1
                if (job.attempts < MAX_ROUNDS && Date.now() < deadline) {
                  queue.push(job)
                  continue
                }
              }
              // 走到这里＝已放弃这一批（或只成功了一部分），把没结果的记成失败
              const reason = String(lastErr ?? '模型没有返回这一条的结果')
              const suffix = got === 0 ? `（已重试 ${job.attempts} 轮）` : ''
              for (const item of batch) {
                if (result[item.key] === undefined) failedMap[item.key] = (reason + suffix).slice(0, 300)
              }
            }
          }

          // 跑满 CONCURRENCY 个 worker；队列排空后它们会自己退出。
          // 原来外面还套一层 for(round<MAX_ROUNDS)：内层 while 已经把队列清空，
          // 那层条件恒假，永远只跑一轮，纯死代码。
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runWorker))
          if (useCache) await flushCache(true)

          const analyzedCount = pending.filter((item) => result[item.key] !== undefined).length
          sendJson(res, 200, {
            analyses: result,
            // analyzed = 这一轮真的调了模型的条数；analyses 里还含缓存命中的
            analyzed: analyzedCount,
            cached: Object.keys(result).length - analyzedCount,
            failed: Object.entries(failedMap).map(([key, error]) => ({ key, error })),
            pending: pending.length,
            truncated: aborted === true,
            path: usedPath,
          })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },

    /* ---------------- market ---------------- */
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/search',
      async handler(req, res) {
        try {
          const current = await cfg()
          const url = new URL(req.url, 'http://localhost')
          // source: ''=所有来源(后端已聚合) / community=SkillHub / clawhub=ClawHub
          const rawSource = (url.searchParams.get('source') ?? '').trim()
          const source = ['community', 'clawhub', 'enterprise'].includes(rawSource) ? rawSource : ''
          const q = (url.searchParams.get('q') ?? '').trim()
          const category = (url.searchParams.get('category') ?? '').trim()
          const sort = (url.searchParams.get('sort') ?? '').trim()
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = current.market.pageSize

          // skillhub.cn 已聚合 community+clawhub，统一走它，不再单独调 clawhub.ai
          const result = await searchSkillHub(current.market.skillhubApiBase, { q, category, sort, source, page, pageSize })
          sendJson(res, 200, { source, page, pageSize, ...result })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/categories',
      async handler(req, res) {
        try {
          const current = await cfg()
          const url = new URL(req.url, 'http://localhost')
          const source = url.searchParams.get('source') === 'clawhub' ? 'clawhub' : 'skillhub'
          const categories = source === 'clawhub' ? [] : await skillhubCategories(current.market.skillhubApiBase)
          sendJson(res, 200, { source, categories })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/detail',
      async handler(req, res) {
        try {
          const current = await cfg()
          const url = new URL(req.url, 'http://localhost')
          const slug = (url.searchParams.get('slug') ?? '').trim()
          if (!slug) { sendJson(res, 400, { error: 'missing-slug' }); return }
          const json = await httpGetJson(`${current.market.skillhubApiBase}/api/v1/skills/${encodeURIComponent(slug)}`)
          const s = json?.skill ?? {}
          const sec = json?.securityReports ?? {}
          const security = []
          for (const [name, rep] of Object.entries(sec)) {
            if (rep && rep.status) security.push({ name: name === 'keen' ? '科恩实验室' : name === 'sanbu' ? '三不实验室' : name, status: rep.status, statusText: rep.statusText ?? '', reportUrl: rep.reportUrl ?? '' })
          }
          sendJson(res, 200, {
            slug: json?.slug ?? slug,
            description: s.overviewMd ?? s.summary_zh ?? s.summary ?? '',
            summary: s.summary_zh ?? s.summary ?? '',
            owner: json?.owner ? { displayName: json.owner.displayName, handle: json.owner.handle, image: json.owner.image } : undefined,
            version: json?.latestVersion?.version ?? '',
            changelog: json?.latestVersion?.changelog ?? '',
            createdAt: json?.latestVersion?.createdAt,
            stats: s.stats ?? {},
            subCategories: (s.subCategories ?? []).map((c) => c?.name ?? c?.key ?? c).filter(Boolean),
            requiresApiKey: s.labels?.requires_api_key === 'true' || s.labels?.requires_api_key === true,
            security,
          })
        } catch (error) {
          sendJson(res, errorStatus(error), { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-curator/market/install',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        let workDir
        let archive
        try {
          const current = await cfg()
          const body = JSON.parse((await readBody(req)) || '{}')
          const source = body.source === 'clawhub' ? 'clawhub' : 'skillhub'
          const slug = String(body.slug ?? '').trim()
          if (slug === '') {
            sendJson(res, 400, { error: 'missing-slug' })
            return
          }
          archive = await downloadSkillPackage(current.market, source, slug)
          workDir = join(resolveDshHome(), 'dsh-curator', 'tmp', `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
          await extractPackage(archive, workDir)
          const skillDir = await locateExtractedSkill(workDir)
          if (skillDir === undefined) throw new Error('压缩包里没有找到 SKILL.md')
          const name = String(body.name ?? basename(skillDir)).trim()
          // 市场装进来的技能没有本地来源目录：那份临时解压目录马上就删了，
          // 记下来只会得到一个"来源永远不存在"的假溯源
          const result = await importSkill(skillDir, name, body.overwrite === true, ledger, {
            fromDir: '',
            fromLabel: '',
            kind: 'market',
            marketSource: source,
          })
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        } finally {
          // 压缩包本体也要删：之前只清了解压目录，tmp 里会一直堆包
          if (workDir !== undefined) await rm(workDir, { recursive: true, force: true }).catch(() => {})
          if (archive !== undefined) await rm(archive, { force: true }).catch(() => {})
        }
      },
    },
  ]

  ctx.effect(
    () => {
      // 写操作一律先过同源校验再进 handler。
      const disposers = routes.map((route) =>
        ctx.webServer.register({
          ...route,
          async handler(req, res) {
            if (!originAllowed(req)) {
              sendJson(res, 403, {
                error: '已拦下跨站写请求：来源既不是本机，也不是 JSON 请求体。'
                  + '（用脚本调的话：别带 Origin 头，或把它设成 http://127.0.0.1:<port>）',
              })
              return
            }
            return route.handler(req, res)
          },
        }),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-curator: routes',
  )

  ctx.logger?.info?.(`[dsh-curator] 已挂载，配置：${configPath()}`)

  // 启动时清一次 tmp：历史遗留的压缩包/解压目录不会自己消失
  sweepTmp(join(resolveDshHome(), 'dsh-curator', 'tmp'))
    .then(() => {})
    .catch(() => {})
}
