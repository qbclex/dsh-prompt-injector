# 🤖 AGENTS.md —— 给 AI 协作者看的

本文件告诉未来的 AI 编码助手：这个仓库是什么、改它要注意什么。

## 项目

`dsh-prompt-injector` —— DSH（DeepSeek Harness）插件：把用户文本注入全局系统提示词，并支持历史回退。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半区。注入/回退逻辑、`/pinject` 命令、`prompt_injector` 工具、HTTP 路由 `/api/prompt-injector/*` |
| `client.js` | Client 半区（浏览器）。设置页 `settings.section` 槽位 + 同源 `fetch` 调 Host |
| `lib/hostdeps.mjs` | 从宿主树解析 `@deepseek-ai/dsh-tools` 的 `defineTool`，拿不到用本地等价实现兜底 |
| `cordis.patch.yml` | bundle 挂载声明：插入 entry `prompt-injector` |
| `package.json` | 包清单；`dsh.bundle.patch` + `dsh.client` 声明 |
| `locale/{en,zh}.json` | 插件列表里的标题/描述（`meta.title` / `meta.description`） |

## 三条铁律

1. **零新增依赖**。`@deepseek-ai/*` 一律走 `lib/hostdeps.mjs` 的宿主树解析，不写进 `dependencies` —— 桌面版 profile 是 `autoInstallPeers: false`，裸 import 会让整条插件不激活。
2. **不做多余的事**。无注入时必须注销 section，让系统提示词与安装前完全一致；回退必须是真回退，不是追加抵消。
3. **状态只写插件家目录**（`~/.dsh/prompt-injector/`），**绝不写插件包目录**（装进 node_modules 后可能只读，升级会被覆盖）。

## 改完怎么验证

```powershell
# 语法检查（注意：PowerShell 5.1 直管道会按 GBK 读，先复制成 .mjs 再让 node 读文件）
node --check index.js
node --check client.js
node --check lib/hostdeps.mjs

# 安装到当前 profile
dsh plugin --profile <profile> add link:<本仓库路径>

# 冒烟测试（DSH 运行中）
Invoke-RestMethod http://127.0.0.1:<端口>/api/prompt-injector/status
```

再打开设置页手动点一遍：注入 → 回退 → 恢复初始。
