/**
 * 发布前的最小回归（零依赖、零外部服务，`npm test` 就跑它）。
 *
 * 为什么只有这些：本项目的完整回归在开发工作区里（会起真 DSH、真浏览器），
 * 没法随包发布。这里放的是「打包坏了 / 安全红线被踩 / 纯函数算错」这三类
 * **不需要运行环境**就能抓住的问题 —— 也正是发布前最容易翻车的地方。
 *
 * 所有断言都读仓库自己的文件，路径相对本文件，任何机器上都能跑。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const exists = (p) => fs.existsSync(new URL(p, import.meta.url))

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ok   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra !== undefined ? '  ->  ' + extra : '')) }
}

const pkg = JSON.parse(read('../package.json'))
const clientSrc = read('../lib/client.js')
const hostSrc = read('../lib/index.js')

/* ---------- 1. 打包完整性：发出去的包里该有的都在 ---------- */
console.log('== 1. 打包完整性 ==')
check('name 是 dsh-curator', pkg.name === 'dsh-curator', pkg.name)
check('version 是合法 semver', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version), pkg.version)
for (const file of pkg.files) {
  check('files 里的 ' + file + ' 真实存在', exists(new URL('../' + file, import.meta.url).href.replace('file:///', '')) || fs.existsSync(`${ROOT}${file}`))
}
check('main 指向已存在的文件', fs.existsSync(`${ROOT}${pkg.main}`), pkg.main)
for (const [key, target] of Object.entries(pkg.exports)) {
  check('exports["' + key + '"] 指向已存在的文件', fs.existsSync(`${ROOT}${target}`), target)
}
check('dsh.bundle.patch 指向已存在的文件', fs.existsSync(`${ROOT}${pkg.dsh.bundle.patch}`), pkg.dsh.bundle.patch)
check('声明了 dsh.client（否则前端不会加载）', pkg.dsh?.client?.platform === 'web')
check('声明了 dsh.engines.dsh（安装前宿主会校验）', typeof pkg.dsh?.engines?.dsh === 'string', String(pkg.dsh?.engines?.dsh))
check('repository / homepage / bugs 三个字段齐全（npm 页面要链 GitHub）',
  !!pkg.repository?.url && !!pkg.homepage && !!pkg.bugs?.url)
