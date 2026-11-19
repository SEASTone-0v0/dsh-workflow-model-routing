# 第九章　派工、认领、完成通知与最终验收

本章把协作网络中的 SCHED → ROUTE → SPAWN → CLAIM 展开。核心原则是：**任务记录、Agent 执行和业务验收是三件不同的事。**

## 9.1 三种状态不要混用

| 证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| Team 任务记录 | 有任务 ID、owner、revision、依赖和状态 | 已创建模型会话，或结果已验收 |
| subagent/childId | Host 已创建一个子 Agent | 已认领正确任务，或工作成功 |
| 完成通知/账本 completed | 执行者报告结束或显式写回完成 | 文件正确、测试通过、用户目标达成 |

最终验收由根 Agent 根据原始需求、实际文件、测试结果和未测范围作出，不能由任何单一状态字段代替。

## 9.2 第一步：SCHED，选择真正就绪的工作

根 Agent 先检查：

- 用户目标和验收标准是否明确；
- 上游依赖是否已有成果证据，而不只是“有人说完成”；
- 输入材料是否获准使用；
- 写入范围是否与其他执行者互斥；
- 当前执行容量是否允许新派工；
- 这个任务是否值得独立 Agent，而非根 Agent 直接完成。

共享 Team 任务的 `blocked_by` 用来表达依赖和 readiness。它不会自动把复杂 DAG 变成执行引擎，也不会因为任务 ready 就自动启动模型。

SSS、A、A1 是图中的逻辑任务键。共享 Team 任务应以 Host 返回的真实 taskId 为准；逻辑层级可写入标题和说明，不能假定共享任务具有 task_board 那样的 parentId 字段。

## 9.3 第二步：建立共享任务记录

典型顺序：

1. `team_task_create` 创建未认领任务，写明目标、输入、验收和 write_scopes。
2. `team_task_list` 查看 ready、owner、revision 和阻塞关系。
3. `team_task_get` 在认领或修改前读取最新完整记录。
4. 使用读到的 revision 做 compare-and-set 更新。

创建记录不等于启动执行者。写范围是协作约定和冲突提示，不是文件系统锁，也不是沙箱权限。

## 9.4 第三步：ROUTE，解析模型路线

如果通过插件 `role_subagent`：

1. 读取当前会话冻结的模式快照。
2. 检查 roleId 是否存在、角色是否启用。
3. privacy 角色拒绝自动云端派发。
4. 依次解析：显式 override → 合法 teamRole 路线 → role[tier]。
5. tier 只接受 primary/backup/upgrade 语义；未指定时使用 primary，无效值不会成为“自动升级”。
6. 检查精确路由授权。
7. 根据 default/fixed/smart 和真实能力声明解析 reasoningEffort。
8. 任一硬校验失败则返回错误，不静默换模型。

直接使用原生 subagent 时，不经过这套角色映射；由原生显式参数和原生默认规则决定。

## 9.5 第四步：预留插件执行位

在 await Host 创建子 Agent 之前，插件先原子预留一个位置，避免多个同时请求都通过“检查后再计数”的竞态。

- 计数包含正在创建的预留和已经活跃的插件派工。
- 达到 `maxConcurrentWorkers` 时，本次调用直接报“团队并发上限已达”。
- 这不是自动排队器；根 Agent 应等待现有派工结束后，再决定是否重新发起。
- 启动失败或没有 childId 时，预留会释放。
- 子 Agent 结束事件到达后，活跃计数会释放。

该计数只覆盖本插件的 role_subagent，不是 Host 全局并发限制，也不自动限制直接原生 subagent、其他会话或任务板运行。

## 9.6 第五步：SPAWN，Host 创建子 Agent

插件把已解析的 provider/model/effort、任务 prompt、父 Agent、cwd 等交给原生 `subagents.startActivation`。

Host 仍负责自己的权限、父子关系、深度、容量和启动校验。插件配置不能绕过这些边界。

成功返回 `childId/subagentId` 后，插件记录：

