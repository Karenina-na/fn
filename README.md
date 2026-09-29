# fn

fn 是一个 Agent-native 个人金融操作系统。项目分为独立的 **Agent Kernel** 和 **Finance Core**：前者负责交互与工具编排，后者负责确定性的金融事实、规则和状态。当前 Finance Core 可在没有 Agent 的情况下运行和测试。

## 当前能力

- Agent Kernel：管理模型 Provider、场景、提示词、工具调用、会话历史、上下文压缩和运行事件。
- Finance Core：建立机构、账户、资金池、金融资产、合同、卡与收款端点的身份和挂载关系；通过财务命令记录期初资产、现金流、成交、在途转账和换汇；从分录重建余额、持仓、成本批次及在途资产。
- 现有 Finance 场景仍使用 `FinanceReader` 接口，尚未接入 Finance Core。仓库也没有可直接启动的应用入口。

Finance Core 当前使用进程内存储，重启后不会保留数据。它只记录已接纳的财务事实；记录转账不执行银行转账。组合查询返回各资产原始数量，不在缺少行情与汇率时给出净资产估值。

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
| `src/finance/decimal.ts` | 精确十进制数量、价格和费用运算 |
| `src/finance/identity.ts` | 金融身份、账户资金池、合同、卡与收款端点挂载 |
| `src/finance/ledger.ts` | Operation、JournalEntry、Posting 和逐资产平衡约束 |
| `src/finance/state.ts` | 从账本重建余额、持仓、Lot、在途和资产数量 |
| `src/finance/application/` | 财务命令、查询及独立装配入口 |
| `test/` | Kernel、Provider、财务场景与 Finance Core 测试 |

## Finance Core 使用方式

创建 `FinanceCore` 时指定 Book 与 Owner ID。通过 `identity` 注册机构、账户、资金池和资产，通过 `command` 接纳已发生的财务事实，通过 `query` 查询由账本推导的状态。所有金融数量使用十进制字符串；Position 的已知成本以精确分数返回，未知成本显式为 `null`。

成交费用作为单独的费用分录，Lot 成本记录成交金额；卖出按 Lot 录入顺序采用 FIFO。期初 Lot 的取得日期允许未知。转账在源端扣款后形成在途资产，可按实际凭证分次记录目的端到账和费用；资金在途中只计一次。账面余额不代表已结算或可提现金额；接纳已发生事实时不会把账面余额当作资金可用性校验。历史不完整时，账面数量可能暂时为负。

Finance Core 的入口位于 `src/finance/application/core.ts`。新 Operation 当前按生效时间顺序过账；迟到的转账到账凭证可按实际生效时间补录。其他回溯补录、冲正与对账命令尚未实现。未来发生的事件不会进入已接纳账本。

## Agent Kernel 接入方式

应用侧实现 `FinanceReader`，提供资产数据；创建 `ProviderRegistry` 并注册模型 Provider；再通过 `registerFinance` 构建场景，将场景与 `History` 传入 `AgentRuntime`。调用 `runtime.run(sessionId, userMessage)` 可逐个消费运行事件。

相关入口分别位于 `src/agent/scenario/finance/scenario.ts`、`src/agent/provider/provider.ts` 和 `src/agent/runtime/runtime.ts`。内存版历史与记忆分别是 `InMemoryHistory` 和 `InMemoryStore`，只在进程内保存数据。
