# fn 开发约定

## 项目边界

- fn 由 Agent Kernel 和 Finance Core 组成。用户通过 Agent 调用已注册的工具访问资产管理能力。
- `src/finance/` 独立承载金融身份、账本、状态推导和应用命令，不依赖 Agent Kernel。`src/agent/scenario/finance/` 仍通过独立的 `FinanceReader` 接口读取数据，尚未接入 Core。
- 当前财务场景工具只读。Finance Core 的命令仅接纳财务事实，不执行外部银行或券商操作。两边的内存实现都不持久化。

## 修改原则

- 按现有的 Provider、Scenario、Tool、History 和 MemoryStore 接口扩展 Agent 职责；Finance Core 保持独立的金融领域边界。
- 工具参数通过 Zod schema 校验；工具的 `effect` 应与实际副作用一致。
- 财务数量使用精确十进制字符串；账本分录必须逐资产平衡。余额、持仓、成本批次和在途资产从已接纳事实推导，不能直接覆盖。
- 财务金额、币种和估值时间以已接纳数据为准；缺失的数据不能由模型补造。
- 只实现任务要求的能力，避免预留接口、额外依赖和与当前实现不符的文档。

## 验证

- `npm run typecheck`：检查 TypeScript 类型。
- `npm test`：运行 Node.js 测试。
