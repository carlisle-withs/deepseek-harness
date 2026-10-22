# dsh 外部引擎插件 — 开发交接笔记

目标：DSH 桌面 UI 不变，agent loop 换成外部 CLI harness（claude / pi / opencode）。
路线 A：in-tree 插件实现 AgentFactory + base bundle 一行 YAML 换行。

## 已确认的接缝（全部实测读码）

- 工厂接口 `AgentFactory`：`packages/core/agent/src/index.ts:171` —
  `createAgent(ownerCtx, options): Promise<AgentHandle>` + `resume(ownerCtx, options)`
- 注册：`ctx.agents.setFactory(this)`（单席位，重复注册抛错）
- Agent 表面（`packages/core/agent/src/runtime-types.ts`）：
  options/session/inbox/status/ctx + cancel/whenIdle/runMaintenance/send/followup/steer/inject
- 默认实现参考：`packages/core/agent-loop/src/index.ts` `class AgentLoop extends Service
  implements AgentFactory`，构造里 setFactory + 注册 turnBoundary/inbox 投影
- UI 只吃会话事件日志：user/message、assistant/message（内嵌紧凑流）、tool/call、
  tool/result、turn/start|end；活流 `agent/assistant-stream`（start/chunk*/end）
- 行替换机制：`packages/bundle/base/cordis.patch.yml` `- id: agent-loop` 行指向
  `@deepseek-ai/dsh-agent-loop-external`
- 模型选择器目录来源：`ctx.llm.listProviders()/listModels()`（session-controller
  catalog.ts）→ 插件用 `ctx.llm.registerAdapter` 注册目录 provider 即可进选择器

## 环境备忘

- dev 启动必须带 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/（裸连必卡）
- pnpm 用 npx pnpm@11.28.5（全局 10 与 lockfile 不匹配）
- 全量构建已通过；dev:desktop 增量很快
- ZCode 版同类实现（事件映射参考）：
  C:\Users\15234\.zcode\workspace\1792602180782-.../ZCode/apps/engine-shim/
- 不要用 PowerShell Get-Content/Set-Content 往返改 UTF-8 文件（默认 GBK 会把文件
  写成双重编码乱码——本文件曾被这样毁过一次）

## 阶段②踩坑记录（按发现顺序）

1. **回复完成后消失**（d4e45f940c 修复）：assistant/message 必须包在
   step/start..step/end 里，且客户端 ClientAssistantStream 会在"迟到的 start
   帧"上整流重建（rebaseline）——最后一轮 tool-less 回合的提交必须推迟到
   result 事件，并在下一轮首 delta 之前先提交+收步再开新步。
2. **损坏会话无法加载**：修复①之前的旧构建写的日志缺 turn/step 坐标，被
   v3→v4 严格校验器判 corrupt。处理=直接删损坏会话（dev 沙箱数据）。校验规则
   镜像在根目录 scan-sessions.mjs（--delete 可自动清除）；dump-session.mjs 可
   全文 dump 单个会话。
3. **回复整体为空、turn 却"已完成"**（976c3661dc 修复）：两个叠加原因——
   a. 模型链把 dsh AgentOptions.model（deepseek-flash，dsh 目录命名空间）当
      --model 传给 claude，BigModel 400「模型不存在」；claude 把 API 错误包成
      合成 assistant 消息（无任何 stream delta）且 result 仍是 subtype=success。
   b. commitRound 的"整消息合成"分支被守在 round!==undefined 下，而 round 只
      在首条 delta 时才创建——零 delta 的整条消息被静默丢弃。
   修复：合成分支改为"已流 delta 只补 tool-use 块，否则整消息合成"；--model 链
   改为 env pin > 用户显式选择（跨轮保持）> 不传。AgentOptions.model 永不透传。
4. **E2E 验证方式**（不碰 UI）：DSH_HOME=<dev home> && npx pnpm@11.28.5
   --filter @deepseek-ai/dsh exec node lib/bin.js --profile headless "任务文本"
   ——headless bundle 直接叠在 dsh-base 上，继承 agent-loop→external 换行。

## 阶段③：多引擎 + 界面选择

- 结构：`process-turn.ts` = 通用 JSONL 子进程壳（stdin prompt / 行解析 /
  stderr 尾巴 / Windows taskkill 树杀）；`claude.ts`、`pi.ts`、`opencode.ts`
  各自继承；`engines.ts` = 引擎注册表（id/名称/env 前缀/默认参数/工厂）+
  EngineCatalogAdapter（LlmAdapter，仅目录用，stream 直接 throw）。
- **UI 选择**：ExternalAgentLoop 构造里 `ctx.llm.registerAdapter([claude-code,
  opencode, pi], EngineCatalogAdapter)` —— 模型选择器把引擎当 provider 分组
  列出；每个引擎一个 `default` 模型（= 引擎自己配置的默认模型）。选中即把
  该会话路由到该引擎（pending 选择写入后跨轮保持，request/header 记录引擎 id）。
- env：`ENGINE_LOOP_ENGINE`（无选择时的引擎，headless 测试用）、每引擎
  `ENGINE_LOOP_<CLAUDE|OPENCODE|PI>_COMMAND/_ARGS/_MODEL`。
- **坑：headless/CLI 加载的是构建产物 lib/index.js**，改完源码必须先
  `npx pnpm@11.28.5 run build:artifacts` 再跑 E2E，否则跑的是旧代码
  （这次差点被骗：三个"通过"的运行其实全是 claude）。验证时查引擎自己的
  数据目录（~/.claude/projects、~/.pi/agent/sessions、
  ~/.local/share/opencode）有没有新会话才算数。
- **坑：pi 的 turn_end 会原样重复最后一条 message_end** —— 必须按内容去重
  （message_start 清 guard，边界比较 lastReportedContent），否则一条回复落两条。
- 已知边界（阶段④）：pi 的工具结果、opencode 的工具调用/结果还不是持久
  配对（引擎无消息边界时无法中途提交 tool/call）；引擎错误文本会正常显示。
- 三引擎 E2E 实测通过（claude=glm-5.3 via BigModel、pi=GLM、opencode=Flint），
  request/header 分别为 provider=claude-code/pi/opencode。
