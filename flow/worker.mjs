// ============================================================================
// flow/worker.mjs — v0.2 agent 执行单元（pilot）
//   契约见 flow/SPEC.md §6（命令行冻结）：
//     node flow/worker.mjs --run-dir <dir> --task-id <T> --slot <n> --flow <flowPath>
//   四段：claim → execute → artifact → verify
//   叶子进程：绝不创建任何子进程；只写自己的 artifact、经 store 改 state、
//   追加 events、持有并释放自己的 claim 锁。
//   退出码（冻结）：0 成功 / 1 任务失败（可重试）/ 2 未拿到 claim（不是错误）
// ============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createEventWriter } from './events.mjs';
import { claimTask, readState, releaseClaim, setTaskStatus } from './store.mjs';
import { createModel } from './model.mjs';

const EXIT_OK = 0;
const EXIT_TASK_FAILED = 1;
const EXIT_NO_CLAIM = 2;

const USAGE = '用法：node flow/worker.mjs --run-dir <dir> --task-id <T> --slot <n> --flow <flowPath>';

class UsageError extends Error {}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function warn(line) {
  process.stderr.write(`${line}\n`);
}

/** 解析冻结命令行；支持 `--k v` 与 `--k=v`。 */
function parseArgs(argv) {
  const known = { '--run-dir': 'runDir', '--task-id': 'taskId', '--slot': 'slot', '--flow': 'flow' };
  const out = { runDir: null, taskId: null, slot: null, flow: null };
  for (let i = 0; i < argv.length; i += 1) {
    let key = argv[i];
    let value = null;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const field = known[key];
    if (!field) throw new UsageError(`未知参数：${argv[i]}`);
    if (value === null) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value === null) throw new UsageError(`参数 ${key} 缺少取值`);
    if (field === 'slot') {
      const n = Number(value);
      out.slot = Number.isFinite(n) ? n : null;
    } else {
      out[field] = String(value);
    }
  }
  return out;
}

/** run 目录里的 flow.json 快照优先（一次运行的真相）；否则回退到 --flow 指定路径。 */
function loadFlow(runDir, flowArg) {
  const snapshot = join(runDir, 'flow.json');
  if (existsSync(snapshot)) {
    try {
      return JSON.parse(readFileSync(snapshot, 'utf8'));
    } catch (error) {
      throw new Error(`flow.json 快照损坏：${snapshot}（${error.message}）`);
    }
  }
  if (flowArg) {
    const flowPath = isAbsolute(flowArg) ? flowArg : resolve(process.cwd(), flowArg);
    if (existsSync(flowPath)) {
      try {
        return JSON.parse(readFileSync(flowPath, 'utf8'));
      } catch (error) {
        throw new Error(`flow 定义无法解析：${flowPath}（${error.message}）`);
      }
    }
    throw new Error(`flow 定义不存在：${flowPath}`);
  }
  throw new Error(`既没有 ${snapshot}，也没有 --flow 参数`);
}

/** 原子写：同目录 tmp + rename（不留半成品）。 */
function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, text);
  renameSync(tmp, filePath);
  return Buffer.byteLength(text);
}

/** 确定性 prompt：同一 task+attempt+slot 永远一致。 */
function buildPrompt({ flowRunId, task, slotId, attempt }) {
  const needs = (task.needs || []).join(',') || '(none)';
  const acceptance = (task.acceptance || []).join(' | ') || '(none)';
  const lines = [
    `flow=${flowRunId ?? '-'} task=${task.id} slot=${slotId ?? '-'} attempt=${attempt}/${task.maxAttempts}`,
    `title=${task.title}`,
    `role=${task.role}`,
    `needs=${needs}`,
    `acceptance=${acceptance}`,
  ];
  if (Array.isArray(task.steps) && task.steps.length) lines.push(`steps=${task.steps.join(' | ')}`);
  lines.push('', '请按「claim 领取 → execute 执行 → artifact 产物 → verify 验收」四段推进，输出确定性执行方案。');
  return lines.join('\n');
}

/**
 * acceptance 判定（SPEC §8 冻结规则）：
 * 断言字符串以 `!` 结尾 → 期望失败（结果 FAIL，用于演示 FAIL 路径），否则 PASS。
 */
function runAcceptance(acceptance) {
  const list = Array.isArray(acceptance) ? acceptance.map(String) : [];
  let passed = 0;
  let failed = 0;
  const results = list.map((assertion) => {
    const expectsFail = /!\s*$/.test(assertion);
    const result = expectsFail ? 'FAIL' : 'PASS';
    if (result === 'PASS') passed += 1;
    else failed += 1;
    return { assertion, expected: expectsFail ? 'fail' : 'pass', result };
  });
  return {
    rule: 'trailing-bang-means-expected-failure',
    total: results.length,
    passed,
    failed,
    results,
  };
}

