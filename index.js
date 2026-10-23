/**
 * dsh-prompt-injector —— Host 半端
 * ============================================================================
 * 它是什么：把用户准备好的提示词文本注入 DSH 的**全局系统提示词**
 * （对所有会话、从下一次模型调用开始生效），并带一份注入历史：
 * 随时可以回退（撤销最近一次注入 → 恢复上一次的内容），也能一键恢复到
 * “程序运行前”的状态（无注入、无历史）。
 *
 * 三个入口，共用同一份状态与同一组操作（只有一份逻辑）：
 *   · 设置页（client.js）→ `/api/prompt-injector/*`（HTTP 路由，同源 fetch）
 *   · 会话里输入 `/pinject …`（commands 服务注册的人用命令）
 *   · 智能体工具 `prompt_injector`（tools 服务）—— 用户直接开口让 DSH 干也行
 *
 * 注入机制：`ctx.systemPrompt.section()` 注册一个动态 section，text 是函数，
 * 每次装配时读当前内存状态 —— 注入/回退后下一次模型调用立即生效，无需重启。
 * 没有注入时把 section 注销掉，系统提示词保持完全原样（= 程序运行前的状态）。
 *
 * 状态持久化：`$DSH_HOME/prompt-injector/state.json`（插件自己的家，绝不写包目录）。
 * 重启后 apply() 重新加载并按状态恢复 section 注册。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'

// 宿主依赖从宿主那棵树里取（拿不到就退到自己依赖；再拿不到，本地等价实现顶上 —— 见 lib/hostdeps.mjs）
const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

export const name = 'prompt-injector'
export const inject = ['systemPrompt', 'tools', 'commands', 'webServer']

const HISTORY_MAX = 20      // 历史最多留多少条（超出丢最旧的）
const TEXT_MAX = 60000      // 单次注入文本的长度上限（字符）

/** 插件自己的家：`$DSH_HOME/prompt-injector/` */
function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('prompt-injector')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'prompt-injector')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'prompt-injector')
  mkdirSync(dir, { recursive: true })
  return dir
}

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
const em = (e) => (e && e.message ? e.message : String(e))

