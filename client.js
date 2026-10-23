/**
 * dsh-prompt-injector —— 浏览器半端（「设置」里的一页）
 * ============================================================================
 * 结构抄 dsh-bili-scroll / 官方 decoration 模板的约定（2026-10 已在本机验证可用的形状）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: [...], apply(ctx) {...} }),
 *     })
 *
 * 进「设置」：settings.section 槽位 + slots.inject（label = 左侧导航那一项）。
 * 与 Host 通信：同源 fetch `/api/prompt-injector/*`（Host 半端注册的路由）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-injector',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/prompt-injector'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-pi-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-pi-sec]{display:flex;flex-direction:column;gap:8px;}
[data-pi-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pi-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-pi-grow]{flex:1;min-width:0;}
[data-pi-label]{font-size:13px;}
[data-pi-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pi-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-pi-badge][data-on]{background:rgba(59,130,246,.18);color:#3b82f6;}
[data-pi-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-pi-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-pi-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-pi-btn][data-danger]{border-color:rgba(239,68,68,.55);color:#ef4444;}
[data-pi-btn][data-danger][data-armed]{background:rgba(239,68,68,.16);}
[data-pi-btn][disabled]{opacity:.5;cursor:default;}
[data-pi-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-pi-input]:focus{outline:none;border-color:#3b82f6;}
select[data-pi-input]{width:auto;}
textarea[data-pi-input]{resize:vertical;min-height:120px;font-family:ui-monospace,Consolas,monospace;line-height:1.5;}
[data-pi-pre]{margin:4px 0 0;padding:8px 9px;border-radius:8px;max-height:220px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-pi-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pi-msg][data-warn]{color:#f59e0b;}
[data-pi-msg][data-good]{color:#22c55e;}
[data-pi-item]{display:flex;flex-direction:column;gap:3px;padding:8px 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));}
[data-pi-item] [data-pi-meta]{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pi-item] [data-pi-text]{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-secondary,#c9ccd1);
  white-space:pre-wrap;word-break:break-word;max-height:60px;overflow:hidden;}
[data-pi-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 0;}
`

    const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—')
    const VIA_NAME = { settings: '设置页', command: '/pinject', tool: '对话（工具）', api: '接口', restore: '历史恢复', unknown: '未知' }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [mode, setMode] = React.useState('replace')
      const [armed, setArmed] = React.useState(false)   // “恢复初始”的两击确认
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const say = (t, tn) => { setMsg(t); setTone(tn || '') }

      const refresh = async () => {
        try {
          const d = await jget('/status')
          if (!alive.current) return
          if (d && d.ok) { setSt(d); setErr('') } else setErr((d && d.error) || '读不到状态')
        } catch (e) { if (alive.current) setErr(String(e && e.message ? e.message : e)) }
      }
      React.useEffect(() => { refresh() }, [])

      const guard = async (key, fn) => {
        setBusy(key)
        try { await fn() } catch (e) { say(String(e && e.message ? e.message : e), 'warn') }
        finally { if (alive.current) setBusy('') }
      }

      const doInject = () => guard('inject', async () => {
        if (!draft.trim()) { say('先在文本框里粘入要注入的提示词', 'warn'); return }
        const r = await jpost('/inject', { text: draft, mode })
        if (r && r.ok) {
          setDraft('')
          say(`已注入（${r.chars} 字符，${r.mode === 'append' ? '追加' : '替换'}）—— 下一次模型调用开始生效`, 'good')
          refresh()
        } else say((r && r.error) || '注入失败', 'warn')
      })

      const doRollback = () => guard('rollback', async () => {
        const r = await jpost('/rollback', {})
        if (r && r.ok) {
          setArmed(false)
          say(r.steps === 0 ? '本来就没有注入 —— 系统提示词已是原样' : `已回退 ${r.steps} 步：现在${r.now ? '是上一次注入的内容' : '无注入（系统提示词原样）'}`, 'good')
          refresh()
        } else say((r && r.error) || '回退失败', 'warn')
      })

      const doReset = () => guard('reset', async () => {
        if (!armed) { setArmed(true); say('再点一次确认：会清空当前注入和全部历史，回到插件安装前的状态', 'warn'); return }
        const r = await jpost('/reset', {})
        if (r && r.ok) { setArmed(false); setDraft(''); say('已恢复到程序运行前的状态（无注入、历史已清空）', 'good'); refresh() }
        else say((r && r.error) || '清空失败', 'warn')
      })

      const doRestore = (entry) => guard('restore' + entry.injectedAt, async () => {
        const r = await jpost('/inject', { text: entry.text, mode: 'replace' })
        if (r && r.ok) { say('已恢复该条历史为当前注入（原来的当前注入进了历史，还能再回退）', 'good'); refresh() }
        else say((r && r.error) || '恢复失败', 'warn')
      })

      const cur = st && st.current
      const hist = (st && st.history) || []

      return h('div', { 'data-pi-page': '' },

        /* ── 状态行 ── */
        h('div', { 'data-pi-row': '' },
          h('span', { 'data-pi-badge': '', 'data-on': cur ? '' : undefined },
            cur ? `已注入 · ${cur.chars} 字符` : '未注入 · 系统提示词原样'),
          h('span', { 'data-pi-badge': '' }, `历史 ${st ? st.historyCount : '…'} 条`),
          h('div', { 'data-pi-grow': '' }),
          h('button', { 'data-pi-btn': '', onClick: refresh, disabled: busy === 'refresh' }, '刷新'),
        ),
        err ? h('div', { 'data-pi-msg': '', 'data-warn': '' }, '状态读取失败：' + err) : null,
        msg ? h('div', { 'data-pi-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,

        /* ── 注入 ── */
        h('div', { 'data-pi-sec': '' },
          h('div', { 'data-pi-h': '' }, '注入新的提示词'),
          h('textarea', {
            'data-pi-input': '', rows: 8,
            placeholder: '把准备好的提示词粘到这里……\n它会作为高优先级附加段进入 DSH 的系统提示词，对所有会话生效。',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
          }),
          h('div', { 'data-pi-row': '' },
            h('select', { 'data-pi-input': '', value: mode, onChange: (e) => setMode(e.target.value) },
              h('option', { value: 'replace' }, '替换当前注入'),
              h('option', { value: 'append' }, '追加到当前注入后面')),
            h('button', { 'data-pi-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: doInject },
              busy === 'inject' ? '注入中…' : '注入到系统提示词'),
            h('div', { 'data-pi-grow': '' }),
            h('div', { 'data-pi-note': '' }, cur ? `当前已有注入（${cur.chars} 字符）会被存进历史，随时可回退` : '当前没有注入'),
          ),
          h('div', { 'data-pi-note': '' },
            '生效时机：下一次模型调用开始（不影响已经发生的对话）；',
            h('br'),
            '也可以在会话里输入 /pinject <提示词> 直接注入，或让 AI 用 prompt_injector 工具代劳。'),
        ),

        /* ── 当前生效内容 ── */
        h('div', { 'data-pi-sec': '' },
          h('div', { 'data-pi-h': '' }, '当前生效的注入'),
          cur
            ? h('div', null,
                h('div', { 'data-pi-note': '' },
                  `${cur.chars} 字符 · 注入于 ${fmtTime(cur.injectedAt)} · 来源 ${VIA_NAME[cur.via] || cur.via || '未知'}${cur.restoredAt ? ' · 由历史恢复' : ''}`),
                h('pre', { 'data-pi-pre': '' }, cur.text))
            : h('div', { 'data-pi-empty': '' }, '当前没有注入 —— 系统提示词保持原样（这就是“程序运行前”的状态）。'),
        ),

        /* ── 回退 ── */
        h('div', { 'data-pi-sec': '' },
          h('div', { 'data-pi-h': '' }, '回退'),
          h('div', { 'data-pi-row': '' },
            h('button', { 'data-pi-btn': '', disabled: Boolean(busy), onClick: doRollback }, '回退一步（撤销最近一次注入）'),
            h('button', {
              'data-pi-btn': '', 'data-danger': '', 'data-armed': armed ? '' : undefined,
              disabled: Boolean(busy), onClick: doReset,
            }, armed ? '再点一次确认清空全部' : '恢复到程序运行前（清空全部）'),
          ),
          h('div', { 'data-pi-note': '' },
            '回退一步 = 撤销最近一次注入，恢复它之前的内容；没有更早的历史时就变成“无注入”。',
            h('br'),
            '“恢复到程序运行前”会把当前注入和全部历史一起清掉 —— 这才是后悔药的终点。'),
        ),

        /* ── 历史 ── */
        h('div', { 'data-pi-sec': '' },
          h('div', { 'data-pi-h': '' }, '历史（最近在前）'),
          !st ? h('div', { 'data-pi-empty': '' }, '读取中…')
            : hist.length === 0 ? h('div', { 'data-pi-empty': '' }, '还没有历史 —— 每次注入都会把“当时的注入”存进来，供回退。')
              : hist.map((entry) => h('div', { 'data-pi-item': '', key: String(entry.injectedAt) + '-' + String(entry.removedAt) },
                  h('div', { 'data-pi-meta': '' },
                    `${entry.chars} 字符 · 注入于 ${fmtTime(entry.injectedAt)} · 被替换于 ${fmtTime(entry.removedAt)} · 来源 ${VIA_NAME[entry.via] || entry.via || '未知'}`),
                  h('div', { 'data-pi-text': '' }, entry.preview || entry.text),
                  h('div', null,
                    h('button', { 'data-pi-btn': '', disabled: Boolean(busy), onClick: () => doRestore(entry) },
                      busy === 'restore' + entry.injectedAt ? '恢复中…' : '恢复此条'),
                    h('span', { 'data-pi-note': '' }, '  （原来的当前注入会进历史，可再回退）')),
                )),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-prompt-injector')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-prompt-injector: 设置页样式')

        // 进「设置」：label 就是左侧导航里那一项
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'prompt-injector', order: 35, label: '提示词注入' },
          () => h(Panel),
        ))
      },
    }
  },
})
