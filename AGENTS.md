# agents-workbench

本地多 Agent 协作工作台：花名册契约（`TEAM.md`）+ 共享任务板（`tasks/`）+ 零依赖离线编排 runner（`scripts/workbench.mjs`、`flow/cli.mjs`）。

## 用途与 Target 判定

| 平台 | 需要? | 方式 |
|------|-------|------|
| 移动端 | 不适用 | 本地 Node CLI / TUI 协作编排工具 |
| 智能硬件 | 不适用 | 开发者工作台，非消费级穿戴场景 |

## 命令

```bash
node scripts/workbench.mjs board
node scripts/workbench.mjs verify
node flow/cli.mjs validate --flow flows/demo.flow.json
node flow/tests/stress-store.mjs
```

## Harness / Loop（助手）

- 遵循根 `/Users/skat/AGENTS.md` 与本目录 `TEAM.md` 写入范围契约
- Guide = 本文件 + `TEAM.md`；Sensor = `node scripts/workbench.mjs verify` + `node flow/tests/stress-store.mjs`
- runner 只写 `runs/`，绝不回写 `tasks/`；同类失误第二次须沉淀规则或测试（棘轮）

## 验证环 / Done

```bash
node flow/cli.mjs validate --flow flows/demo.flow.json
node flow/tests/stress-store.mjs
node scripts/workbench.mjs verify
```

**Done 示例**：flow 契约校验、存储并发压测与工作台独立验收全绿。
