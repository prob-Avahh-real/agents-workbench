#!/usr/bin/env node
// ============================================================================
// agents-workbench runner
//   子命令：board | run <taskId> | verify
//   退出码：0 成功 / 1 任务不存在或验收 FAIL / 2 被 blockedBy 阻塞 / 3 模型层配置错误
//   契约：TEAM.md 第 6 节「运行契约」；配置：workbench.config.json
//   只用 Node 内置模块，零第三方依赖，无构建步骤（node v22.22.3 直接可跑）。
//
//   写入范围：只写 runs/（运行日志与产物），绝不改写 tasks/ 与配置，因此任务板状态
//   流转只记录在运行日志里，不由 runner 回写。见 cmdRun 中的说明。
// ============================================================================
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ModelConfigError, describeModel, createModel } from './mock-model.mjs';

// ---------------------------------------------------------------------------
// 常量与小工具
// ---------------------------------------------------------------------------

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, BLOCKED: 2, MODEL_ERROR: 3 });

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
export const WORKBENCH_ROOT = resolve(SCRIPT_DIR, '..');

const STAGE_ORDER = ['claim', 'execute', 'artifact', 'verify'];
const STAGE_TITLE = { claim: '领取', execute: '执行', artifact: '产物', verify: '验收' };
const STATUS_MARK = { ok: '✔', blocked: '⛔', fail: '✖', skip: '·' };

class WorkbenchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code;
  }
}

function out(text = '') {
  process.stdout.write(`${text}\n`);
}

function err(text = '') {
  process.stderr.write(`${text}\n`);
}

function iso(date) {
  return date.toISOString();
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function stampOf(date) {
  // 文件系统安全的时间戳：ISO 里的 ':' 与 '.' 换成 '-'，不含冒号。
  return date.toISOString().replace(/[:.]/g, '-');
}

function uniqueRunId(ctx, date, taskId) {
  const runsDir = join(ctx.root, ctx.config.paths.runs);
  const base = `run-${stampOf(date)}-${taskId}`;
  let candidate = base;
  let n = 1;
  while (existsSync(join(runsDir, `${candidate}.json`)) || existsSync(join(runsDir, `${candidate}.log`))) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

// --- 终端表格（中日韩字符按 2 列宽计算，保证对齐） ---

function charWidth(ch) {
  const c = ch.codePointAt(0);
  const wide =
    c >= 0x1100 &&
    (c <= 0x115f ||
      c === 0x2329 ||
      c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6));
  return wide ? 2 : 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch);
  return w;
}

function truncate(s, max) {
  let acc = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) return `${acc}…`;
    acc += ch;
    w += cw;
  }
  return acc;
}

function padEnd(s, width) {
  const text = String(s);
  const gap = width - strWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

function renderTable(headers, rows) {
  const cells = rows.map((row) => row.map((c) => String(c)));
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...cells.map((r) => strWidth(r[i] ?? '')), 0));
  const lines = [];
  lines.push(`  ${headers.map((h, i) => padEnd(h, widths[i])).join('  ')}`);
  lines.push(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of cells) lines.push(`  ${row.map((c, i) => padEnd(c, widths[i])).join('  ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 配置与任务板读取
// ---------------------------------------------------------------------------

function loadConfig(root) {
  const file = join(root, 'workbench.config.json');
  if (!existsSync(file)) throw new WorkbenchError('CONFIG_MISSING', `找不到配置文件：${file}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new WorkbenchError('CONFIG_PARSE_FAILED', `配置文件解析失败：${e.message}`);
  }
  parsed.paths = { tasks: 'tasks', runs: 'runs', scripts: 'scripts', ...(parsed.paths || {}) };
  parsed.runtime = { stepDelayMs: 0, requireNoNetwork: true, ...(parsed.runtime || {}) };
  return parsed;
}

function loadTasks(ctx) {
  const dir = join(ctx.root, ctx.config.paths.tasks);
  if (!existsSync(dir)) throw new WorkbenchError('TASKS_DIR_MISSING', `任务目录不存在：${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new WorkbenchError('TASK_PARSE_FAILED', `任务文件解析失败 ${file}：${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      throw new WorkbenchError('TASK_INVALID', `任务文件缺少 id 字段：${file}`);
    }
    list.push(parsed);
  }
  return { dir, files, list, byId: new Map(list.map((t) => [t.id, t])) };
}

/** 依赖门禁：blockedBy 里任一任务不存在或 status !== done，即视为阻塞。 */
function findBlockers(task, byId) {
  const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
  return deps.filter((id) => {
    const dep = byId.get(id);
    return !dep || dep.status !== 'done';
  });
}

function isReady(task, byId) {
  return findBlockers(task, byId).length === 0;
}

