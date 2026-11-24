// ============================================================================
// flow/tui.mjs — 终端实时看板（v0.2 编排层，SPEC §10）
//
//   renderDashboard(state, events, { width, height })  -> string（可含 ANSI）
//   startDashboard({ runDir, intervalMs, out })        -> { stop() }
//
//   * 全屏刷新：标题（flowId/状态/运行时长）、slot 行、任务表（状态 + attempts）、
//     进度条、最近事件、并发峰值。
//   * 纪律：**非 TTY 或未显式开启颜色时不输出任何 ANSI 控制序列**，
//     自动降级为逐行文本快照（管道 / 重定向 / CI 安全）。
//   * 零第三方依赖，只用 node 内置模块。
// ============================================================================
import { readEvents, formatEvent } from './events.mjs';
import { readState, summarize } from './store.mjs';

export const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const STATUS_STYLE = {
  pending: { mark: '[ ]', color: 'gray' },
  running: { mark: '[>]', color: 'cyan' },
  done: { mark: '[x]', color: 'green' },
  failed: { mark: '[!]', color: 'red' },
  retrying: { mark: '[~]', color: 'yellow' },
  skipped: { mark: '[-]', color: 'gray' },
};

// ---------------------------------------------------------------------------
// 显示宽度（CJK 宽字符按 2 列计），保证表格在中文标题下也不歪
// ---------------------------------------------------------------------------

/** 单个码点的终端列宽：0（控制/组合）、2（宽字符）、1（其余）。 */
export function charWidth(cp) {
  if (!Number.isFinite(cp) || cp < 0) return 1;
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的终端显示宽度。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) width += charWidth(ch.codePointAt(0));
  return width;
}

