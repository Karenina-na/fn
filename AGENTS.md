# fn 开发约定

## 项目边界

- fn 由 Agent Kernel 和 Finance Core 组成。用户通过 Agent 调用已注册的工具访问资产管理能力。
- `src/agent/` 是当前实现；`src/agent/scenario/finance/` 通过 `FinanceReader` 接入外部财务数据。
- 当前财务工具只读。会话记忆可写入当前会话，但内存实现不持久化。不要将接口或提示词描述为已经具备资产变更能力。

## 修改原则

- 按现有的 Provider、Scenario、Tool、History 和 MemoryStore 接口扩展对应职责，保持运行时与具体财务数据源分离。
- 工具参数通过 Zod schema 校验；工具的 `effect` 应与实际副作用一致。
- 财务金额、币种和估值时间以工具返回的数据为准；缺失的数据不能由模型补造。
- 只实现任务要求的能力，避免预留接口、额外依赖和与当前实现不符的文档。

## 验证

- `npm run typecheck`：检查 TypeScript 类型。
- `npm test`：运行 Node.js 测试。
