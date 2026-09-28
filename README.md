# fn

fn 是一个通过 AI Agent 操作的个人资产管理系统。人与资产管理能力之间由 Agent 负责理解请求、选择工具并返回结果。项目分为 **Agent Kernel** 和 **Finance Core**；当前仓库已实现 Agent Kernel，以及接入财务数据的只读场景接口。

## 当前能力

- Agent Kernel：管理模型 Provider、场景、提示词、工具调用、会话历史、上下文压缩和运行事件。
- Finance 场景：通过 `FinanceReader` 获取资产总览、账户、持仓和交易记录；通过会话记忆工具保存和检索偏好。
- 当前财务工具只提供读取能力。`FinanceReader` 是数据接入接口，仓库尚未提供实际资产数据源或可直接启动的应用入口。

## 开发

需要 Node.js 24 和 npm。

```sh
npm install
npm run typecheck
npm test
```

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/agent/runtime/` | 组装上下文，驱动模型与工具交互，并发出运行事件 |
| `src/agent/provider/` | 模型接口、注册表及 OpenAI Responses API 适配器 |
| `src/agent/tool/` | 工具定义、注册、参数校验与执行 |
| `src/agent/conversation/` | 会话历史与上下文压缩 |
| `src/agent/memory/` | 会话内记忆接口、内存实现及工具 |
| `src/agent/scenario/finance/` | 财务场景提示词、只读工具及 `FinanceReader` 接口 |
| `test/` | Kernel、Provider、工具契约与财务场景测试 |

## 接入方式

应用侧实现 `FinanceReader`，提供资产数据；创建 `ProviderRegistry` 并注册模型 Provider；再通过 `registerFinance` 构建场景，将场景与 `History` 传入 `AgentRuntime`。调用 `runtime.run(sessionId, userMessage)` 可逐个消费运行事件。

相关入口分别位于 `src/agent/scenario/finance/scenario.ts`、`src/agent/provider/provider.ts` 和 `src/agent/runtime/runtime.ts`。内存版历史与记忆分别是 `InMemoryHistory` 和 `InMemoryStore`，只在进程内保存数据。