/** 按显示宽度截断（不补空格），必要时加省略号。 */
export function truncateToWidth(text, width) {
  const raw = String(text ?? '');
  if (width <= 0) return '';
  if (displayWidth(raw) <= width) return raw;
  const ellipsis = width >= 2 ? '..' : '.';
  const budget = width - displayWidth(ellipsis);
  let out = '';
  let used = 0;
  for (const ch of raw) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}${ellipsis}`;
}

/** 按显示宽度右侧补空格。 */
export function padToWidth(text, width) {
  const clipped = truncateToWidth(text, width);
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function elapsedMs(state, now) {
  const started = Date.parse(state?.startedAt || '');
  if (!Number.isFinite(started)) return null;
  const ended = state?.endedAt ? Date.parse(state.endedAt) : now;
  if (!Number.isFinite(ended)) return now - started;
  return Math.max(0, ended - started);
}

function progressBar(ratio, width = 24) {
  const safeWidth = Math.max(6, Math.floor(width));
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(clamped * safeWidth);
  return `${'#'.repeat(filled)}${'-'.repeat(safeWidth - filled)}`;
}

/**
 * 从事件流还原**实测并发峰值**（同时最多有几个 worker 在跑）。
 * 键优先用 taskId（同一任务不可能同时有两个 worker，天然去重 spawn/claim），
 * 缺 taskId 时退化为 slotId / 事件序号。若事件里显式带 data.maxConcurrent 则取更大值。
 */
export function computeMaxConcurrent(state, events = []) {
  const active = new Set();
  let peak = 0;
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const key =
      event.taskId != null
        ? `t:${event.taskId}`
        : event.slotId != null
          ? `s:${event.slotId}`
          : `q:${event.seq ?? active.size}`;
    switch (event.type) {
      case 'worker.spawn':
      case 'task.claim':
        active.add(key);
        if (active.size > peak) peak = active.size;
        break;
      case 'worker.exit':
      case 'task.done':
      case 'task.failed':
      case 'task.blocked':
      case 'task.retry':
      case 'task.claim_rejected':
        active.delete(key);
        break;
      default:
        break;
    }
    if (event.data && typeof event.data.maxConcurrent === 'number') {
      peak = Math.max(peak, event.data.maxConcurrent);
    }
  }
  if (state && state.tasks) {
    const running = Object.values(state.tasks).filter((task) => task.status === 'running').length;
    peak = Math.max(peak, running);
  }
  return peak;
}

/** 当前 slot -> 正在跑的任务（按 state.tasks 里的 slotId 反查）。 */
export function slotOccupancy(state) {
  const size = Math.max(1, Number(state?.agentSlots) || 1);
  const slots = Array.from({ length: size }, (_, index) => ({ slotId: index + 1, task: null }));
  for (const task of Object.values(state?.tasks || {})) {
    if (task.status !== 'running' || task.slotId == null) continue;
    const entry = slots.find((item) => item.slotId === Number(task.slotId));
    if (entry) entry.task = task;
  }
  return slots;
}

/**
 * 渲染一屏看板。默认输出**纯文本**；color:true 时才带 ANSI（供 TTY 全屏刷新用）。
 * @param {object} state state.json 内容
 * @param {object[]} events 事件数组（通常取最近 N 条）
 * @param {{width?:number,height?:number,color?:boolean,maxConcurrent?:number,now?:number,eventLimit?:number}} [opts]
 * @returns {string}
 */
export function renderDashboard(state, events = [], opts = {}) {
  const width = Math.max(48, Math.floor(Number(opts.width) || 100));
  const height = Math.max(10, Math.floor(Number(opts.height) || 30));
  const color = Boolean(opts.color);
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const list = Array.isArray(events) ? events : [];

  const safeState = state && typeof state === 'object' ? state : {};
  const tasks = Object.values(safeState.tasks || {});
  const stats = summarize({ ...safeState, tasks: safeState.tasks || {} });
  const peak = Math.max(Number(opts.maxConcurrent) || 0, computeMaxConcurrent(safeState, list));
  const elapsed = elapsedMs(safeState, now);
  const doneRatio = stats.total > 0 ? (stats.done + stats.failed + stats.skipped) / stats.total : 0;

  const rows = [];
  const push = (text, colorKey) => rows.push({ text, colorKey });

  // ---- 标题区 -------------------------------------------------------------
  push(`agents-workbench v0.2 · flow 并发看板`, 'bold');
  push(`flow ${safeState.flowId ?? '-'}   run ${safeState.flowRunId ?? '-'}`, 'dim');
  push(
    `状态 ${safeState.status ?? '-'}   运行时长 ${formatDuration(elapsed)}   并发上限 ${safeState.agentSlots ?? '-'}   并发峰值 ${peak}`,
    'cyan',
  );
  const pct = stats.total > 0 ? Math.round(doneRatio * 100) : 0;
  push(`进度 [${progressBar(doneRatio, 24)}] ${stats.terminal}/${stats.total} (${pct}%)`);
  push(
    `统计 done ${stats.done} / running ${stats.running} / pending ${stats.pending} / retrying ${stats.retrying} / failed ${stats.failed} / skipped ${stats.skipped}` +
      (stats.injected ? ` / injected ${stats.injected}` : ''),
    'dim',
  );
  push('');

  // ---- slot 区 ------------------------------------------------------------
  push(`Slots（并发上限 ${safeState.agentSlots ?? '-'}）`, 'bold');
  for (const slot of slotOccupancy(safeState)) {
    const label = `  slot ${String(slot.slotId).padStart(2, '0')}`;
    if (!slot.task) {
      push(`${label}   . idle`, 'gray');
      continue;
    }
    const task = slot.task;
    const running = task.startedAt ? now - Date.parse(task.startedAt) : null;
    const attempt = `a${task.attempts}/${task.maxAttempts}`;
    push(
      `${label}   * ${String(task.id).padEnd(6)} ${padToWidth(task.title || '', 28)} ${padToWidth(task.role || '-', 10)} running ${attempt} ${formatDuration(running)}`,
      'cyan',
    );
  }
  push('');

  // ---- 任务表 -------------------------------------------------------------
  push(`Tasks（${tasks.length}）`, 'bold');
  push(
    `  ${padToWidth('id', 7)}${padToWidth('st', 4)}${padToWidth('attempts', 9)}${padToWidth('dur', 8)}${padToWidth('role', 10)}title`,
    'dim',
  );
  const sorted = tasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const task of sorted) {
    const style = STATUS_STYLE[task.status] || { mark: '[?]', color: null };
    const duration =
      task.durationMs != null
        ? formatDuration(task.durationMs)
        : task.status === 'running' && task.startedAt
          ? formatDuration(now - Date.parse(task.startedAt))
          : '-';
    const attempts = `a${task.attempts}/${task.maxAttempts}`;
    const flags = [task.injected ? 'inj' : null, task.exitCode != null ? `exit ${task.exitCode}` : null]
      .filter(Boolean)
      .join(' ');
    push(
      `  ${padToWidth(String(task.id), 7)}${padToWidth(style.mark, 4)}${padToWidth(attempts, 9)}${padToWidth(duration, 8)}${padToWidth(
        task.role || '-',
        10,
      )}${truncateToWidth(task.title || '', Math.max(8, width - 46))}${flags ? `  ${flags}` : ''}`,
      style.color,
    );
  }
  push('');

  // ---- 最近事件（新 -> 旧，截断时丢的永远是更旧的行）------------------------
  const eventLimit = Math.max(1, Math.min(Number(opts.eventLimit) || 8, 50));
  const recent = list.slice(-eventLimit).reverse();
  push(`最近事件（新 → 旧，显示 ${recent.length}/${list.length}）`, 'bold');
  if (!recent.length) {
    push('  (暂无事件)', 'gray');
  } else {
    for (const event of recent) push(`  ${truncateToWidth(formatEvent(event), width - 2)}`, 'dim');
  }

  // ---- 组装 / 裁剪（先按显示宽度裁剪，再加 ANSI，保证宽度精确且不切断转义序列）----
  const clipped = rows.map((row) => ({ text: truncateToWidth(row.text, width), colorKey: row.colorKey }));
  const styled = clipped.map((row) => colorize(row.text, row.colorKey, color));
  if (styled.length > height) {
    const note = colorize(`  ... 已截断 ${styled.length - height + 1} 行（终端高度 ${height}）`, 'dim', color);
    return [...styled.slice(0, height - 1), note].join('\n');
  }
  return styled.join('\n');
}

function colorize(text, colorKey, enabled) {
  if (!enabled || !colorKey) return text;
  const code = ANSI[colorKey];
  if (!code) return text;
  return `${code}${text}${ANSI.reset}`;
}

/**
 * 非 TTY 降级时用来判断"内容是否真的变了"的指纹：
 * 忽略时间字段，避免每秒把整屏快照重打一遍。
 */
function frameSignature(state, events) {
  if (!state) return 'null';
  const tasks = Object.values(state.tasks || {})
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((task) => `${task.id}:${task.status}:${task.attempts}:${task.slotId ?? ''}`)
    .join('|');
  const last = events.length ? events[events.length - 1] : null;
  const tail = last ? `${last.seq ?? ''}:${last.type}:${last.taskId ?? ''}` : '';
  return `${state.status}|${state.agentSlots}|${state.endedAt ?? ''}|${tasks}|${tail}`;
}

/**
 * 定时刷新看板。
 * @param {{runDir?: string|(()=>string|null), intervalMs?: number, out?: NodeJS.WritableStream,
 *          color?: boolean, autoStop?: boolean, eventLimit?: number}} [opts]
 *   runDir 支持传函数：`up` 场景下 runDir 要等 orchestrator 建好才知道。
 * @returns {{stop: () => void, tick: () => void, isTty: boolean}}
 */
export function startDashboard(opts = {}) {
  const out = opts.out || process.stdout;
  const isTty = Boolean(out && out.isTTY);
  const ansi = opts.color !== undefined ? Boolean(opts.color) : isTty;
  const intervalMs = Math.max(50, Math.floor(Number(opts.intervalMs) || (ansi ? 500 : 1000)));
  const resolveDir = typeof opts.runDir === 'function' ? opts.runDir : () => opts.runDir || null;
  const autoStop = opts.autoStop !== false;
  const eventLimit = Number(opts.eventLimit) || 40;

  let timer = null;
  let stopped = false;
  let lastFrame = '';
  let lastSignature = null;
  let lastPrintAt = 0;
  let terminalTicks = 0;
  let printedOnce = false;
  const heartbeatMs = Math.max(5000, intervalMs * 5);

  const write = (text) => {
    if (out && typeof out.write === 'function' && !stopped) out.write(text);
  };

  function collect() {
    const dir = resolveDir();
    if (!dir) return { dir: null, state: null, events: [] };
    let state = null;
    let events = [];
    try {
      state = readState(dir);
    } catch {
      state = null;
    }
    try {
      events = readEvents(dir, { limit: eventLimit });
    } catch {
      events = [];
    }
    return { dir, state, events };
  }

  function tick() {
    if (stopped) return;
    const { dir, state, events } = collect();
    const width = ansi && out.columns ? out.columns : 100;
    const height = ansi && out.rows ? out.rows : 30;

    let frame;
    if (!state) {
      frame = dir ? `(等待 flow 状态：${dir})` : '(等待 flow 运行目录创建...)';
    } else {
      frame = renderDashboard(state, events, { width, height, color: ansi, eventLimit: ansi ? 8 : 40 });
    }

    if (ansi) {
      // 全屏刷新：清屏 + 光标归位
      write(`\u001b[2J\u001b[H${frame}\n`);
      lastFrame = frame;
    } else {
      // 非 TTY：逐行文本快照，绝不输出控制序列；只在内容变化（或心跳）时打印
      const signature = frameSignature(state, events);
      const heartbeatDue = Date.now() - lastPrintAt >= heartbeatMs;
      if (signature !== lastSignature || heartbeatDue) {
        write(`${printedOnce ? '\n' : ''}${frame}\n`);
        lastSignature = signature;
        lastPrintAt = Date.now();
        printedOnce = true;
        lastFrame = frame;
      }
    }

    if (autoStop && state && TERMINAL_STATUSES.has(state.status)) {
      terminalTicks += 1;
      if (terminalTicks >= 2) stop();
    } else {
      terminalTicks = 0;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (ansi) {
      // 恢复光标 + 收尾换行
      if (out && typeof out.write === 'function') out.write(`${ANSI.reset}\u001b[?25h\n`);
    }
  }

  if (ansi) write('\u001b[?25l'); // 隐藏光标，避免闪烁
  tick();
  if (!stopped) {
    timer = setInterval(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return { stop, tick, isTty };
}