check('没有把测试目录打进 files', !pkg.files.some((f) => /^test\//.test(f)), JSON.stringify(pkg.files))

/* ---------- 2. 前端入口：client.js 必须真的注册进模块加载器 ---------- */
console.log('\n== 2. 前端入口 ==')
check('client.js 里有 __ModuleLoader__.load 注册', clientSrc.includes('__ModuleLoader__'))
check('client.js 注册了面板 id', clientSrc.includes('dsh-curator'))
check('client.js 里没有语法截断（以 factory 结构收尾）', /window\.__ModuleLoader__\.load\(/.test(clientSrc))

/* ---------- 3. 纯函数：版本比较 ---------- */
console.log('\n== 3. 版本比较（从 client.js 抠真实实现） ==')
function grab(src, name) {
  const head = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`).exec(src)
  if (!head) throw new Error('找不到 function ' + name)
  const start = head.index + head[0].length - 1
  let depth = 0
  for (let k = start; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1
    else if (src[k] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(head.index, k + 1)
    }
  }
  throw new Error('函数不配平: ' + name)
}
const compareVersions = new Function(grab(clientSrc, 'compareVersions') + '\nreturn compareVersions;')()
const versionCases = [
  ['0.9.11', '0.9.15', -1],
  ['0.74.0', '0.77.0', -1],
  ['1.66.47', '1.70.2', -1],
  ['0.28.0', '0.28.0', 0],
  ['0.77.0', '0.74.0', 1],
  ['1.0.9', '1.0.10', -1],
  ['1.0.0-rc.1', '1.0.0', -1],
  ['1.0.0+build.5', '1.0.0', 0],
  ['v1.2.0', '1.3.0', -1],
  ['1.0', '1.0.0', 0],
]
for (const [a, b, want] of versionCases) {
  const got = compareVersions(a, b)
  check(`${a} vs ${b} => ${want}`, got === want, String(got))
}

/* ---------- 4. 纯函数：失败文案 ---------- */
console.log('\n== 4. 失败文案（humanizeFailure） ==')
const humanize = new Function(grab(clientSrc, 'humanizeFailure') + '\nreturn humanizeFailure;')()
check('最低发布年龄被翻成人话', humanize('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  dsh-x@1.0.0 was published 2 hours ago').includes('24 小时'))
check('peer 不兼容保留可复制的 allow-version 命令',
  humanize('Plugin a@1.0.0 is incompatible with dsh 0.2.1-rc.3: requirements {}').includes('dsh plugin allow-version a@1.0.0 --dsh-version 0.2.1-rc.3 --accept-risk'))
check('已装包提示去点「更新」', humanize('x is already installed').includes('「更新」'))
check('ANSI 颜色被剥掉', !humanize('\u001b[31mERR_PNPM_FETCH_404\u001b[0m 404 Not Found').includes('\u001b'))
check('纯进度日志返回空串（交给调用方兜底）', humanize('Progress: resolved 1\ndone') === '')
check('超长未知错误截到 300 字以内', humanize('x'.repeat(5000)).length <= 300)

/* ---------- 5. 防谎报：application 白名单 ---------- */
console.log('\n== 5. 官方结果白名单 ==')
const outcomeSrc = grab(clientSrc, 'officialOutcome')
for (const value of ['applied', 'restart-required', 'overridden']) {
  check('白名单包含 ' + value, outcomeSrc.includes('"' + value + '"'))
}
check('未知状态走失败分支', outcomeSrc.includes('pmUnknownOutcome'))

/* ---------- 5b. 官方 remote 调用的实参个数 ----------
 * 回归背景（2026-10-27 用户报障）：Client→Host 的 remote 桥按 descriptor 声明的
 * 参数个数**严格校验实参个数**。官方 rc.3 的签名是
 * `inspect(spec, options?: InspectOptions, signal?: AbortSignal)`，options 可选但占位，
 * 只传 1 个实参就被桥拦下：
 *   client api: pluginManager/inspect expected 2 business argument(s) plus an optional
 *   AbortSignal, got 1
 * 这里用「和桥一样严格」的桩真调一次 officialInstall，钉死实参个数。 */
console.log('\n== 5b. 官方 remote 实参个数（真调用 officialInstall） ==')
const remoteArgs = []
const strictApi = {
  // 复刻 prepareInvocation：expected = descriptor.parameters.length（2），带 cancellation
  inspect(...args) {
    remoteArgs.push(['inspect', args.length, args[1]])
    if (args.length !== 2) {
      throw new Error(`client api: pluginManager/inspect expected 2 business argument(s) plus an optional AbortSignal, got ${args.length}`)
    }
    if (args[1] !== undefined && (args[1] === null || typeof args[1] !== 'object')) {
      throw new Error('inspect: options 只接受 undefined 或对象，收到 ' + String(args[1]))
    }
    return Promise.resolve({ ok: true, value: { status: 'accepted', kind: 'registry', name: 'dsh-demo', version: '1.0.0', bundle: true, registry: null } })
  },
  installBundle(...args) {
    remoteArgs.push(['installBundle', args.length])
    if (args.length !== 2) throw new Error(`client api: pluginManager/installBundle expected 2 argument(s), got ${args.length}`)
    return Promise.resolve({ ok: true, value: { application: 'applied' } })
  },
}
const officialInstall = new Function(
  'officialPluginApi', 'tr', 'officialOutcome', 'invalidatePhases', 'crypto',
  // grab() 从 `function` 关键字起截，`async` 前缀要自己补回去
  'async ' + grab(clientSrc, 'officialInstall') + '\nreturn officialInstall;',
)(
  () => strictApi,
  (key) => key,
  (result, okText) => ({ ok: true, text: okText }),
  () => {},
  { randomUUID: () => 'req-test-1' },
)
const installResult = await officialInstall('dsh-demo')
check('officialInstall 不再被 client api 桥拦下', installResult.ok === true, installResult.text)
const inspectCall = remoteArgs.find((entry) => entry[0] === 'inspect')
check('inspect 收到 2 个实参（options 位置显式传 undefined）',
  inspectCall !== undefined && inspectCall[1] === 2 && inspectCall[2] === undefined,
  JSON.stringify(inspectCall))
const installCall = remoteArgs.find((entry) => entry[0] === 'installBundle')
check('installBundle 收到 2 个实参（spec + options）', installCall !== undefined && installCall[1] === 2, JSON.stringify(installCall))

/* ---------- 6. 安全红线 ---------- */
console.log('\n== 6. 安全红线 ==')
check('没有 eval(', !/\beval\s*\(/.test(hostSrc) && !/\beval\s*\(/.test(clientSrc))
check('没有 new Function(', !/new\s+Function\s*\(/.test(hostSrc) && !/new\s+Function\s*\(/.test(clientSrc))
check('没有 document.write', !/document\.write/.test(clientSrc))
check('innerHTML 只用于注入静态样式常量',
  (clientSrc.match(/dangerouslySetInnerHTML/g) ?? []).length === 1
  && clientSrc.includes('SKILL_BTN_CSS'))
// 先去掉整行注释再看：注释里提到 `shell: true` 是在解释"为什么不这么写"，不算违规
const codeOnly = (src) => src.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
check('没有打开 shell:true 的执行代码（只允许注释里提到）', !/shell:\s*true/.test(codeOnly(hostSrc)))
check('没有写死本机用户目录', !/C:\\\\Users\\\\/i.test(hostSrc) && !/C:\\\\Users\\\\/i.test(clientSrc))
check('没有内网地址写死', !/https?:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostSrc))
check('没有疑似密钥的长字符串', !/[A-Za-z0-9_-]{40,}/.test(pkg.description))

/* ---------- 7. 命名与补丁层一致性 ---------- */
console.log('\n== 7. 命名一致性 ==')
const patch = read('../cordis.patch.yml')
check('cordis.patch.yml 里的 id 与包名一致', patch.includes(`- id: ${pkg.name}`), '缺 insert id')
check('cordis.patch.yml 里的 name 与包名一致', patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`))
check('package.json 不含旧名 skill-station / dsh-skill-deck',
  !/skill-station|dsh-skill-deck/.test(JSON.stringify(pkg)))
check('cordis.patch.yml 不含旧名', !/skill-station|dsh-skill-deck/.test(patch))

console.log(`\nresult: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
