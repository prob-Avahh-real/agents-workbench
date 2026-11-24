# TEAM.md — agents 工作台协作协议

> 这份文件是工作台的**协作契约**：谁在什么范围内写文件、任务怎么流转、冲突怎么避免、什么时候算完成。
> 工作台本身是「人 + DSH Agent Teams + 一份共享任务板 + 一个离线 runner」的组合，不是一个独立应用。

## 1. 角色与关系

| 角色 | 成员 | relation | 只允许写 | 汇报给 |
|------|------|----------|----------|--------|
| Team Lead | `lead`（你正在对话的 Agent） | — | `README.md` `TEAM.md` `workbench.config.json` `tasks/` | 用户 |
| Builder | `forge` | managed | `scripts/` | lead |
| Verifier | `audit` | managed | `runs/VERIFICATION.md` `runs/verify-suite.log` | lead |

约定：

- **managed** 表示只能与本协议指定的一方通信；需要跨角色协调时由 Lead 转达。
- 写入范围是**建议性隔离**，不是锁。任何人准备写范围外的文件，必须先向 Lead 报备并拿到新范围。
- 需要更多人手时由 Lead 扩编，不由队友自行拉人。

## 2. 任务板流转

```
pending ──claim──▶ in_progress ──complete──▶ done
   │                    │
   └──── blockedBy 未完成时不可 claim ────┘
```

- 每条任务必须带：`owner`、`acceptance[]`、`writeScopes[]`，可选 `blockedBy[]`。
- **先建任务再 spawn 负责人**：负责人拿不到任务 id 就不开工。
- 领取前先 `get` 最新 revision，用 CAS 更新；revision 过期就重新读取再改。
- 阻塞中的任务不允许开跑，也不允许「先干着等解锁」。
- 完成任务必须附上：改了哪些文件、跑了什么命令、命令输出、仍存在的风险。
- **runner 不回写任务文件**：`tasks/` 是 owner 在共享板上用 CAS 维护的唯一真相源，runner 只读它；每次执行的状态流转（`claim/execute/artifact/verify`）落在 `runs/` 的运行日志里。因此「任务板状态」与「最近一次运行结果」是两份可以互相印证的记录，而不是同一条记录被两方改写。

## 3. 交接格式

队友回传 Lead 的消息一律包含这五项，缺一项视为未完成：

```
task:        <task id>
status:      done | blocked | failed
artifacts:   <文件路径 + 一句话说明>
evidence:    <实际执行的命令 + 关键输出/退出码>
open_risks:  <没覆盖到的边界，或 none>
```

## 4. 升级规则

- 卡住超过一次尝试 → 立刻报 Lead，带上已试过的方案和原始报错。
- 发现别人的产物不可用 → 不停工等待，改为写清复现步骤交给 Lead 转派。
- 触及写入范围冲突 → 停止写入，先向 Lead 申请，禁止「先改了再说」。

## 5. 验收分层

1. **自验**（所有者）：跑通命令，贴输出。
2. **独立验收**（`audit`）：不复用所有者的结论，自己重新执行一遍，核对 `workbench.config.json` 里的 `acceptance` 四项。
3. **终验**（Lead）：在最终 diff 上跑一遍端到端，确认没有范围外改动后再交付。

## 6. 运行契约（runner 对外接口）

| 命令 | 作用 | 退出码 |
|------|------|--------|
| `node scripts/workbench.mjs board` | 打印花名册 + 任务板（终端界面） | 0 |
| `node scripts/workbench.mjs run <taskId>` | 执行一条任务，写 `runs/run-<ts>-<taskId>.json` 与 `.log` | 成功 0；任务不存在 1；被依赖阻塞 2；模型层配置错误 3 |
| `node scripts/workbench.mjs verify` | 对所有依赖已满足的任务跑验收断言 | 全通过 0；有 FAIL 1；任务板为空（配置异常）1 |
| `node scripts/workbench.mjs verify --strict` | 同上，但把「零覆盖」的 UNVERIFIED 也计入失败 | 有 UNVERIFIED 时 1 |

`verify` 的判定分四档，汇总会分别给出断言级与任务级计数：

| 档位 | 含义 | 影响退出码 |
|------|------|-----------|
| `PASS` | 断言真的跑过且通过 | 否 |
| `FAIL` | 断言跑过且失败 | **是**（1） |
| `UNVERIFIED` | 有 acceptance 但零覆盖（未注册检查器 / `acceptance` 为空） | 默认否；`--strict` 下**是** |
| `BLOCKED-SKIP` | 任务因 `blockedBy` 未完成被跳过 —— 合法状态，不是缺陷 | 否 |

模型层：

- `model.provider = "mock"` → 确定性输出、**零网络请求**、不需要任何 API key。
- 换真实模型只改 `workbench.config.json`，runner 与任务板不动。
- 运行日志至少包含：`taskId`、`status`、`startedAt`、`endedAt`、`durationMs`、`steps[]`、`exitCode`、`model`。
- `status` 的终态枚举：`done` / `blocked` / `failed` / `unverified`。下游聚合（比如尚未实现的 `report` 子命令）必须把 `unverified` 当**独立档**，不得当成功。
- 磁盘上只允许出现终态记录：中间态只在内存里推进，落盘走 `.tmp + rename` 原子写。
