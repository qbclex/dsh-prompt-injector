# 提示词注入器 · dsh-prompt-injector

给 DeepSeek Harness（DSH）用的**系统提示词注入**插件：把准备好的提示词注入 DSH 的系统提示词，对所有会话生效，并随时可以**回退**到之前的状态甚至程序运行前的原样。

> 一句话：**能后悔的系统提示词注入。**

---

## 它解决什么问题

系统提示词（system prompt）决定了 AI 的「人设 / 规矩 / 工作方式」，但 DSH 本身不提供让普通用户改它的入口。这个插件把它变成一个**可以随时开关的开关**：

- 粘一段提示词 → 立即注入，下一次模型调用就生效
- 改主意了 → 一键**回退一步**（恢复上一次的内容）
- 彻底不想了 → 一键**恢复到程序运行前**（清空注入与历史）
- 每次注入前的内容自动进历史，最多保留 20 条，可**恢复任意一条**

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 注入 | 替换当前注入，或追加到当前注入后面 |
| 回退 | 撤销最近一次注入，恢复它之前的内容；历史弹空后变成「无注入」 |
| 丢失保护 | 每次注入前，把当时的注入自动存入历史（上限 20 条） |
| 恢复初始 | 清空当前注入 + 全部历史 = 程序运行前的状态（两击确认防误触） |
| 历史恢复 | 把任意一条历史恢复为当前注入（原来的当前注入会进历史，仍可回退） |
| 持久化 | 重启 DSH 后注入依然存在（存 `~/.dsh/prompt-injector/state.json`） |
| 三种入口 | 设置页 / 聊天命令 `/pinject` / 让 AI 调用 `prompt_injector` 工具 |

**设计原则：不做任何你没要求的事。** 没有注入时，插件会把自己注册的系统提示词 section 完全注销，系统提示词与安装前**一模一样**；回退不是「再加一段抵消」，而是真的回到之前的状态。

---

## 安装

前置：DSH ≥ 桌面版 / 任意带插件系统的版本；Node.js ≥ 22。

### 方式 A：从源码目录安装（推荐给开发者）

```powershell
dsh plugin --profile <你的 profile 名> add link:<本仓库绝对路径>
```

例如：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-prompt-injector
```

安装后**重启 DSH**，设置左侧出现「提示词注入」页即可。

### 方式 B：直接手装（没有 dsh 命令时）

把本仓库整个目录，改名为 `dsh-prompt-injector` 放进：

```
~/.dsh/profiles/<profile>/node_modules/dsh-prompt-injector
```

然后在 profile 的 `cordis.patch.yml` 里加一行（或删掉已有的 `prompt-injector` 行后加）：

```yaml
- insert:
    - id: prompt-injector
      name: dsh-prompt-injector
```

---

## 使用

### 1. 设置页

**设置 → 提示词注入**

- 中间大文本框：粘入提示词
- 下拉框：`替换当前注入` / `追加到当前注入后面`
- 「注入到系统提示词」→ 立即生效
- 「回退一步」→ 撤销最近一次
- 「恢复到程序运行前」→ 清空全部（需要点两次确认）

### 2. 聊天命令

```
/pinject <提示词正文>     直接注入（整段作为一次注入）
/pinject status           看当前注入和历史
/pinject rollback [步数]  回退（默认 1 步）
/pinject reset            清空全部
```

### 3. 让 AI 代办

对 AI 说：「把这段注入系统提示词：……」它会调用 `prompt_injector` 工具。
（当前审批策略下，工具调用会先给你确认。）

---

## 原理（想改代码的人看）

- **注入点**：`ctx.systemPrompt.section()`，注册一个动态 section，`text` 是函数，每次模型调用装配时读取当前内存状态 —— 所以注入/回退**立即生效**，无需重启。
- **包裹**：注入内容会被包进一个高优先级附加段：
  ```
  # User-injected system prompt (Prompt Injector)
  ...
  <user-injected-prompt>
  ...你的提示词...
  </user-injected-prompt>
  ```
- **状态**：`~/.dsh/prompt-injector/state.json`，结构是 `{ current, history }`。
  `history` 的每一项是「某次注入发生前、当时 `current` 的快照」；回退 = 从末尾弹出一条恢复为 `current`。
- **宿主依赖**：`defineTool` 从宿主那棵树里解析，拿不到就本地等价转换兜底 —— **不会因为一个 import 失败让整条插件不激活**（见 `lib/hostdeps.mjs` 的注释）。
- **日志**：`~/.dsh/prompt-injector/injector.log`，排查问题先看它。

---

## 安全提醒

注入的内容会被 AI 视为**用户的最高优先级指令**，对所有会话生效。所以：

- 只注入你自己写的、或你完整读过并理解的文本
- 不要直接把网页/邮件里复制的整段文字不经阅读就注入
- 后悔药的终点永远是「恢复到程序运行前」

---

## 许可证

[MIT](LICENSE) —— 可自由使用、修改、再发布，保留版权声明即可。