async function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    warn(`${error.message}\n${USAGE}`);
    return EXIT_NO_CLAIM;
  }
  if (!args.runDir || !args.taskId) {
    warn(`缺少必填参数 ${!args.runDir ? '--run-dir ' : ''}${!args.taskId ? '--task-id' : ''}\n${USAGE}`);
    return EXIT_NO_CLAIM;
  }

  const runDir = isAbsolute(args.runDir) ? args.runDir : resolve(process.cwd(), args.runDir);
  const taskId = args.taskId;
  const slotId = args.slot;

  // 进入 claim 之前的准备：任何失败都没有认领，任务状态不动 → 退出码 2
  let flow;
  let state;
  try {
    flow = loadFlow(runDir, args.flow);
    state = readState(runDir);
  } catch (error) {
    warn(`worker 准备失败：${error.message}`);
    return EXIT_NO_CLAIM;
  }
  const flowRunId = state.flowRunId || null;
  const events = createEventWriter(runDir);

  // ── 1. claim ────────────────────────────────────────────────────────────
  const claim = claimTask(runDir, taskId, { slotId, pid: process.pid });
  if (!claim.ok) {
    // 认领锁的收尾一律由 store.claimTask 的 abandon() 负责，worker 绝不删锁：
    // 任何“失败后自己删锁”都会踩 SPEC §13 的 check-then-delete 竞态（可能删掉别人的锁）。
    events.append({
      type: 'task.claim_rejected',
      taskId,
      slotId,
      data: { reason: claim.reason, detail: claim.detail ?? null, pid: process.pid },
    });
    warn(`claim 被拒：${claim.reason}${claim.detail ? `（${claim.detail}）` : ''}`);
    return EXIT_NO_CLAIM;
  }

  const task = claim.task;
  const attempt = task.attempts;
  const startedAt = task.startedAt || new Date().toISOString();
  events.append({
    type: 'task.claim',
    taskId,
    slotId,
    data: { attempt, maxAttempts: task.maxAttempts, pid: process.pid, flowRunId },
  });
  log(`[worker] claim 成功 task=${taskId} slot=${slotId ?? '-'} attempt=${attempt}/${task.maxAttempts} pid=${process.pid}`);

  // ── 2. execute ──────────────────────────────────────────────────────────
  const prompt = buildPrompt({ flowRunId, task, slotId, attempt });
  const remainingAttempts = Math.max(0, (task.maxAttempts || 1) - attempt);
  let adapter;
  let result;
  try {
    adapter = createModel(flow.model, { runDir, taskId, attempt });
    events.append({
      type: 'task.step',
      taskId,
      slotId,
      data: {
        step: 'execute',
        phase: 'start',
        attempt,
        provider: adapter.provider,
        model: adapter.id,
        promptChars: prompt.length,
      },
    });
    result = await adapter.complete(prompt, { attempt, slotId, taskId, runDir });
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'WORKER_EXECUTE_FAILED';
    const message = String((error && error.message) || error);
    const endedAt = new Date().toISOString();
    releaseClaim(runDir, taskId);
    setTaskStatus(runDir, taskId, {
      status: 'failed',
      exitCode: EXIT_TASK_FAILED,
      endedAt,
      error: `${code}: ${message}`.slice(0, 500),
    });
    events.append({
      type: 'task.failed',
      taskId,
      slotId,
      data: {
        step: 'execute',
        attempt,
        code,
        errorClass: (error && error.name) || 'Error',
        message: message.slice(0, 300),
        startedAt,
        endedAt,
        remainingAttempts,
        pid: process.pid,
      },
    });
    warn(`[worker] execute 失败 task=${taskId} attempt=${attempt} code=${code}：${message}`);
    return EXIT_TASK_FAILED;
  }

  // ── 3. artifact + 4. verify ─────────────────────────────────────────────
  const endedAt = new Date().toISOString();
  const verify = runAcceptance(task.acceptance);
  const artifactRel = join('artifacts', `${taskId}.json`);
  const artifact = {
    flowRunId,
    taskId,
    attempt,
    slot: slotId,
    model: adapter.id,
    provider: adapter.provider,
    text: result.text,
    usage: result.usage,
    latencyMs: result.latencyMs,
    startedAt,
    endedAt,
    prompt,
    promptDigest: result.digest ?? null,
    verify,
    exitCode: EXIT_OK,
  };
  const artifactBytes = atomicWriteJson(join(runDir, artifactRel), artifact);
  events.append({
    type: 'task.artifact',
    taskId,
    slotId,
    data: { path: artifactRel, bytes: artifactBytes, latencyMs: result.latencyMs, attempt },
  });
  events.append({
    type: 'task.step',
    taskId,
    slotId,
    data: {
      step: 'verify',
      total: verify.total,
      passed: verify.passed,
      failed: verify.failed,
      results: verify.results.map((r) => ({
        assertion: r.assertion.slice(0, 80),
        expected: r.expected,
        result: r.result,
      })),
    },
  });

  // ── 5. done ─────────────────────────────────────────────────────────────
  setTaskStatus(runDir, taskId, {
    status: 'done',
    exitCode: EXIT_OK,
    artifact: artifactRel,
    endedAt,
    error: null,
  });
  events.append({
    type: 'task.done',
    taskId,
    slotId,
    data: {
      attempt,
      artifact: artifactRel,
      latencyMs: result.latencyMs,
      verifyPassed: verify.passed,
      verifyFailed: verify.failed,
      startedAt,
      endedAt,
      pid: process.pid,
    },
  });
  releaseClaim(runDir, taskId);
  log(
    `[worker] done task=${taskId} attempt=${attempt} artifact=${artifactRel} ` +
      `verify=${verify.passed}PASS/${verify.failed}FAIL latencyMs=${result.latencyMs}`,
  );
  return EXIT_OK;
}

process.exitCode = await run(process.argv.slice(2)).catch((error) => {
  warn(`worker 内部异常：${(error && error.stack) || error}`);
  return EXIT_TASK_FAILED;
});