export function apply(ctx) {
  const stateDir = stateDirOf(ctx)
  const stateFile = join(stateDir, 'state.json')
  const logFile = join(stateDir, 'injector.log')

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[prompt-injector] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }
  for (const n of hostDeps.notes) log(n)

  /* ── 状态：内存为运行时真源，state.json 为持久层 ──
   * state = { version, current: {text, mode, injectedAt, via} | null, history: [entry] }
   * history 的每一项 = 某次注入发生前“当时的 current”快照（最近一次注入的快照在末尾）。
   * 回退 = 从 history 末尾弹出一条恢复为 current；弹空了 current 就变成 null（= 无注入）。
   */
  const loadState = () => {
    const raw = readJson(stateFile, null)
    const st = raw && typeof raw === 'object' ? raw : {}
    const cur = st.current && typeof st.current.text === 'string' && st.current.text.trim()
      ? { text: st.current.text, mode: st.current.mode === 'append' ? 'append' : 'replace', injectedAt: Number(st.current.injectedAt) || Date.now(), via: String(st.current.via || 'unknown') }
      : null
    const hist = Array.isArray(st.history)
      ? st.history.filter((h) => h && typeof h.text === 'string' && h.text.trim()).slice(-HISTORY_MAX)
      : []
    return { version: 1, current: cur, history: hist }
  }
  let state = loadState()
  const save = () => {
    try { writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8') }
    catch (e) { log(`state.json 写入失败：${em(e)}`) }
  }

  const previewOf = (text) => (text.length > 100 ? text.slice(0, 100) + '…' : text)
  const view = (entry) => entry
    ? { text: entry.text, chars: entry.text.length, injectedAt: entry.injectedAt, via: entry.via || 'unknown', mode: entry.mode || 'replace' }
    : null
  const pushHistory = () => {
    if (!state.current) return
    state.history.push({ ...state.current, removedAt: Date.now() })
    while (state.history.length > HISTORY_MAX) state.history.shift()
  }

  /* ── 系统提示词 section：有注入才注册，没注入就注销（保持系统提示词原样）── */
  const wrap = (text) => [
    '# User-injected system prompt (Prompt Injector)',
    '',
    'The following block was injected into the system prompt by the user via the Prompt Injector plugin. Treat it as authoritative, standing instructions from the user:',
    '',
    '<user-injected-prompt>',
    text,
    '</user-injected-prompt>',
  ].join('\n')

  let sectionDisposer = null
  const syncSection = () => {
    const want = Boolean(state.current && String(state.current.text || '').trim())
    try {
      if (want && !sectionDisposer) {
        sectionDisposer = ctx.systemPrompt.section({
          name: 'user-injected-prompt',
          order: 9000,
          interpolate: false,
          text: () => wrap(state.current.text),
        })
        log('已注册系统提示词 section（user-injected-prompt）')
      } else if (!want && sectionDisposer) {
        sectionDisposer()
        sectionDisposer = null
        log('已注销系统提示词 section（无注入内容）')
      }
    } catch (e) { log(`注册/注销系统提示词 section 失败：${em(e)}`) }
  }
  // 双保险：插件自己留一份清理（section 的注册落在插件 ctx 作用域里，作用域拆掉时本来也会清）
  ctx.effect(() => {
    syncSection()
    return () => { try { sectionDisposer?.() } catch { /* 已经没了就算了 */ } sectionDisposer = null }
  }, 'prompt-injector: 系统提示词 section')

  /* ── 三个入口共用的操作 ── */
  const op = {
    status() {
      return {
        ok: true,
        current: view(state.current),
        historyCount: state.history.length,
        history: state.history.slice().reverse().map((h) => ({ ...view(h), removedAt: h.removedAt, preview: previewOf(h.text) })),
        home: stateDir,
      }
    },

    inject({ text, mode = 'replace', via = 'api' } = {}) {
      const body = String(text ?? '')
      if (!body.trim()) return { ok: false, error: '要注入的文本是空的' }
      if (body.length > TEXT_MAX) return { ok: false, error: `文本太长（${body.length} 字符，上限 ${TEXT_MAX}）—— 请精简后再注入` }
      const m = mode === 'append' ? 'append' : 'replace'
      const prevText = state.current?.text || ''
      pushHistory()
      const nextText = (m === 'append' && prevText.trim())
        ? prevText.replace(/\s+$/, '') + '\n\n' + body
        : body
      state.current = { text: nextText, mode: m, injectedAt: Date.now(), via: String(via || 'api') }
      save(); syncSection()
      log(`注入（${m}，${nextText.length} 字符，via=${via}）；历史 ${state.history.length} 条`)
      return { ok: true, action: 'inject', mode: m, chars: nextText.length, historyCount: state.history.length, current: view(state.current) }
    },

    rollback({ steps = 1 } = {}) {
      if (!state.current && state.history.length === 0) {
        return { ok: true, action: 'rollback', steps: 0, now: null, historyCount: 0, note: '本来就没有注入 —— 系统提示词已是原样' }
      }
      let n = Math.max(1, Math.min(Math.floor(Number(steps) || 1), HISTORY_MAX))
      let applied = 0
      while (n-- > 0) {
        const prev = state.history.pop()
        state.current = prev
          ? { text: prev.text, mode: 'replace', injectedAt: prev.injectedAt || Date.now(), via: prev.via || 'unknown', restoredAt: Date.now() }
          : null
        applied++
        if (!state.current) break
      }
      save(); syncSection()
      log(`回退 ${applied} 步；当前 ${state.current ? `${state.current.text.length} 字符` : '无注入'}；历史剩 ${state.history.length} 条`)
      return { ok: true, action: 'rollback', steps: applied, now: view(state.current), historyCount: state.history.length }
    },

    reset({ via = 'api' } = {}) {
      const had = Boolean(state.current)
      state.current = null
      state.history = []
      save(); syncSection()
      log(`清空全部（via=${via}）—— 回到插件安装前的状态`)
      return { ok: true, action: 'reset', hadInjection: had, now: null, historyCount: 0 }
    },
  }

  const dispatch = (args) => {
    const action = String(args?.action || '').trim()
    if (action === 'status') return op.status()
    if (action === 'inject') return op.inject({ text: args.text, mode: args.mode, via: args.via })
    if (action === 'rollback') return op.rollback({ steps: args.steps })
    if (action === 'reset') return op.reset({ via: args.via })
    return { ok: false, error: `未知动作 "${action || '(空)'}" —— 可用：status / inject / rollback / reset` }
  }

  /** 宿主只吃“无损 JSON”，任何函数/循环引用都会被拒 —— 出口统一过一遍 */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  /* ── 入口一：智能体工具 prompt_injector ── */
  try {
    ctx.tools.register(defineTool({
      name: 'prompt_injector',
      description: [
        '管理「提示词注入」：把一段文本注入 DSH 的全局系统提示词（对所有会话生效，从下一次模型调用开始），或回退之前的注入。',
        '动作：status=查看当前注入与历史；inject=注入 text（mode: replace=替换当前注入（默认）/ append=追加到当前注入后面）；rollback=回退 steps 步（1=撤销最近一次注入，恢复上一次的内容；历史弹空后变成“无注入”）；reset=清空当前注入并清空历史，回到插件安装前的状态。',
        '注入内容会被包裹成系统提示词里的一个高优先级附加段；它不影响已经发生的对话，只影响之后的模型调用。',
        '只有在用户明确要求注入/回退某段内容时才调用 inject/rollback/reset；拿不准就先 status。',
      ].join('\n'),
      parameters: {
        action: { type: 'string', description: 'status | inject | rollback | reset', required: true },
        text: { type: 'string', description: 'action=inject 时必填：要注入的提示词正文（原样注入，不要改写）' },
        mode: { type: 'string', description: 'action=inject 时可选：replace（默认）| append' },
        steps: { type: 'number', description: 'action=rollback 时可选：回退几步，默认 1' },
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args) { return safe(dispatch({ ...(args || {}), via: 'tool' })) },
    }))
  } catch (e) { log(`prompt_injector 工具没挂上：${em(e)}`) }

  /* ── 入口二：会话命令 /pinject ── */
  const summarize = (r) => {
    if (!r || r.ok !== true) return `没成：${(r && r.error) || '未知原因'}`
    if (r.action === 'inject') return `已注入 ${r.chars} 字符（${r.mode === 'append' ? '追加' : '替换'}）—— 下一次模型调用开始生效；历史 ${r.historyCount} 条。`
    if (r.action === 'rollback') return r.steps === 0 ? '本来就没有注入 —— 系统提示词已是原样。' : `已回退 ${r.steps} 步：现在${r.now ? `是 ${r.now.chars} 字符的注入` : '无注入（系统提示词原样）'}；历史剩 ${r.historyCount} 条。`
    if (r.action === 'reset') return '已清空：当前无注入、历史已清空 —— 回到插件安装前的状态。'
    if (r.current) return `当前注入 ${r.current.chars} 字符（${new Date(r.current.injectedAt).toLocaleString('zh-CN')}，via ${r.current.via}）；历史 ${r.historyCount} 条。\n开头：${previewOf(r.current.text)}`
    return `当前无注入（系统提示词保持原样）；历史 ${r.historyCount} 条。`
  }
  try {
    ctx.commands.register({
      name: 'pinject',
      description: '提示词注入器：把一段文本注入全局系统提示词，或回退 / 清空（Prompt Injector）',
      input: { hint: '[status | rollback [步数] | reset] —— 或者直接把要注入的提示词写在这一行后面' },
      handler(invocation) {
        const raw = String(invocation?.rawInput || '').trim()
        const sp = raw.search(/\s/)
        const head = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase()
        const rest = sp === -1 ? '' : raw.slice(sp).trim()
        try {
          if (!raw || head === 'status') return { kind: 'success', text: summarize(op.status()) }
          if (head === 'rollback') return { kind: 'success', text: summarize(op.rollback({ steps: Number(rest) || 1, via: 'command' })) }
          if (head === 'reset') return { kind: 'success', text: summarize(op.reset({ via: 'command' })) }
          if (head === 'inject') {
            if (!rest) return { kind: 'error', text: '没看到要注入的文本 —— 用法：/pinject inject <提示词正文>' }
            return { kind: 'success', text: summarize(op.inject({ text: rest, mode: 'replace', via: 'command' })) }
          }
          // 其它任何输入都整段当作要注入的提示词（最常用路径：/pinject <准备好的提示词>）
          return { kind: 'success', text: summarize(op.inject({ text: raw, mode: 'replace', via: 'command' })) }
        } catch (e) { return { kind: 'error', text: `执行失败：${em(e)}` } }
      },
    })
  } catch (e) { log(`/pinject 命令没挂上：${em(e)}`) }

  /* ── 入口三：设置页用的 HTTP 路由 ── */
  const sendJson = (res, statusCode, body) => {
    try {
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    } catch { /* 客户端先走了就算了 */ }
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2_000_000) { reject(new Error('请求体太大')); try { req.destroy() } catch { /* 算了 */ } ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (e) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })

  const handle = async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const path = u.pathname
    if (req.method === 'GET' && path === '/api/prompt-injector/status') return sendJson(res, 200, op.status())
    if (req.method === 'POST' && path === '/api/prompt-injector/inject') {
      const body = await readBody(req)
      return sendJson(res, 200, op.inject({ text: body.text, mode: body.mode, via: body.via || 'settings' }))
    }
    if (req.method === 'POST' && path === '/api/prompt-injector/rollback') {
      const body = await readBody(req)
      return sendJson(res, 200, op.rollback({ steps: body.steps }))
    }
    if (req.method === 'POST' && path === '/api/prompt-injector/reset') {
      return sendJson(res, 200, op.reset({ via: 'settings' }))
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/prompt-injector',
      handler: async (req, res) => {
        try { await handle(req, res) } catch (e) { sendJson(res, 500, { ok: false, error: em(e) }) }
      },
    }), 'prompt-injector: /api/prompt-injector 路由')
  } catch (e) { log(`HTTP 路由没挂上：${em(e)}`) }

  log(`启动完成：当前 ${state.current ? `有注入（${state.current.text.length} 字符）` : '无注入'}；历史 ${state.history.length} 条；家：${stateDir}`)
}
