#!/usr/bin/env node
// ============================================================================
// flow/cli.mjs — v0.2 编排层命令行入口（SPEC §9）
//
//   node flow/cli.mjs up       --flow flows/demo.flow.json [--agents 4] [--no-tui] [--json]
//   node flow/cli.mjs status   [--run <dir|latest>] [--json]
//   node flow/cli.mjs logs     [--run <dir|latest>] [--task <id>] [--follow]
//   node flow/cli.mjs add      --run <dir> --task '<json>'
//   node flow/cli.mjs stop     --run <dir> [--mode cancel|pause]
//   node flow/cli.mjs resume   --run <dir>
//   node flow/cli.mjs validate --flow <path>
//   node flow/cli.mjs demo     [--agents 4]
//
//   退出码：0 成功 / 1 flow 失败或有 failed 任务 / 2 用法错误 / 3 模型配置错误
//
//   零第三方依赖：参数解析、日志跟随、看板全部自己写。
// ============================================================================
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEvent, readEvents } from './events.mjs';
import { injectTask, latestRunDir, readControl, readInjected, readState, summarize, writeControl } from './store.mjs';
import { computeMaxConcurrent, formatDuration, padToWidth, startDashboard, truncateToWidth } from './tui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH_DIR = resolve(HERE, '..');
const FLOWS_DIR = resolve(WORKBENCH_DIR, 'flows');
const DEFAULT_FLOW = join(FLOWS_DIR, 'demo.flow.json');
const VERSION = '0.2.0';

// stdout 被下游关闭（如 `| head`）时不因 EPIPE 直接退出——否则会丢下正在跑的 worker。
// 只吞掉 EPIPE，其他错误照旧抛出。
function swallowPipeError(error) {
  if (!error || error.code !== 'EPIPE') throw error;
}
process.stdout.on('error', swallowPipeError);
process.stderr.on('error', swallowPipeError);

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, MODEL: 3 };
const BOOLEAN_FLAGS = new Set(['help', 'version', 'json', 'no-tui', 'follow', 'strict']);
const FOLLOW_IDLE_MS = 1500;
const FOLLOW_POLL_MS = 300;

// ---------------------------------------------------------------------------
// 错误类型 -> 退出码
// ---------------------------------------------------------------------------
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.USAGE;
  }
}
class FlowError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.FAIL;
  }
}
class RunError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.FAIL;
  }
}
class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.MODEL;
    this.code = 'MODEL_CONFIG';
  }
}
/** 环境未就绪（如 orchestrator.mjs 尚未实现）——按用法/环境错误报 2。 */
class NotReadyError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.USAGE;
  }
}

function isModelConfigError(error) {
  if (!error) return false;
  if (error instanceof ModelConfigError) return true;
  const code = String(error.code ?? '');
  return /^MODEL_/.test(code);
}

// ---------------------------------------------------------------------------
// 自己写的参数解析：支持 --k v / --k=v / -h，布尔开关取自 BOOLEAN_FLAGS
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (!BOOLEAN_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1];
        i += 1;
      }
      flags[key] = value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg === '-h' ? 'help' : arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (i + 1 < argv.length) {
        flags[key] = argv[i + 1];
        i += 1;
      } else flags[key] = true;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function requireFlags(flags, allowed, command) {
  const unknown = Object.keys(flags).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new UsageError(
      `未知参数：${unknown.map((key) => `--${key}`).join(', ')}（${command} 支持：${allowed.map((a) => `--${a}`).join(' ')}）`,
    );
  }
}

function parsePositiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${label} 必须是 >=1 的整数，收到：${raw}`);
  return value;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function shortPath(path) {
  if (!path) return '-';
  const prefix = `${WORKBENCH_DIR}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// ---------------------------------------------------------------------------
// flow 装载与校验（validate / up 共用）
// ---------------------------------------------------------------------------
function resolveFlowPath(input) {
  const raw = String(input);
  const candidates = isAbsolute(raw)
    ? [raw]
    : [resolve(process.cwd(), raw), resolve(FLOWS_DIR, raw), resolve(WORKBENCH_DIR, raw)];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* 忽略，继续尝试下一个候选路径 */
    }
  }
  return candidates[0];
}

function loadFlow(flowPath) {
  if (!existsSync(flowPath)) throw new UsageError(`flow 文件不存在：${flowPath}`);
  let raw;
  try {
    raw = readFileSync(flowPath, 'utf8');
  } catch (error) {
    throw new RunError(`无法读取 flow 文件：${error.message}`);
  }
  let flow;
  try {
    flow = JSON.parse(raw);
  } catch (error) {
    throw new FlowError(`flow 文件不是合法 JSON：${error.message}`);
  }
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) throw new FlowError('flow 根节点必须是 JSON 对象');
  return flow;
}