- 角色、tier、routeSource；
- 请求的目标 provider/model/effort；
- modeId/modeRevision；
- parentSessionId 和创建时间。

这是派工观察记录。requested route 不应被冒充为实际流式调用路线；实际模型需要由会话/事件证据补充。

## 9.7 第六步：CLAIM，执行者认领任务

子 Agent 启动后，应根据任务书主动读取最新任务：

1. `team_task_get` 或 list 找到目标记录。
2. 检查 owner、blocked_by、状态和最新 revision。
3. 用该 revision 调用 claim。
4. CAS 成功后才按任务书执行；认领冲突则停止重复工作并回报。

如果子 Agent 尚未运行、owner 未被通知或任务仍被阻塞，仅改变任务状态不会让它开始工作。需要时使用 `send_message` 明确通知目标 Agent。

“任务状态变化”不会自动结束 wait_agent、不会自动增加收件箱消息，也不会必然启动一个空闲 Agent。

## 9.8 第七步：执行与工具循环

执行者每轮可能进行：

1. 模型读取当前上下文和任务书；
2. 选择下一个动作；
3. 发出工具请求；
4. Host 做权限和参数校验并真正执行；
5. 工具结果返回模型上下文；
6. 模型继续、修正或报告阻塞。

文件写入必须遵守约定的互斥范围。格式器、脚本和生成器可能覆盖并发修改，所以共享目录不等于可以随意写同一文件。

角色本身不会自主循环；是 Agent 的模型、Host 和工具共同完成执行。

## 9.9 第八步：PACK，成果回传与任务写回

执行者交付给父 Agent 的内容至少应包括：

- 结论和实际产物路径；
- 关键来源或数据依据；
- 运行过的测试及结果；
- 未测范围、失败与风险；
- 需要父 Agent 继续做的集成动作。

共享任务需要按最新 revision 显式 complete 或写回结果摘要。子 Agent 最终回答、完成通知和账本 completed 是不同通道；不要只完成其中一项就宣称另外两项已发生。

## 9.10 第九步：依赖推进与返工

父 Agent 收到必要成果后：

1. 读取最新任务账本，确认必需输入确实齐备。
2. 检查成果，而不是只看 completed。
3. 选择下一批 ready 工作；有执行位才派工。
4. 如果不通过，记录缺陷、重新打开或新建修复任务、更新依赖并重新验收。

当前配置中的 failureRetryLimit、预算和 writeScopeIsolation 等字段不能当作自动重试、真实计量或沙箱证明。没有“失败后自动 backup/upgrade”的隐含流程。

顾问也是按需派工，会占用执行容量；条件文本不是后台触发器。

## 9.11 第十步：FINAL，根 Agent 最终验收

根 Agent 在给最终答复前应：

- 等待所有必要执行者完成；
- 审查最终 diff 和产物，而非只收摘要；
- 运行相关测试或检查真实渲染；
- 对照用户原始验收标准逐项打勾；
- 明确区分真实执行、模拟测试、静态检查和未测范围；
- 汇总文件、主要结果、限制和后续建议。

任务记录 completed、子 Agent 结束、工具返回成功都不能单独替代这一层。

## 9.12 共享 Team 与 task_board 的区别

| 共享 Team 工作流 | task_board 工作流 |
| --- | --- |
| list/get/claim/update 维护共享任务 | Host 维护任务卡和执行状态 |
| 创建任务不自动开 Agent | task_board_run 会为卡片创建受 Host 管理的执行会话 |
| owner 需被显式通知或继续对话 | 卡片运行由 Host 执行器管理 |
| blocked_by 影响 readiness | 有独立卡片列、运行记录及调度规则 |
| 不能把 createTask 当作模型路由 | 不能把卡片状态伪装成共享 Team 执行 |

插件的 `agentTeams.createTask` 只对应共享待办账本，不支持把“taskBoard 独立会话”当成角色派工目标。

下一章用完整操作案例串联配置、保存启用、新会话派工和验收。
