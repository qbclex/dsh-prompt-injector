/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/dsh-tools` 的 defineTool
 * ============================================================================
 * 🔴 为什么要有它（dsh-bili-scroll 在桌面版踩过的实坑）：
 *    `@deepseek-ai/dsh-tools` 是 optional peer，桌面版 profile（autoInstallPeers: false）
 *    **永远不装它** ⇒ index.js 顶部裸 import 会让整条插件不激活，DSH 只留一句
 *    `warning: 1 entry did not activate … failed to import`。
 *
 * ⭐ 策略：
 *   ① 优先从宿主那棵树里解析（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 bare import（靠我们自己 package.json 的 dependencies 保底）；
 *   ③ 彻底拿不到 ⇒ 用本地等价实现顶上 —— **绝不因为一个 import 让整条插件不激活**。
 *      本地实现把我们扁平的 parameters spec（`{ 字段: { type, description } }`）
 *      转成标准 JSON Schema 根（tools.register 吃的就是这个形状），行为与宿主版对齐。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件自己那棵树（dependencies 装出来的那份）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 插件自己那份 —— 放最后，前面优先“跟宿主同一份”
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/** 试从宿主树里 import 一个包；拿不到返回 null（失败原因写进 notes，方便排查） */
async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/**
 * 本地等价实现（只在拿不到宿主 dsh-tools 时用）：
 * 把扁平 spec 转成 tools.register 认的标准 ToolDefinition 形状。
 */
function localDefineTool(options, log) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(options.parameters || {})) {
    props[k] = { ...v }
    if (v && v.required) { required.push(k); delete props[k].required }
  }
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`)
  return {
    ...options,
    parameters: { type: 'object', additionalProperties: false, properties: props, ...(required.length ? { required } : {}) },
  }
}

/**
 * 取回宿主半端要用的一点点东西
 * @returns {Promise<{defineTool:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let defineTool = null
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`); dtMod = null }
  }
  defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  return { defineTool, notes }
}