/** 依赖环检测；有环返回环上节点序列，否则 null。 */
function findCycle(ids) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const need of ids.get(id)?.needs || []) {
      if (!ids.has(need)) continue;
      const mark = state.get(need) || 0;
      if (mark === 1) return [...stack.slice(stack.indexOf(need)), need];
      if (mark === 0) {
        const found = visit(need);
        if (found) return found;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  };
  for (const id of ids.keys()) {
    if ((state.get(id) || 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** 依赖图统计：最长链深度、分层、菱形依赖个数。 */
function analyzeGraph(ids) {
  const children = new Map();
  for (const id of ids.keys()) children.set(id, []);
  for (const task of ids.values()) {
    for (const need of task.needs || []) {
      if (ids.has(need)) children.get(need).push(task.id);
    }
  }
  const levelMemo = new Map();
  const level = (id) => {
    if (levelMemo.has(id)) return levelMemo.get(id);
    levelMemo.set(id, 1); // 防御环
    let depth = 1;
    for (const need of ids.get(id)?.needs || []) {
      if (ids.has(need)) depth = Math.max(depth, level(need) + 1);
    }
    levelMemo.set(id, depth);
    return depth;
  };
  const levels = new Map();
  let depth = 0;
  for (const id of ids.keys()) {
    const value = level(id);
    depth = Math.max(depth, value);
    if (!levels.has(value)) levels.set(value, []);
    levels.get(value).push(id);
  }

  const descendants = (id) => {
    const seen = new Set();
    const queue = [...(children.get(id) || [])];
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of children.get(current) || []) queue.push(next);
    }
    return seen;
  };

  let diamonds = 0;
  for (const id of ids.keys()) {
    const kids = children.get(id) || [];
    if (kids.length < 2) continue;
    const sets = kids.map((kid) => descendants(kid));
    let hit = false;
    for (let i = 0; i < sets.length && !hit; i += 1) {
      for (let j = i + 1; j < sets.length && !hit; j += 1) {
        for (const node of sets[i]) {
          if (sets[j].has(node)) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) diamonds += 1;
  }

  return { depth, layers: [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, list]) => ({ level: lvl, tasks: list.sort() })), diamonds };
}

/**
 * flow 定义检查。
 * @returns {{errors:string[], modelErrors:string[], warnings:string[], stats:object}}
 */
export function inspectFlow(flow) {
  const errors = [];
  const modelErrors = [];
  const warnings = [];
  const empty = { tasks: 0, depth: 0, layers: [], diamonds: 0, expectedFails: [] };

  if (typeof flow.id !== 'string' || !flow.id.trim()) errors.push('flow.id 必须是非空字符串');
  if (flow.agents != null && (!Number.isInteger(flow.agents) || flow.agents < 1)) errors.push('flow.agents 必须是 >=1 的整数');
  if (flow.tasks != null && !Array.isArray(flow.tasks)) {
    errors.push('flow.tasks 必须是数组');
    return { errors, modelErrors, warnings, stats: empty };
  }
  if (!Array.isArray(flow.tasks) || flow.tasks.length === 0) {
    errors.push('flow.tasks 必须是非空数组');
    return { errors, modelErrors, warnings, stats: empty };
  }

  const ids = new Map();
  flow.tasks.forEach((task, index) => {
    const where = `tasks[${index}]${task && task.id ? ` (${task.id})` : ''}`;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (typeof task.id !== 'string' || !task.id.trim()) errors.push(`${where}.id 必须是非空字符串`);
    else if (ids.has(task.id)) errors.push(`任务 id 重复：${task.id}`);
    else ids.set(task.id, task);
    if (task.title != null && typeof task.title !== 'string') errors.push(`${where}.title 必须是字符串`);
    if (task.needs != null && !Array.isArray(task.needs)) errors.push(`${where}.needs 必须是字符串数组`);
    if (task.acceptance != null && !Array.isArray(task.acceptance)) errors.push(`${where}.acceptance 必须是字符串数组`);
    if (task.maxAttempts != null && (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1)) {
      errors.push(`${where}.maxAttempts 必须是 >=1 的整数`);
    }
  });

  for (const task of ids.values()) {
    for (const need of task.needs || []) {
      if (typeof need !== 'string') {
        errors.push(`任务 ${task.id} 的 needs 含非字符串项`);
        continue;
      }
      if (need === task.id) errors.push(`任务 ${task.id} 依赖自身`);
      else if (!ids.has(need)) errors.push(`任务 ${task.id} 依赖不存在的任务 ${need}`);
    }
    for (const assertion of task.acceptance || []) {
      if (typeof assertion !== 'string' || !assertion.trim()) errors.push(`任务 ${task.id} 的 acceptance 含空/非字符串断言`);
    }
  }

  const cycle = findCycle(ids);
  if (cycle) errors.push(`依赖存在环：${cycle.join(' -> ')}`);

  const graph = analyzeGraph(ids);
  const expectedFails = [...ids.values()]
    .filter((task) => (task.acceptance || []).some((a) => typeof a === 'string' && a.trim().endsWith('!')))
    .map((task) => task.id);

  if (!flow.model || typeof flow.model !== 'object') {
    modelErrors.push('flow.model 缺失（SPEC §8 要求）');
  } else {
    const provider = flow.model.provider ?? 'mock';
    if (!['mock', 'openai-compatible'].includes(provider)) modelErrors.push(`未知 model.provider：${provider}`);
    if (provider === 'openai-compatible') {
      const env = flow.model.apiKeyEnv;
      if (!env) modelErrors.push('provider=openai-compatible 时必须声明 model.apiKeyEnv');
      else if (!process.env[env]) modelErrors.push(`模型密钥缺失：环境变量 ${env} 未设置`);
    }
    if (flow.model.latencyMs != null) {
      const l = flow.model.latencyMs;
      const ok = Array.isArray(l) && l.length === 2 && l.every((v) => Number.isFinite(v) && v >= 0) && l[0] <= l[1];
      if (!ok) modelErrors.push('model.latencyMs 必须是 [min,max] 且 0 <= min <= max');
    }
  }

  // demo 形态要求：validate 只报警告，--strict 时按失败处理
  if (ids.size < 8) warnings.push(`任务数 ${ids.size} < 8（demo flow 要求 >=8）`);
  if (graph.depth < 3) warnings.push(`依赖深度 ${graph.depth} < 3（demo flow 要求 >=3 层）`);
  if (graph.diamonds === 0) warnings.push('未发现菱形依赖（demo flow 要求至少一个：两条并行分支汇合到同一下游任务）');
  if (!expectedFails.length) warnings.push('没有以 `!` 结尾的期望失败断言（demo flow 要求至少一条）');

  return {
    errors,
    modelErrors,
    warnings,
    stats: { tasks: ids.size, depth: graph.depth, layers: graph.layers, diamonds: graph.diamonds, expectedFails },
  };
}

// ---------------------------------------------------------------------------
// run 目录定位
// ---------------------------------------------------------------------------
function defaultBaseDir() {
  return resolve(WORKBENCH_DIR, 'runs');
}

function listFlowDirs(baseDir) {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir)
    .filter((name) => name.startsWith('flow-'))
    .map((name) => join(baseDir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function resolveRunDirArg(value, baseFlag) {
  const baseDir = baseFlag ? resolve(String(baseFlag)) : defaultBaseDir();
  if (value === undefined || value === true || value === 'latest') {
    const latest = latestRunDir(baseDir) || (listFlowDirs(baseDir).slice(-1)[0] ?? null);
    if (!latest) throw new RunError(`未找到 flow 运行目录：${baseDir} 下没有 flow-*（先跑 \`node flow/cli.mjs up\`）`);
    return latest;
  }
  const raw = String(value);
  const candidates = isAbsolute(raw) ? [raw] : [resolve(process.cwd(), raw), resolve(baseDir, raw)];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 继续 */
    }
  }
  throw new RunError(`run 目录不存在：${raw}`);
}

// ---------------------------------------------------------------------------
// 运行中事件流（--no-tui 行式日志 / logs --follow 共用）
// ---------------------------------------------------------------------------
function startLineLog(getRunDir, out) {
  let runDir = null;
  let printed = 0;
  let closed = false;

  const flush = () => {
    if (!runDir) {
      runDir = getRunDir();
      if (!runDir) return;
      out.write(`[cli] run dir: ${runDir}\n`);
    }
    let events;
    try {
      events = readEvents(runDir);
    } catch {
      return;
    }
    if (events.length > printed) {
      for (const event of events.slice(printed)) out.write(`${formatEvent(event)}\n`);
      printed = events.length;
    }
  };

  const timer = setInterval(flush, 300);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    close() {
      if (closed) return;
      clearInterval(timer);
      flush();
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// 报告打印
// ---------------------------------------------------------------------------
function statusExitCode(state) {
  const stats = summarize(state);
  if (stats.failed > 0) return EXIT.FAIL;
  if (state.status === 'failed' || state.status === 'cancelled') return EXIT.FAIL;
  return EXIT.OK;
}

function formatRunReport({ runDir, state, events, maxConcurrent, title }) {
  const stats = summarize(state);
  const peak = Math.max(Number(maxConcurrent) || 0, computeMaxConcurrent(state, events));
  const ended = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  const elapsed = state.startedAt ? ended - Date.parse(state.startedAt) : null;
  const lines = [
    title || '=== flow 状态 ===',
    `run dir        : ${runDir}`,
    `flow           : ${state.flowId} (${state.flowRunId})`,
    `status         : ${state.status}`,
    `运行时长       : ${formatDuration(elapsed)}`,
    `agents/峰值    : ${state.agentSlots} / ${peak}   <- 实测同时最多 ${peak} 个 worker 在跑`,
    `任务           : total ${stats.total} / done ${stats.done} / running ${stats.running} / pending ${stats.pending} / retrying ${stats.retrying} / failed ${stats.failed} / skipped ${stats.skipped}${stats.injected ? ` / injected ${stats.injected}` : ''}`,
    '',
    `  ${padToWidth('id', 7)} ${padToWidth('status', 9)} ${padToWidth('attempts', 9)} ${padToWidth('dur', 8)} ${padToWidth('role', 10)} title`,
  ];
  for (const task of Object.values(state.tasks).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    lines.push(
      `  ${padToWidth(String(task.id), 7)} ${padToWidth(task.status, 9)} ${padToWidth(`a${task.attempts}/${task.maxAttempts}`, 9)} ${padToWidth(
        formatDuration(task.durationMs),
        8,
      )} ${padToWidth(task.role || '-', 10)} ${truncateToWidth(task.title || '', 44)}${task.injected ? '  [injected]' : ''}${
        task.error ? `  err=${truncateToWidth(String(task.error), 40)}` : ''
      }`,
    );
  }
  return lines.join('\n');
}

function readArtifact(runDir, taskId, attempt) {
  const candidates = [`${taskId}.json`, attempt != null ? `${taskId}.a${attempt}.json` : null].filter(Boolean);
  for (const name of candidates) {
    const path = join(runDir, 'artifacts', name);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* 坏产物忽略 */
    }
  }
  return null;
}

function assertionResults(artifact) {
  if (!artifact) return null;
  for (const key of ['acceptance', 'assertions', 'checks', 'verify', 'verification']) {
    const value = artifact[key];
    const list = Array.isArray(value) ? value : value && Array.isArray(value.results) ? value.results : null;
    if (!list) continue;
    return list.map((item) => {
      if (typeof item === 'string') return { text: item, result: 'UNKNOWN' };
      if (item && typeof item === 'object') {
        const text = item.text ?? item.assertion ?? item.name ?? JSON.stringify(item);
        const result = String(item.result ?? item.status ?? item.outcome ?? 'UNKNOWN').toUpperCase();
        return { text: String(text), result };
      }
      return { text: String(item), result: 'UNKNOWN' };
    });
  }
  return null;
}

/** demo 的并发证据：maxConcurrent / 加速比 / 重试 / 期望失败断言。 */
function demoEvidenceLines({ runDir, state, events, result }) {
  const tasks = Object.values(state.tasks || {});
  const peak = Math.max(Number(result?.maxConcurrent) || 0, computeMaxConcurrent(state, events));
  const slots = Number(state.agentSlots) || 1;
  const wall = state.startedAt ? (state.endedAt ? Date.parse(state.endedAt) : Date.now()) - Date.parse(state.startedAt) : null;
  const serialSum = tasks.reduce((sum, task) => sum + (Number(task.durationMs) || 0), 0);
  const speedup = wall && wall > 0 ? serialSum / wall : 0;
  const retries = tasks.filter((task) => task.attempts > 1 || task.status === 'retrying');
  const retryEvents = events.filter((event) => event.type === 'task.retry');
  const expected = tasks.filter((task) => (task.acceptance || []).some((a) => String(a).trim().endsWith('!')));

  const lines = [
    '',
    '=== 并发证据 ===',
    `任务数                 : ${tasks.length}`,
    `agents（并发上限）     : ${slots}`,
    `maxConcurrent（实测）  : ${peak}${peak >= slots ? '   <- 跑满并发上限' : ''}`,
    `wall time              : ${formatDuration(wall)}`,
    `串行耗时上界（Σ任务）  : ${formatDuration(serialSum)}`,
    `并发理论下界（Σ/slots）: ${formatDuration(serialSum / slots)}`,
    `实测加速比             : ${speedup ? `${speedup.toFixed(2)}x` : '-'}`,
    `重试演示               : ${
      retries.length
        ? `${retries.map((task) => `${task.id} a${task.attempts}/${task.maxAttempts}`).join(', ')}（task.retry 事件 ${retryEvents.length} 条）`
        : '无（本 flow 未触发重试）'
    }`,
    `期望失败断言           : ${expected.length ? expected.map((task) => task.id).join(', ') : '无'}`,
  ];

  for (const task of expected) {
    for (const assertion of task.acceptance.filter((a) => String(a).trim().endsWith('!'))) {
      lines.push(`  - ${task.id} ${task.status}: ${assertion}`);
    }
    const artifact = readArtifact(runDir, task.id, task.attempts);
    const checks = assertionResults(artifact);
    if (checks) {
      for (const check of checks) lines.push(`    · [${check.result}] ${truncateToWidth(check.text, 70)}`);
    } else if (artifact === null) {
      lines.push(`    · 产物未找到（artifacts/${task.id}.json），逐条结果见 logs/${task.id}.log 与 task.step 事件`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function cmdValidate(flags) {
  requireFlags(flags, ['flow', 'json', 'strict', 'help'], 'validate');
  if (!flags.flow || flags.flow === true) throw new UsageError('validate 需要 --flow <path>');
  const flowPath = resolveFlowPath(flags.flow);
  const flow = loadFlow(flowPath);
  const { errors, modelErrors, warnings, stats } = inspectFlow(flow);
  const strictFail = flags.strict === true && warnings.length > 0;
  const exitCode = errors.length ? EXIT.FAIL : modelErrors.length ? EXIT.MODEL : strictFail ? EXIT.FAIL : EXIT.OK;

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ flowPath, flowId: flow.id, errors, modelErrors, warnings, stats, ok: exitCode === EXIT.OK }, null, 2)}\n`);
    return exitCode;
  }

  const lines = [
    `validate        : ${shortPath(flowPath)}`,
    `flow            : ${flow.id ?? '-'} — ${flow.name ?? ''}`,
    `任务            : ${stats.tasks}`,
    `依赖            : 深度 ${stats.depth} 层，分层 ${stats.layers.map((layer) => `L${layer.level}:${layer.tasks.length}`).join(' ')}`,
    `菱形依赖        : ${stats.diamonds}`,
    `期望失败断言    : ${stats.expectedFails.length ? `${stats.expectedFails.length} 条（${stats.expectedFails.join(', ')}）` : '0'}`,
    `model           : ${flow.model?.provider ?? '-'} (${flow.model?.id ?? '-'}) latencyMs=${JSON.stringify(flow.model?.latencyMs ?? null)} failFirst=${JSON.stringify(flow.model?.failFirst ?? {})}`,
  ];
  if (warnings.length) {
    lines.push('警告            :');
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  if (modelErrors.length) {
    lines.push('模型配置错误    :');
    for (const error of modelErrors) lines.push(`  - ${error}`);
  }
  if (errors.length) {
    lines.push('错误            :');
    for (const error of errors) lines.push(`  - ${error}`);
  }
  lines.push(`结论            : ${exitCode === EXIT.OK ? `OK${warnings.length ? '（有警告）' : ''}` : exitCode === EXIT.MODEL ? 'FAIL（模型配置）' : 'FAIL'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return exitCode;
}

function cmdStatus(flags) {
  requireFlags(flags, ['run', 'json', 'base', 'help'], 'status');
  const runDir = resolveRunDirArg(flags.run, flags.base);
  const state = readState(runDir);
  const events = readEvents(runDir);
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        { runDir, state, summary: summarize(state), maxConcurrent: computeMaxConcurrent(state, events) },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatRunReport({ runDir, state, events, title: '=== flow 状态 ===' })}\n`);
    const control = readControl(runDir);
    if (control) process.stdout.write(`待处理控制指令  : ${control.command}（${control.at}）\n`);
    process.stdout.write(`提示            : logs --run ${shortPath(runDir)} --task <id>  查看单个任务日志\n`);
  }
  return statusExitCode(state);
}

async function cmdLogs(flags) {
  requireFlags(flags, ['run', 'task', 'follow', 'base', 'help'], 'logs');
  const runDir = resolveRunDirArg(flags.run, flags.base);

  if (flags.task && flags.task !== true) {
    const taskId = String(flags.task);
    const state = readState(runDir);
    if (!state.tasks[taskId]) throw new RunError(`任务不存在：${taskId}`);
    const logPath = join(runDir, 'logs', `${taskId}.log`);
    if (!existsSync(logPath)) {
      process.stdout.write(`(任务 ${taskId} 尚无日志：${shortPath(logPath)}；状态 ${state.tasks[taskId].status})\n`);
      return EXIT.OK;
    }
    process.stdout.write(readFileSync(logPath, 'utf8'));
    if (flags.follow !== true) return EXIT.OK;
    return followFile(logPath, runDir);
  }

  const events = readEvents(runDir);
  const state = readState(runDir);
  process.stdout.write(`run dir : ${runDir}\n`);
  const logDir = join(runDir, 'logs');
  const logFiles = existsSync(logDir) ? readdirSync(logDir).sort() : [];
  process.stdout.write(`任务日志 : ${logFiles.length ? logFiles.join(', ') : '(暂无)'}\n`);
  process.stdout.write(`事件     : ${events.length} 条（下为最近 50 条）\n`);
  for (const event of events.slice(-50)) process.stdout.write(`${formatEvent(event)}\n`);
  if (flags.follow !== true) return EXIT.OK;
  process.stdout.write(`--- following（flow 结束且 1.5s 无新事件后自动退出，Ctrl-C 亦可）---\n`);
  return followEvents(runDir, events.length, state);
}

async function followFile(logPath, runDir) {
  let printed = readFileSync(logPath, 'utf8').length;
  let idleSince = Date.now();
  const onSigint = () => {
    process.stdout.write('\n');
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', onSigint);
  try {
    for (;;) {
      await sleep(FOLLOW_POLL_MS);
      let content = '';
      try {
        content = readFileSync(logPath, 'utf8');
      } catch {
        continue;
      }
      if (content.length > printed) {
        process.stdout.write(content.slice(printed));
        printed = content.length;
        idleSince = Date.now();
        continue;
      }
      if (Date.now() - idleSince < FOLLOW_IDLE_MS) continue;
      let terminal = true;
      try {
        terminal = ['done', 'failed', 'cancelled'].includes(readState(runDir).status);
      } catch {
        terminal = true;
      }
      if (terminal) return EXIT.OK;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

async function followEvents(runDir, printed, state) {
  let count = printed;
  let lastState = state;
  let idleSince = Date.now();
  const onSigint = () => {
    process.stdout.write('\n');
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', onSigint);
  try {
    for (;;) {
      await sleep(FOLLOW_POLL_MS);
      let events = [];
      try {
        events = readEvents(runDir);
      } catch {
        events = [];
      }
      if (events.length > count) {
        for (const event of events.slice(count)) process.stdout.write(`${formatEvent(event)}\n`);
        count = events.length;
        idleSince = Date.now();
      }
      try {
        lastState = readState(runDir);
      } catch {
        /* 保留上次状态 */
      }
      const terminal = ['done', 'failed', 'cancelled'].includes(lastState?.status);
      if (terminal && Date.now() - idleSince >= FOLLOW_IDLE_MS) return statusExitCode(lastState);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function cmdAdd(flags) {
  requireFlags(flags, ['run', 'task', 'base', 'json', 'help'], 'add');
  if (!flags.run || flags.run === true) throw new UsageError('add 需要 --run <dir>');
  if (!flags.task || flags.task === true) throw new UsageError(`add 需要 --task '<json>'`);

  let text = String(flags.task);
  if (text.startsWith('@')) {
    const file = resolve(text.slice(1));
    if (!existsSync(file)) throw new UsageError(`--task @<file> 文件不存在：${file}`);
    text = readFileSync(file, 'utf8');
  }
  let task;
  try {
    task = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--task 不是合法 JSON：${error.message}`);
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new UsageError('--task 必须是 JSON 对象');
  if (typeof task.id !== 'string' || !task.id.trim()) throw new UsageError('--task 必须包含非空 id');

  const runDir = resolveRunDirArg(flags.run, flags.base);
  const state = readState(runDir);
  if (state.tasks[task.id]) throw new RunError(`任务 ${task.id} 已存在（状态 ${state.tasks[task.id].status}）`);
  if (readInjected(runDir).some((item) => item && item.id === task.id)) throw new RunError(`任务 ${task.id} 已注入过`);
  if (!['running', 'paused'].includes(state.status)) {
    throw new RunError(`flow 已结束（status=${state.status}），注入的任务不会被调度；请先 \`up\``);
  }

  const record = {
    title: task.title ?? task.id,
    role: task.role ?? 'injected',
    needs: Array.isArray(task.needs) ? task.needs : [],
    acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
    ...(task.maxAttempts != null ? { maxAttempts: task.maxAttempts } : {}),
    ...(Array.isArray(task.steps) ? { steps: task.steps } : {}),
    id: task.id,
  };
  injectTask(runDir, record);

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ runDir, injected: record, path: join(runDir, 'injected.jsonl') }, null, 2)}\n`);
  } else {
    process.stdout.write(`已注入任务 ${record.id} -> ${shortPath(join(runDir, 'injected.jsonl'))}\n`);
    process.stdout.write(`  title=${record.title} role=${record.role} needs=[${record.needs.join(',')}] acceptance=${record.acceptance.length} 条\n`);
    process.stdout.write(`调度器将在下一个 tick 并入 state（injected=true）并尝试认领。\n`);
  }
  return EXIT.OK;
}

function cmdStop(flags) {
  requireFlags(flags, ['run', 'mode', 'base', 'help'], 'stop');
  if (!flags.run || flags.run === true) throw new UsageError('stop 需要 --run <dir>');
  const mode = flags.mode === undefined || flags.mode === true ? 'cancel' : String(flags.mode);
  if (!['cancel', 'pause'].includes(mode)) throw new UsageError(`--mode 只支持 cancel|pause，收到：${mode}`);
  const runDir = resolveRunDirArg(flags.run, flags.base);
  const state = readState(runDir);
  if (['done', 'failed', 'cancelled'].includes(state.status)) {
    process.stdout.write(`flow 已结束（status=${state.status}），stop 指令不会生效。\n`);
    return EXIT.OK;
  }
  writeControl(runDir, mode);
  process.stdout.write(`已写入控制指令 ${mode} -> ${shortPath(join(runDir, 'control.json'))}\n`);
  process.stdout.write(`  当前状态 ${state.status}；orchestrator 将在下一次调度 tick 处理${mode === 'cancel' ? '（SIGTERM 子进程，2s 后 SIGKILL）' : '（不再 spawn 新 worker，在跑的跑完）'}。\n`);
  return EXIT.OK;
}

function cmdResume(flags) {
  requireFlags(flags, ['run', 'base', 'help'], 'resume');
  if (!flags.run || flags.run === true) throw new UsageError('resume 需要 --run <dir>');
  const runDir = resolveRunDirArg(flags.run, flags.base);
  const state = readState(runDir);
  if (['done', 'failed', 'cancelled'].includes(state.status)) {
    process.stdout.write(`flow 已结束（status=${state.status}），无需 resume。\n`);
    return EXIT.OK;
  }
  writeControl(runDir, 'resume');
  process.stdout.write(`已写入控制指令 resume -> ${shortPath(join(runDir, 'control.json'))}（当前状态 ${state.status}）\n`);
  return EXIT.OK;
}

async function cmdUp(flags, opts = {}) {
  const { demo = false } = opts;
  requireFlags(flags, ['flow', 'agents', 'no-tui', 'json', 'run', 'base', 'help'], demo ? 'demo' : 'up');
  const flowPath = resolveFlowPath(flags.flow || DEFAULT_FLOW);
  const flow = loadFlow(flowPath);
  const { errors, modelErrors } = inspectFlow(flow);
  if (errors.length || modelErrors.length) {
    for (const error of errors) process.stderr.write(`[cli] flow 定义错误：${error}\n`);
    for (const error of modelErrors) process.stderr.write(`[cli] 模型配置错误：${error}\n`);
    return errors.length ? EXIT.FAIL : EXIT.MODEL;
  }

  const agents = flags.agents !== undefined && flags.agents !== true ? parsePositiveInt(flags.agents, '--agents') : undefined;
  if (flow.model?.provider === 'openai-compatible') {
    const env = flow.model.apiKeyEnv;
    if (env && !process.env[env]) throw new ModelConfigError(`模型密钥缺失：环境变量 ${env} 未设置`);
  }

  const baseDir = resolve(WORKBENCH_DIR, flow.workspace || 'runs');
  mkdirSync(baseDir, { recursive: true });
  const json = flags.json === true;
  const useTui = flags['no-tui'] !== true && !json && Boolean(process.stdout.isTTY);
  const pre = new Set(listFlowDirs(baseDir));
  let runDir = flags.run !== undefined && flags.run !== true ? resolveRunDirArg(flags.run, flags.base || baseDir) : null;
  const getRunDir = () => {
    if (!runDir) {
      const found = listFlowDirs(baseDir).filter((dir) => !pre.has(dir));
      if (found.length) runDir = found[found.length - 1];
    }
    return runDir;
  };

  if (!json) {
    process.stdout.write(
      `[cli] ${demo ? 'demo' : 'up'} flow=${shortPath(flowPath)} agents=${agents ?? flow.agents ?? 1} base=${shortPath(baseDir)} tui=${
        useTui ? 'on' : 'off'
      }\n`,
    );
  }

  let orchestrator;
  try {
    orchestrator = await import(new URL('./orchestrator.mjs', import.meta.url).href);
  } catch (error) {
    if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to resolve module/.test(String(error.message)))) {
      throw new NotReadyError(
        `flow/orchestrator.mjs 尚不可用（归 forge 实现），up/demo 暂不能跑；validate/status/logs/add/stop/resume 不受影响。原始错误：${error.message}`,
      );
    }
    throw error;
  }
  if (typeof orchestrator.runFlow !== 'function') throw new NotReadyError('flow/orchestrator.mjs 未按 SPEC §5 导出 runFlow');

  const dashboard = useTui ? startDashboard({ runDir: getRunDir, intervalMs: 400, out: process.stdout }) : null;
  const liner = !useTui && !json ? startLineLog(getRunDir, process.stdout) : null;

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    process.stderr.write('\n[cli] 收到 SIGINT → 请求 cancel（orchestrator 走取消路径，等子进程清干净）…\n');
  };
  process.on('SIGINT', onSigint);

  let result = null;
  let failure = null;
  try {
    result = await orchestrator.runFlow({ flowPath, baseDir, agents, runDir: runDir ?? null });
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (dashboard) dashboard.stop();
    if (liner) liner.close();
  }

  const finalRunDir = result?.runDir || getRunDir();
  let state = null;
  if (finalRunDir) {
    try {
      state = readState(finalRunDir);
    } catch {
      state = null;
    }
  }
  const events = finalRunDir ? readEvents(finalRunDir) : [];
  const maxConcurrent = Math.max(Number(result?.maxConcurrent) || 0, state ? computeMaxConcurrent(state, events) : 0);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          runDir: finalRunDir ?? null,
          status: state?.status ?? result?.status ?? null,
          durationMs: result?.durationMs ?? null,
          maxConcurrent,
          summary: state ? summarize(state) : result?.summary ?? null,
          tasks: state?.tasks ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } else if (state) {
    process.stdout.write(`${formatRunReport({ runDir: finalRunDir, state, events, maxConcurrent, title: '=== flow 结果 ===' })}\n`);
    if (demo) process.stdout.write(`${demoEvidenceLines({ runDir: finalRunDir, state, events, result }).join('\n')}\n`);
  } else {
    process.stdout.write(`[cli] 未能读到最终 state（runDir=${finalRunDir ?? 'null'}）\n`);
  }

  if (failure) {
    process.stderr.write(`[cli] flow 异常中止：${failure.message}\n`);
    return isModelConfigError(failure) ? EXIT.MODEL : EXIT.FAIL;
  }
  if (interrupted) return 130;
  if (!state) return EXIT.FAIL;
  return statusExitCode(state);
}

async function cmdDemo(flags) {
  return cmdUp(flags, { demo: true });
}

const COMMANDS = {
  up: cmdUp,
  status: cmdStatus,
  logs: cmdLogs,
  add: cmdAdd,
  stop: cmdStop,
  resume: cmdResume,
  validate: cmdValidate,
  demo: cmdDemo,
};

function usageText() {
  return [
    `agents-workbench flow CLI v${VERSION}（SPEC §9）`,
    '',
    '用法：',
    '  node flow/cli.mjs up       --flow flows/demo.flow.json [--agents 4] [--no-tui] [--json] [--run <dir>]',
    '  node flow/cli.mjs status   [--run <dir|latest>] [--json]',
    '  node flow/cli.mjs logs     [--run <dir|latest>] [--task <id>] [--follow]',
    "  node flow/cli.mjs add      --run <dir> --task '<json>'      # 运行中动态投任务",
    '  node flow/cli.mjs stop     --run <dir> [--mode cancel|pause]',
    '  node flow/cli.mjs resume   --run <dir>',
    '  node flow/cli.mjs validate --flow <path> [--json] [--strict]',
    '  node flow/cli.mjs demo     [--agents 4] [--no-tui] [--json]  # 跑内置 demo 并打印并发证据',
    '',
    '退出码：0 成功 / 1 flow 失败或有 failed 任务 / 2 用法错误 / 3 模型配置错误',
    'up 在 TTY 下默认起实时看板，--no-tui 打行式日志；非 TTY 自动降级（绝不输出 ANSI 控制序列）。',
  ].join('\n');
}

async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.version === true) {
    process.stdout.write(`agents-workbench flow ${VERSION}\n`);
    return EXIT.OK;
  }
  const command = positionals[0] || 'help';
  if (flags.help === true || command === 'help') {
    process.stdout.write(`${usageText()}\n`);
    return EXIT.OK;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`未知子命令：${command}`);
  return handler(flags, positionals.slice(1));
}

main(process.argv.slice(2))
  .then((code) => process.exit(Number.isInteger(code) ? code : EXIT.OK))
  .catch((error) => {
    const code = error && Number.isInteger(error.exitCode) ? error.exitCode : EXIT.FAIL;
    const label = code === EXIT.USAGE ? '用法/环境错误' : code === EXIT.MODEL ? '模型配置错误' : '错误';
    process.stderr.write(`[cli] ${label}：${error && error.message ? error.message : String(error)}\n`);
    if (code === EXIT.USAGE) process.stderr.write(`\n${usageText()}\n`);
    process.exit(code);
  });