function taskPrompt(task) {
  return [
    `任务 ${task.id}: ${task.title}`,
    `owner: ${task.owner}`,
    `status: ${task.status}`,
    `writeScopes: ${(task.writeScopes || []).join(', ') || '-'}`,
    'acceptance:',
    ...(task.acceptance || []).map((a, i) => `  ${i + 1}. ${a}`),
    'steps:',
    ...(task.steps || []).map((s, i) => `  ${i + 1}. ${s}`),
    '请按「领取 -> 执行 -> 产物 -> 验收」四段输出执行方案。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 运行记录（runs/run-<timestamp>-<taskId>.json / .log）
// ---------------------------------------------------------------------------

function makeStep(index, name, status, startedAt, endedAt, detail) {
  return {
    index: index + 1,
    name,
    title: STAGE_TITLE[name],
    status,
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    detail,
  };
}

function modelField(described) {
  return {
    provider: described.provider,
    id: described.id,
    transport: described.transport,
    offline: described.offline,
  };
}

function buildRecord(ctx, { runId, task, status, outcome, steps, acceptance, blockers, model, exitCode, startedAt, endedAt }) {
  return {
    runId,
    taskId: task.id,
    status, // 落盘枚举: done | failed | unverified | blocked（IN-MEMORY-ONLY 表示仅内存态，不落盘）
    outcome, // success | failed | unverified | blocked
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    exitCode,
    model,
    steps,
    acceptance,
    blockers: blockers || [],
    task: {
      title: task.title,
      owner: task.owner,
      boardStatus: task.status,
      blockedBy: task.blockedBy || [],
      writeScopes: task.writeScopes || [],
    },
    artifacts: {
      json: `${ctx.config.paths.runs}/${runId}.json`,
      log: `${ctx.config.paths.runs}/${runId}.log`,
    },
    runner: {
      name: ctx.config.name,
      version: ctx.config.version,
      node: process.version,
      requireNoNetwork: ctx.config.runtime.requireNoNetwork === true,
      modelProvider: ctx.config.model ? ctx.config.model.provider : null,
    },
  };
}

/**
 * D2 加固：磁盘上只允许出现终态记录。
 * 中间态全部在内存推进，交付文件在收尾时一次性原子写（同目录 .tmp + rename）。
 */
function atomicWrite(target, content) {
  const tmp = join(dirname(target), `.${basename(target)}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, target);
}

/**
 * O2 加固：只清理本文件 atomicWrite 产出的临时文件命名（`.run-<...>.json.tmp` / `.log.tmp`），
 * 不再删除 runs/ 下其它任意隐藏 *.tmp。
 */
function sweepStaleTemps(runsDir) {
  let swept = 0;
  for (const file of readdirSync(runsDir)) {
    if (/^\.run-.*\.tmp$/.test(file)) {
      try {
        unlinkSync(join(runsDir, file));
        swept += 1;
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
  }
  return swept;
}

/**
 * O1 加固：清扫历史上被 kill 而泄漏的探针临时目录（/tmp/agents-workbench-probe-*）。
 * 只匹配自己的命名前缀，且只清年龄超过 STALE_PROBE_MS 的目录，避免误删并发运行中的目录。
 */
const STALE_PROBE_MS = 10 * 60 * 1000; // 10 分钟；正常 verify 的探针目录存活仅毫秒级

function sweepStaleProbeDirs() {
  const base = tmpdir();
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of entries) {
    if (!name.startsWith('agents-workbench-probe-')) continue;
    const full = join(base, name);
    try {
      const info = statSync(full);
      if (!info.isDirectory()) continue;
      if (Date.now() - info.mtimeMs < STALE_PROBE_MS) continue;
      rmSync(full, { recursive: true, force: true });
      swept += 1;
    } catch {
      /* 竞态/权限问题：跳过，绝不影响主流程 */
    }
  }
  return swept;
}

function persistRun(ctx, runId, record) {
  const runsDir = join(ctx.root, ctx.config.paths.runs);
  mkdirSync(runsDir, { recursive: true });
  sweepStaleTemps(runsDir);
  atomicWrite(join(runsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(join(runsDir, `${runId}.log`), renderLog(record));
  return record.artifacts;
}

function renderLog(record) {
  const lines = [];
  lines.push('# agents-workbench run log');
  lines.push(`runId      : ${record.runId}`);
  lines.push(`taskId     : ${record.taskId}`);
  lines.push(`status     : ${record.status} (${record.outcome})`);
  if (record.acceptanceVerdict) lines.push(`verdict    : ${record.acceptanceVerdict}`);
  lines.push(`model      : ${record.model.provider} / ${record.model.id} (transport=${record.model.transport}, offline=${record.model.offline})`);
  lines.push(`startedAt  : ${record.startedAt}`);
  lines.push(`endedAt    : ${record.endedAt}`);
  lines.push(`durationMs : ${record.durationMs}`);
  lines.push(`exitCode   : ${record.exitCode}`);
  lines.push(
    `task       : ${record.task.title} | owner=${record.task.owner} | board-status=${record.task.boardStatus} | blockedBy=[${record.task.blockedBy.join(', ')}]`,
  );
  if (record.blockers.length) lines.push(`blockers   : ${record.blockers.join(', ')}`);
  lines.push('');
  lines.push(`steps (${record.steps.length}):`);
  for (const s of record.steps) {
    lines.push(`  [${s.index}/${STAGE_ORDER.length}] ${s.title} ${s.name} ${s.status} ${s.durationMs}ms`);
    lines.push(`        ${s.detail}`);
  }
  if (record.acceptance.length) {
    lines.push('');
    lines.push('acceptance:');
    for (const a of record.acceptance) lines.push(`  ${padEnd(a.status, 5)} ${a.assertion} — ${a.detail}`);
  }
  lines.push('');
  lines.push('artifacts:');
  lines.push(`  ${record.artifacts.json}`);
  lines.push(`  ${record.artifacts.log}`);
  return `${lines.join('\n')}\n`;
}

function printStep(step) {
  const mark = STATUS_MARK[step.status] || '·';
  out(`  ${mark} [${step.index}/${STAGE_ORDER.length}] ${padEnd(step.title, 6)} ${padEnd(step.name, 9)} ${String(step.durationMs).padStart(4)}ms  ${step.detail}`);
}

function printRunResult(record) {
  out(`结果: status=${record.status} outcome=${record.outcome} exitCode=${record.exitCode} durationMs=${record.durationMs}`);
  out(`日志: ${record.artifacts.json}`);
  out(`      ${record.artifacts.log}`);
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

function renderBoard(ctx, tasks) {
  const cfg = ctx.config;
  const lines = [];
  lines.push(`${cfg.name} v${cfg.version} — 本地多 Agent 协作工作台`);
  lines.push(`说明: ${cfg.description || '-'}`);

  let modelLine = '模型层: (无法解析 model 配置)';
  try {
    const m = describeModel(cfg);
    modelLine = `模型层: provider=${m.provider} id=${m.id} transport=${m.transport} offline=${m.offline ? 'yes' : 'no'} ready=${m.ready ? 'yes' : 'no'}`;
    if (m.problem) modelLine += `\n        注意: ${m.problem}`;
  } catch (e) {
    modelLine = `模型层: 配置错误 ${e.code || e.name}: ${e.message}`;
  }
  lines.push(modelLine);
  lines.push('');

  const roster = Array.isArray(cfg.roster) ? cfg.roster : [];
  lines.push(`花名册 roster (${roster.length} 人；writeScopes 是建议性隔离，不是锁)`);
  lines.push(
    renderTable(
      ['NAME', 'ROLE', 'RELATION', 'REPORTS', 'WRITE SCOPES'],
      roster.map((r) => [r.name, truncate(r.role, 26), r.relation, r.reports, truncate((r.writeScopes || []).join(', '), 62)]),
    ),
  );
  lines.push('');

  const rows = tasks.list.map((t) => {
    const blockers = findBlockers(t, tasks.byId);
    return [
      t.id,
      truncate(t.title, 34),
      t.owner,
      t.status,
      (t.blockedBy || []).join(',') || '-',
      isReady(t, tasks.byId) ? 'yes' : `no (缺 ${blockers.join(',')})`,
    ];
  });
  lines.push(`任务板 task board (${tasks.list.length} 条；数据源 ${cfg.paths.tasks}/)`);
  lines.push(renderTable(['ID', 'TITLE', 'OWNER', 'STATUS', 'BLOCKED BY', 'READY'], rows));
  lines.push('  说明: READY=yes 表示 blockedBy 全部 done，可以 run；READY=no 的任务 run 会以退出码 2 拒绝执行。');
  lines.push('');

  const count = (s) => tasks.list.filter((t) => t.status === s).length;
  const ready = tasks.list.filter((t) => isReady(t, tasks.byId));
  const blocked = tasks.list.length - ready.length;
  lines.push(
    `统计: total=${tasks.list.length} done=${count('done')} pending=${count('pending')} in_progress=${count('in_progress')} | ready=${ready.length} blocked=${blocked}`,
  );
  const next = tasks.list.filter((t) => t.status !== 'done' && isReady(t, tasks.byId));
  if (next.length) {
    lines.push(`下一步: ${next.map((t) => `${t.id}(${t.status}, ready)`).join('、')} 可执行`);
  } else {
    lines.push('下一步: 没有可执行任务（可能都被 blockedBy 阻塞）');
  }
  for (const t of tasks.list.filter((t) => !isReady(t, tasks.byId))) {
    lines.push(
      `         ${t.id} 被阻塞：blockedBy=[${(t.blockedBy || []).join(', ')}] → ${(t.blockedBy || [])
        .map((id) => `${id}=${tasks.byId.get(id)?.status ?? 'missing'}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

function cmdBoard(ctx) {
  const tasks = loadTasks(ctx);
  out(renderBoard(ctx, tasks));
  out('');
  out('退出码 0（看板渲染成功）');
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function reportModelError(error) {
  err(`✖ 模型层配置错误 [${error.code || error.name}] ${error.message}`);
  err(`  提示: 离线自测请使用 provider=mock（默认）；CLI 可用 --provider=mock 临时覆盖。`);
  return EXIT.MODEL_ERROR;
}

async function cmdRun(ctx, taskId, flags) {
  const stepDelay = Number(ctx.config.runtime.stepDelayMs) || 0;
  const tasks = loadTasks(ctx);
  ctx.taskFiles = tasks; // 验收断言需要任务板视图
  const task = tasks.byId.get(taskId);

  if (!task) {
    err(`✖ 任务不存在：${taskId}`);
    err(`  可用任务: ${tasks.list.map((t) => t.id).join(', ') || '(tasks/ 为空)'}`);
    err(`  退出码 1（任务不存在）`);
    return EXIT.FAIL;
  }

  const startedAt = new Date();
  const runId = uniqueRunId(ctx, startedAt, task.id);
  out(`▶ run ${task.id} — ${task.title}`);
  out(`  runId: ${runId}   owner=${task.owner}   board-status=${task.status}`);

  // --- 第 0 步：依赖门禁（只读任务板；阻塞时拒绝执行并留一条 blocked 日志） ---
  const blockers = findBlockers(task, tasks.byId);
  if (blockers.length) {
    const claimStart = new Date();
    const detail = `依赖门禁拒绝执行：${blockers
      .map((id) => `${id}(status=${tasks.byId.get(id)?.status ?? 'missing'})`)
      .join(', ')} 未完成`;
    const claimEnd = new Date();
    const steps = [makeStep(0, 'claim', 'blocked', claimStart, claimEnd, detail)];
    const endedAt = new Date();
    const record = buildRecord(ctx, {
      runId,
      task,
      status: 'blocked',
      outcome: 'blocked',
      steps,
      acceptance: [],
      blockers,
      model: modelField(describeModel(ctx.config, flags)),
      exitCode: EXIT.BLOCKED,
      startedAt,
      endedAt,
    });
    printStep(steps[0]);
    out(`阻塞: ${task.id} blockedBy=[${(task.blockedBy || []).join(', ')}] → ${blockers.join(', ')} 未 done，拒绝执行`);
    out(`提示: 先完成 ${blockers.join('、')} 再重试；runner 不改写 tasks/，状态流转见运行日志。`);
    persistRun(ctx, runId, record);
    printRunResult(record);
    err(`✖ 退出码 2（被 blockedBy 阻塞）`);
    return EXIT.BLOCKED;
  }

  // --- 模型层预检：配置错误时不开跑、不留运行记录（这是操作者配置问题，不是任务执行结果） ---
  let adapter;
  try {
    adapter = createModel(ctx.config, flags);
  } catch (error) {
    if (error instanceof ModelConfigError) return reportModelError(error);
    throw error;
  }
  const model = modelField(adapter.describe());

  const steps = [];
  const startedMs = Date.now();

  // --- 第 1 步：领取 claim ---
  const claimStart = new Date();
  if (stepDelay) await sleep(stepDelay);
  const claimEnd = new Date();
  const claimDetail =
    `任务 ${task.id} 领取成功：owner=${task.owner}，blockedBy=[${(task.blockedBy || []).join(', ')}] 全部 done；` +
    `当前任务板 status=${task.status}` +
    (task.status === 'done' ? '（已完成任务的重跑，用于留证，不改写任务板）' : '（runner 只读 tasks/，状态流转记录在运行日志）');
  steps.push(makeStep(0, 'claim', 'ok', claimStart, claimEnd, claimDetail));
  printStep(steps[0]);

  // --- 第 2 步：执行 execute（provider=mock：确定性输出） ---
  const execStart = new Date();
  let completion;
  try {
    if (stepDelay) await sleep(stepDelay);
    completion = adapter.complete(taskPrompt(task), { taskId: task.id });
  } catch (error) {
    const execEnd = new Date();
    steps.push(makeStep(1, 'execute', 'fail', execStart, execEnd, `${error.code || error.name}: ${error.message}`));
    printStep(steps[1]);
    const endedAt = new Date();
    const acceptance = (task.acceptance || []).map((a) => ({ assertion: a, status: 'SKIP', detail: '执行阶段失败，未进入验收' }));
    const record = buildRecord(ctx, {
      runId,
      task,
      status: 'failed',
      outcome: 'failed',
      steps,
      acceptance,
      blockers: [],
      model,
      exitCode: EXIT.MODEL_ERROR,
      startedAt,
      endedAt,
    });
    persistRun(ctx, runId, record);
    printRunResult(record);
    err(`✖ 退出码 3（模型层执行错误 ${error.code || error.name}）`);
    return EXIT.MODEL_ERROR;
  }
  const execEnd = new Date();
  steps.push(
    makeStep(
      1,
      'execute',
      'ok',
      execStart,
      execEnd,
      `provider=${completion.provider} model=${completion.model} transport=${completion.transport} ` +
        `promptChars=${completion.usage.promptChars} completionChars=${completion.usage.completionChars} deterministic=yes`,
    ),
  );
  printStep(steps[1]);

  // --- 第 3 步：产物 artifact ---
  // D2 加固：中间态只存在于内存。这里完成运行记录的组装（含 mock 输出摘要），
  // 但不落盘——磁盘上不会出现 status=running / exitCode=null 的半成品记录。
  const artStart = new Date();
  if (stepDelay) await sleep(stepDelay);
  const prepared = buildRecord(ctx, {
    runId,
    task,
    status: 'IN-MEMORY-ONLY', // D2：该对象绝不落盘，磁盘上只会出现终态记录
    outcome: 'IN-MEMORY-ONLY',
    steps: [...steps],
    acceptance: [],
    blockers: [],
    model,
    exitCode: null,
    startedAt,
    endedAt: new Date(),
  });
  prepared.modelCalls = completion.usage.calls;
  prepared.outputDigest = completion.digest;
  prepared.outputPreview = completion.text.split('\n')[0];
  const preparedJson = `${JSON.stringify(prepared, null, 2)}\n`;
  const artEnd = new Date();
  steps.push(
    makeStep(
      2,
      'artifact',
      'ok',
      artStart,
      artEnd,
      `运行记录已在内存组装（json ${Buffer.byteLength(preparedJson)}B，含 sha256 prompt-digest=${prepared.outputDigest}）；` +
        `验收后一次性原子写出 ${ctx.config.paths.runs}/${runId}.json 与 .log（磁盘上不出现非终态记录）`,
    ),
  );
  printStep(steps[2]);

  // --- 第 4 步：验收 verify（逐条跑 acceptance 断言，然后原子落盘终态记录） ---
  const verStart = new Date();
  if (stepDelay) await sleep(stepDelay);
  const evaluation = evaluateTask(ctx, task);
  const verEnd = new Date();
  const failCount = evaluation.failed;
  steps.push(
    makeStep(
      3,
      'verify',
      failCount ? 'fail' : evaluation.verdict === 'UNVERIFIED' ? 'skip' : 'ok',
      verStart,
      verEnd,
      `acceptance ${evaluation.passed} PASS / ${failCount} FAIL / ${evaluation.skipped} SKIP → 任务级结论 ${evaluation.verdict}` +
        (evaluation.registered ? '' : '（该 taskId 未注册断言检查器，零覆盖）'),
    ),
  );
  printStep(steps[3]);

  const endedAt = new Date();
  const verdict = evaluation.verdict;
  const status = verdict === 'FAIL' ? 'failed' : verdict === 'UNVERIFIED' ? 'unverified' : 'done';
  const outcome = verdict === 'FAIL' ? 'failed' : verdict === 'UNVERIFIED' ? 'unverified' : 'success';
  // 退出码契约：0 成功 / 1 验收 FAIL（--strict 下 UNVERIFIED 也计 1）；UNVERIFIED 默认非致命。
  const exitCode = verdict === 'FAIL' ? EXIT.FAIL : verdict === 'UNVERIFIED' && flags.strict ? EXIT.FAIL : EXIT.OK;
  const record = buildRecord(ctx, {
    runId,
    task,
    status,
    outcome,
    steps,
    acceptance: evaluation.results,
    blockers: [],
    model,
    exitCode,
    startedAt,
    endedAt,
  });
  record.modelCalls = completion.usage.calls;
  record.outputDigest = completion.digest;
  record.outputPreview = completion.text.split('\n')[0];
  record.acceptanceVerdict = verdict;
  record.strict = flags.strict === true;
  persistRun(ctx, runId, record);
  out(`  mock 输出首行: ${record.outputPreview}  (prompt-digest=${record.outputDigest})`);
  if (verdict === 'UNVERIFIED') {
    out(
      `⚠ WARN: ${task.id} 的 acceptance 零覆盖 → 结论 UNVERIFIED（未验证，不算通过）` +
        (flags.strict ? '；--strict 已开启，退出码按失败处理' : '；默认不致命，可用 --strict 使其失败'),
    );
  }
  printRunResult(record);
  out(`总耗时(自 measure): ${Date.now() - startedMs}ms`);
  return record.exitCode;
}

// ---------------------------------------------------------------------------
// 验收断言（verify 注册表，按 task id 映射到 acceptance 原句）
// ---------------------------------------------------------------------------

function ok(detail) {
  return { status: 'PASS', detail };
}

function bad(detail) {
  return { status: 'FAIL', detail };
}

function skip(detail) {
  return { status: 'SKIP', detail };
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

function spawnRunner(root, args, env) {
  const entry = join(root, 'scripts', 'workbench.mjs');
  const res = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: env || process.env,
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

function acceptanceRegistry() {
  const registry = new Map();

  registry.set('W-001', [
    {
      assertion: 'tasks/ 下任务文件可被 runner 读取',
      check: (ctx) => {
        const files = ctx.taskFiles;
        if (!files.files || files.files.length === 0) return bad('tasks/ 下没有 *.json 任务文件');
        const missing = [];
        for (const t of files.list) {
          for (const key of ['id', 'title', 'owner', 'status', 'acceptance', 'writeScopes']) {
            if (t[key] === undefined) missing.push(`${t.id}.${key}`);
          }
        }
        if (missing.length) return bad(`任务字段缺失：${missing.join(', ')}`);
        return ok(`成功读取 ${files.files.length} 个任务文件：${files.files.join(', ')}`);
      },
    },
    {
      assertion: 'workbench.config.json 中 roster 与 model 字段完整',
      check: (ctx) => {
        const cfg = ctx.config;
        const problems = [];
        if (!Array.isArray(cfg.roster) || cfg.roster.length === 0) problems.push('roster 缺失或为空');
        else
          cfg.roster.forEach((r, i) => {
            for (const k of ['name', 'role', 'relation', 'writeScopes', 'reports']) {
              if (r[k] === undefined) problems.push(`roster[${i}].${k}`);
            }
          });
        if (!cfg.model || typeof cfg.model !== 'object') problems.push('model 缺失');
        else
          for (const k of ['provider', 'id', 'baseUrl', 'apiKeyEnv']) {
            if (!cfg.model[k]) problems.push(`model.${k}`);
          }
        if (problems.length) return bad(problems.join('; '));
        return ok(`roster ${cfg.roster.length} 人字段齐全；model.provider=${cfg.model.provider} id=${cfg.model.id}`);
      },
    },
  ]);

  registry.set('W-002', [
    {
      assertion: 'provider=mock 时不产生任何网络请求',
      check: (ctx) => {
        const problems = [];
        if (ctx.config.runtime.requireNoNetwork !== true) problems.push('runtime.requireNoNetwork !== true');
        if (ctx.config.model.provider !== 'mock') problems.push(`默认 model.provider=${ctx.config.model.provider}（应为 mock）`);
        const adapter = createModel(ctx.config);
        if (adapter.transport !== 'none') problems.push(`mock adapter transport=${adapter.transport}（应为 none）`);
        if (adapter.offline !== true) problems.push('mock adapter offline !== true');
        const prompt = taskPrompt(ctx.taskFiles.byId.get('W-002') || { id: 'W-002', title: 'probe', owner: '-', status: '-' });
        const a = adapter.complete(prompt).text;
        const b = adapter.complete(prompt).text;
        if (a !== b) problems.push('mock 输出不确定（两次调用不一致）');
        if (problems.length) return bad(problems.join('; '));
        return ok('requireNoNetwork=true, provider=mock, transport=none, 同 prompt 两次输出完全一致');
      },
    },
    {
      assertion: 'provider=openai-compatible 时读取 apiKeyEnv 指定的环境变量',
      check: (ctx) => {
        const envName = ctx.config.model.apiKeyEnv;
        const probeKey = 'probe-key-not-a-secret';
        try {
          return withEnv(envName, probeKey, () => {
            const adapter = createModel(ctx.config, { providerOverride: 'openai-compatible' });
            if (adapter.apiKeyEnv !== envName) return bad(`adapter.apiKeyEnv=${adapter.apiKeyEnv}，期望 ${envName}`);
            if (adapter.apiKeyLoaded !== true) return bad('apiKeyLoaded !== true');
            if (adapter.apiKeyLength !== probeKey.length) {
              return bad(`apiKeyLength=${adapter.apiKeyLength}，期望 ${probeKey.length}`);
            }
            return ok(`从 ${envName} 读到 key（长度 ${adapter.apiKeyLength}，不打印内容）；baseUrl=${adapter.baseUrl}`);
          });
        } catch (error) {
          return bad(`${error.code || error.name}: ${error.message}`);
        }
      },
    },
    {
      assertion: '缺少 apiKey 时报错信息明确且退出码非 0',
      check: (ctx) => {
        const envName = ctx.config.model.apiKeyEnv;
        let inProc = null;
        withEnv(envName, undefined, () => {
          try {
            createModel(ctx.config, { providerOverride: 'openai-compatible' });
          } catch (error) {
            inProc = error;
          }
        });
        if (!inProc) return bad('缺少 apiKey 时 createModel 未报错');
        if (inProc.code !== 'MODEL_API_KEY_MISSING') return bad(`错误 code=${inProc.code}，期望 MODEL_API_KEY_MISSING`);
        if (!String(inProc.message).includes(envName)) return bad(`错误信息未提及 ${envName}`);

        const env = { ...process.env };
        delete env[envName];
        const res = spawnRunner(ctx.root, ['run', 'W-001', '--provider=openai-compatible'], env);
        const merged = `${res.stdout}\n${res.stderr}`;
        if (res.status === 0) return bad('CLI 缺少 apiKey 时退出码为 0，期望非 0');
        if (!merged.includes(envName)) return bad('CLI 报错信息未提及 apiKeyEnv');
        return ok(`进程内抛 ModelConfigError(MODEL_API_KEY_MISSING)；CLI 退出码 ${res.status} 且报错含 ${envName}`);
      },
    },
  ]);

  return registry;
}

/**
 * D1 加固：任务级结论三档 PASS / FAIL / UNVERIFIED。
 * - 有 acceptance 但零覆盖（全部 SKIP，即未注册检查器或检查器无从执行）→ UNVERIFIED，绝不算 PASS。
 * - UNVERIFIED 默认不导致非 0 退出码；`--strict` 下计入失败。
 * 注意：因 blockedBy 未满足而在进任务前被跳过的任务不进入本函数，属 BLOCKED-SKIP 档，不影响退出码。
 */
function evaluateTask(ctx, task) {
  const checks = acceptanceRegistry().get(task.id);
  let registered = true;
  let results;
  if (!checks) {
    registered = false;
    results = (task.acceptance || []).map((a) => ({
      assertion: a,
      status: 'SKIP',
      detail: '该 taskId 未在 verify 注册表注册断言检查器（种子任务之外的 id 需要扩展注册表）',
    }));
  } else {
    results = checks.map((c) => {
      let r;
      try {
        r = c.check(ctx);
      } catch (error) {
        r = bad(`${error.code || error.name}: ${error.message}`);
      }
      return { assertion: c.assertion, status: r.status, detail: r.detail };
    });
  }
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const coverage = results.length - skipped; // 真正跑出结论的断言条数
  let verdict = 'PASS';
  if (failed > 0) verdict = 'FAIL';
  else if (coverage === 0) verdict = 'UNVERIFIED';
  return { registered, results, passed, failed, skipped, coverage, verdict };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * D4 加固：契约退出码需要 CLI 级真实证据，因此在系统临时目录里复制一份 runner +
 * 合成任务板来 spawn 出各退出码。临时目录用完即删，绝不污染交付目录的 tasks/。
 */
function buildProbeBoard(ctx) {
  const tmp = mkdtempSync(join(tmpdir(), 'agents-workbench-probe-'));
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  mkdirSync(join(tmp, 'tasks'), { recursive: true });
  const scriptsDir = join(ctx.root, 'scripts');
  for (const file of readdirSync(scriptsDir)) copyFileSync(join(scriptsDir, file), join(tmp, 'scripts', file));
  copyFileSync(join(ctx.root, 'workbench.config.json'), join(tmp, 'workbench.config.json'));
  const mkTask = (id, status, blockedBy) => ({
    id,
    title: `probe ${id}`,
    owner: 'probe',
    status,
    blockedBy,
    writeScopes: ['probe/'],
    acceptance: ['probe 断言（故意不注册检查器）'],
    steps: ['probe 步骤'],
    result: null,
  });
  writeFileSync(join(tmp, 'tasks', 'T-001.json'), `${JSON.stringify(mkTask('T-001', 'done', []), null, 2)}\n`);
  writeFileSync(join(tmp, 'tasks', 'T-002.json'), `${JSON.stringify(mkTask('T-002', 'pending', []), null, 2)}\n`);
  writeFileSync(join(tmp, 'tasks', 'T-003.json'), `${JSON.stringify(mkTask('T-003', 'pending', ['T-002']), null, 2)}\n`);
  return tmp;
}

function contractChecks() {
  return [
    {
      name: 'mustRunOffline',
      check: (ctx) => {
        if (ctx.config.runtime.requireNoNetwork !== true) return bad('runtime.requireNoNetwork !== true');
        if (ctx.config.model.provider !== 'mock') return bad(`默认 provider=${ctx.config.model.provider}`);
        const adapter = createModel(ctx.config);
        if (adapter.transport !== 'none' || adapter.offline !== true) return bad('mock adapter 并非离线 transport=none');
        return ok('默认 mock：transport=none；runtime.requireNoNetwork=true；scripts/ 静态检查另见 grep 证据');
      },
    },
    {
      name: 'mustExposeBoardView',
      check: (ctx) => {
        const view = renderBoard(ctx, ctx.taskFiles);
        const missing = [];
        if (!view.includes('花名册')) missing.push('花名册小节');
        if (!view.includes('任务板')) missing.push('任务板小节');
        for (const t of ctx.taskFiles.list) if (!view.includes(t.id)) missing.push(`任务 ${t.id}`);
        if (!view.includes('READY')) missing.push('READY 列');
        if (missing.length) return bad(`看板缺少：${missing.join(', ')}`);
        return ok(`board 渲染包含花名册 + 任务板表格（${ctx.taskFiles.list.length} 条任务、READY 列）`);
      },
    },
    {
      name: 'mustEnforceDependencies',
      check: () => {
        const pending = new Map([['SIM-1', { id: 'SIM-1', status: 'pending' }]]);
        const done = new Map([['SIM-1', { id: 'SIM-1', status: 'done' }]]);
        const blocked = findBlockers({ id: 'SIM-2', blockedBy: ['SIM-1'] }, pending);
        const free = findBlockers({ id: 'SIM-2', blockedBy: ['SIM-1'] }, done);
        const none = findBlockers({ id: 'SIM-2' }, new Map());
        const missing = findBlockers({ id: 'SIM-2', blockedBy: ['GONE'] }, new Map());
        if (blocked.length !== 1) return bad('blockedBy 指向 pending 时未被判定为阻塞');
        if (free.length !== 0) return bad('blockedBy 全部 done 时仍被判定为阻塞');
        if (none.length !== 0) return bad('无 blockedBy 时被判定为阻塞');
        if (missing.length !== 1) return bad('blockedBy 指向不存在的任务时未被判定为阻塞');
        return ok('pending→阻塞、done→放行、无依赖→放行、依赖缺失→阻塞 四种情形全部符合');
      },
    },
    {
      name: 'mustReportExitCodes',
      check: (ctx) => {
        const problems = [];
        if (EXIT.OK !== 0) problems.push(`OK=${EXIT.OK}`);
        if (EXIT.FAIL !== 1) problems.push(`FAIL=${EXIT.FAIL}`);
        if (EXIT.BLOCKED !== 2) problems.push(`BLOCKED=${EXIT.BLOCKED}`);
        if (EXIT.MODEL_ERROR !== 3) problems.push(`MODEL_ERROR=${EXIT.MODEL_ERROR}`);
        if (problems.length) return bad(`退出码常量与契约不符：${problems.join('; ')}`);

        // D4 加固：在临时任务板上真实 spawn 出 0 / 1 / 2 / 3 四条 CLI 路径。
        // 每条同时断言**输出内容**，防止「静默不执行也退 0」把 0 伪装成通过。
        const probeRoot = buildProbeBoard(ctx);
        const observed = [];
        try {
          const c0 = spawnRunner(probeRoot, ['board'], { ...process.env });
          observed.push(`board→${c0.status}`);
          if (c0.status !== EXIT.OK) problems.push(`board 期望 0，实测 ${c0.status}`);
          if (!c0.stdout.includes('任务板')) problems.push('board 退 0 但 stdout 无任务板输出（疑似未真正执行）');

          const c1 = spawnRunner(probeRoot, ['run', '__NO_SUCH_TASK__'], { ...process.env });
          observed.push(`run 未知任务→${c1.status}`);
          if (c1.status !== EXIT.FAIL) problems.push(`run 未知任务期望 1，实测 ${c1.status}`);
          if (!`${c1.stdout}${c1.stderr}`.includes('任务不存在')) problems.push('run 未知任务退 1 但无「任务不存在」报错（疑似未真正执行）');

          const c2 = spawnRunner(probeRoot, ['run', 'T-003'], { ...process.env });
          observed.push(`run 被 blockedBy 阻塞→${c2.status}`);
          if (c2.status !== EXIT.BLOCKED) problems.push(`run 被阻塞期望 2，实测 ${c2.status}`);
          if (!`${c2.stdout}${c2.stderr}`.includes('blockedBy')) problems.push('run 被阻塞退 2 但无 blockedBy 说明（疑似未真正执行）');

          const env3 = { ...process.env };
          delete env3[ctx.config.model.apiKeyEnv];
          const c3 = spawnRunner(probeRoot, ['run', 'T-001', '--provider=openai-compatible'], env3);
          observed.push(`run 模型配置错误→${c3.status}`);
          if (c3.status !== EXIT.MODEL_ERROR) problems.push(`run 模型配置错误期望 3，实测 ${c3.status}`);
          if (!`${c3.stdout}${c3.stderr}`.includes(ctx.config.model.apiKeyEnv)) {
            problems.push('run 模型配置错误退 3 但报错未提及 apiKeyEnv（疑似未真正执行）');
          }
        } finally {
          rmSync(probeRoot, { recursive: true, force: true });
        }
        if (problems.length) return bad(problems.join('; '));
        return ok(`在临时任务板上 CLI 实测契约退出码：${observed.join('，')}；临时目录已清理，tasks/ 未被触碰`);
      },
    },
  ];
}

async function cmdVerify(ctx) {
  const tasks = loadTasks(ctx);
  ctx.taskFiles = tasks;
  const strict = ctx.flags.strict === true;
  out(`${ctx.config.name} verify — 对依赖已满足的任务逐条跑 acceptance 断言${strict ? '（--strict）' : ''}`);
  out('');

  // D3 加固：任务板为空属配置异常（任务被误删/路径配错），不能报「全部通过」。
  if (tasks.list.length === 0) {
    out(`⚠ WARN: 任务板为空 —— ${ctx.config.paths.tasks}/ 下 0 个 *.json，没有任何可验收内容。`);
    out('⚠ WARN: 判定 UNKNOWN（配置异常，不是通过），退出码 1。请检查任务目录与 paths.tasks 配置。');
    err('✖ 退出码 1（任务板为空 → UNKNOWN）');
    return EXIT.FAIL;
  }

  const satisfied = [];
  const skippedTasks = [];
  for (const t of tasks.list) {
    const blockers = findBlockers(t, tasks.byId);
    if (blockers.length) skippedTasks.push({ task: t, blockers });
    else satisfied.push(t);
  }

  let passed = 0;
  let failed = 0;
  let unverified = 0;
  let taskPass = 0;
  let taskFail = 0;
  let taskUnverified = 0;
  const failures = [];

  out(`依赖已满足的任务 (${satisfied.length}/${tasks.list.length}): ${satisfied.map((t) => t.id).join(', ') || '(无)'}`);
  for (const s of skippedTasks) {
    out(
      `BLOCKED-SKIP ${s.task.id}：依赖未完成 → ${s.blockers.map((id) => `${id}=${tasks.byId.get(id)?.status ?? 'missing'}`).join(', ')}`,
    );
  }
  out('');

  for (const t of satisfied) {
    const evaluation = evaluateTask(ctx, t);
    if (evaluation.verdict === 'PASS') taskPass += 1;
    else if (evaluation.verdict === 'FAIL') taskFail += 1;
    else taskUnverified += 1;
    out(
      `[${t.id}] ${evaluation.verdict}  ${evaluation.passed} PASS / ${evaluation.failed} FAIL / ${evaluation.skipped} SKIP`,
    );
    for (const r of evaluation.results) {
      out(`  ${STATUS_MARK[r.status === 'PASS' ? 'ok' : r.status === 'FAIL' ? 'fail' : 'skip']} ${r.assertion}`);
      out(`      ${r.detail}`);
      if (r.status === 'PASS') passed += 1;
      if (r.status === 'FAIL') {
        failed += 1;
        failures.push(`${t.id}: ${r.assertion} — ${r.detail}`);
      }
      if (r.status === 'SKIP') unverified += 1;
    }
    if (evaluation.verdict === 'UNVERIFIED') {
      const why =
        evaluation.results.length === 0
          ? 'acceptance 为空数组（字段存在但无任何可验收内容）'
          : `${evaluation.results.length} 条 acceptance 全部零覆盖（未注册检查器）`;
      out(`  ⚠ ${t.id} 结论 UNVERIFIED：${why}——不算通过` + (strict ? '；--strict 下计入失败' : '；默认不致命，可用 --strict 收紧'));
    }
    out('');
  }

  // O1 加固：顺带清扫历史上被 kill 泄漏的探针临时目录（正常路径的 finally 已覆盖）
  const sweptProbeDirs = sweepStaleProbeDirs();
  if (sweptProbeDirs > 0) out(`清理陈旧探针临时目录: ${sweptProbeDirs} 个（${tmpdir()}/agents-workbench-probe-*，年龄 > 10min）`);
  out('运行契约检查（workbench.config.json 的 acceptance 四项）');
  for (const c of contractChecks()) {
    let r;
    try {
      r = c.check(ctx);
    } catch (error) {
      r = bad(`${error.code || error.name}: ${error.message}`);
    }
    out(`  ${STATUS_MARK[r.status === 'PASS' ? 'ok' : 'fail']} ${c.name}: ${r.status}`);
    out(`      ${r.detail}`);
    if (r.status === 'PASS') passed += 1;
    else {
      failed += 1;
      failures.push(`contract ${c.name} — ${r.detail}`);
    }
  }
  out('');

  const blockedSkip = skippedTasks.length;
  const skippedIds = skippedTasks.map((s) => s.task.id).join(', ') || '无';
  if (satisfied.length === 0) {
    out(`⚠ WARN: 0 条任务可验收（${tasks.list.length} 条任务全部被 blockedBy 跳过）；按 D1 规则 BLOCKED-SKIP 不影响退出码。`);
  }
  out(`汇总(断言级): ${passed} PASS / ${failed} FAIL / ${unverified} UNVERIFIED / ${blockedSkip} BLOCKED-SKIP`);
  out(`汇总(任务级): ${taskPass} PASS / ${taskFail} FAIL / ${taskUnverified} UNVERIFIED / ${blockedSkip} BLOCKED-SKIP`);
  out(
    `  说明: UNVERIFIED = 零覆盖被 SKIP 的 acceptance 条目（有验收但无检查器，不算通过）；BLOCKED-SKIP = 依赖未满足被跳过的任务（${skippedIds}）。`,
  );
  out(
    `  档位: ${strict ? '--strict 已开启 → UNVERIFIED 计入失败（退出码非 0）' : '默认 → UNVERIFIED 不导致非 0（契约「全过 0 否则 1」；可用 --strict 收紧）'}`,
  );

  // D6 加固：strict 门必须同时覆盖「断言级」与「任务级」零覆盖。
  // acceptance: [] 的任务没有可 SKIP 的条目（断言级计数为 0），但任务级为 UNVERIFIED。
  const hasUnverified = unverified > 0 || taskUnverified > 0;

  if (failed) {
    for (const f of failures) err(`✖ ${f}`);
    err(`✖ 退出码 1（验收存在 FAIL）`);
    return EXIT.FAIL;
  }
  if (hasUnverified && strict) {
    err(`✖ 退出码 1（--strict：存在 ${taskUnverified} 条 UNVERIFIED 任务 / ${unverified} 条 UNVERIFIED 断言）`);
    return EXIT.FAIL;
  }
  out(
    `✔ 退出码 0（无 FAIL${
      hasUnverified
        ? `；存在 UNVERIFIED：${taskUnverified} 条任务 / ${unverified} 条断言，默认非致命（--strict 下会失败）`
        : '，全部验收通过'
    }）`,
  );
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--provider=')) flags.providerOverride = a.slice('--provider='.length);
    else if (a === '--provider') {
      i += 1;
      flags.providerOverride = argv[i];
    } else if (a === '--strict') flags.strict = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positionals.push(a);
  }
  return { positionals, flags };
}

function printUsage(code) {
  const lines = [
    'agents-workbench runner',
    '',
    '用法:',
    '  node scripts/workbench.mjs board              打印花名册 + 任务板',
    '  node scripts/workbench.mjs run <taskId>       执行一条任务（写 runs/ 日志）',
    '  node scripts/workbench.mjs verify             对依赖已满足的任务跑验收断言',
    '',
    '退出码: 0 成功 / 1 任务不存在或验收 FAIL / 2 被 blockedBy 阻塞 / 3 模型层配置错误',
    '可选参数: --provider=<mock|openai-compatible>  临时覆盖 model.provider（不落盘）',
    '         --strict                              verify/run 下把 UNVERIFIED（零覆盖）计入失败',
    '         --help',
  ];
  const text = lines.join('\n');
  if (code === 0) out(text);
  else err(text);
  return code;
}

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.help) return printUsage(0);
  if (positionals.length === 0) return printUsage(EXIT.FAIL);

  const root = WORKBENCH_ROOT;
  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    err(`✖ [${error.code || error.name}] ${error.message}`);
    return EXIT.FAIL;
  }
  const ctx = { root, config, flags };

  const command = positionals[0];
  const rest = positionals.slice(1);
  try {
    if (command === 'board') return cmdBoard(ctx);
    if (command === 'run') {
      if (!rest[0]) {
        err('✖ run 缺少 taskId');
        return printUsage(EXIT.FAIL);
      }
      return await cmdRun(ctx, rest[0], flags);
    }
    if (command === 'verify') return await cmdVerify(ctx);
    err(`✖ 未知子命令：${command}`);
    return printUsage(EXIT.FAIL);
  } catch (error) {
    if (error instanceof WorkbenchError || error instanceof ModelConfigError) {
      err(`✖ [${error.code || error.name}] ${error.message}`);
      return error instanceof ModelConfigError ? EXIT.MODEL_ERROR : EXIT.FAIL;
    }
    err(`✖ 未预期错误: ${error && error.stack ? error.stack : String(error)}`);
    return EXIT.FAIL;
  }
}

/**
 * 判断本模块是否为 CLI 入口。
 * 加固：Node 的 ESM loader 会把 import.meta.url 解析为 realpath，而 process.argv[1]
 * 可能仍带符号链接（例如 macOS 上 /tmp -> /private/tmp）。只比较原样路径会导致
 * 「经符号链接调用时静默不执行、退出码 0」的假成功，因此两种形式都要比。
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const candidates = [pathToFileURL(resolve(process.argv[1])).href];
  try {
    candidates.push(pathToFileURL(realpathSync(process.argv[1])).href);
  } catch {
    /* 路径不存在等情形：只用原样形式比较 */
  }
  return candidates.includes(import.meta.url);
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      err(`✖ 未捕获错误: ${error && error.stack ? error.stack : String(error)}`);
      process.exitCode = EXIT.FAIL;
    });
}
