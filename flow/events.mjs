// ============================================================================
// flow/events.mjs — 事件流（v0.2 编排层）
//   追加式 JSONL：一行一事件，多进程并发追加（单行 < 4096B，依赖 O_APPEND 原子性）
//   接口见 flow/SPEC.md §3。只用 Node 内置模块，零依赖。
// ============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 允许的事件类型（冻结，见 SPEC §3）。 */
export const EVENT_TYPES = new Set([
  'flow.start',
  'flow.end',
  'flow.pause',
  'flow.resume',
  'flow.cancel',
  'flow.abort',
  'task.ready',
  'task.claim',
  'task.claim_rejected',
  'task.step',
  'task.artifact',
  'task.done',
  'task.failed',
  'task.retry',
  'task.blocked',
  'worker.spawn',
  'worker.exit',
]);

const MAX_LINE_BYTES = 4096;

/**
 * 创建一个追加式事件 writer。
 * 注意：seq 是**进程内**自增，不保证跨进程全局唯一；真实顺序以文件追加顺序为准。
 */
export function createEventWriter(runDir) {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, 'events.jsonl');
  let seq = 0;
  if (existsSync(path)) {
    // 续接已有文件的计数，便于人眼看日志时不至于从 1 重新开始
    try {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.seq === 'number' && parsed.seq > seq) seq = parsed.seq;
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 文件不可读则从 0 开始 */
    }
  }

  return {
    path,
    /**
     * @param {{type:string, taskId?:string|null, slotId?:number|null, data?:object}} event
     * @returns {object} 实际落盘的事件
     */
    append(event) {
      const type = String(event && event.type || '');
      if (!EVENT_TYPES.has(type)) {
        throw new Error(`未知事件类型：${type}（见 flow/SPEC.md §3）`);
      }
      const record = {
        ts: new Date().toISOString(),
        seq: ++seq,
        pid: process.pid,
        type,
        taskId: event.taskId ?? null,
        slotId: event.slotId ?? null,
        data: event.data ?? {},
      };
      let line = `${JSON.stringify(record)}\n`;
      if (line.length > MAX_LINE_BYTES) {
        // 保住单行原子性：把过大的 data 折叠成摘要
        record.data = { truncated: true, bytes: line.length, keys: Object.keys(record.data || {}).slice(0, 12) };
        line = `${JSON.stringify(record)}\n`;
      }
      appendFileSync(path, line);
      return record;
    },
  };
}

/**
 * 读取事件流，按文件顺序编号（行序即真相顺序）。
 * @param {string} runDir
 * @param {{limit?:number, type?:string, taskId?:string}} [opts]
 */
export function readEvents(runDir, opts = {}) {
  const path = join(runDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  let events = [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let index = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      index += 1;
      events.push({ ...parsed, line: index });
    } catch {
      /* 坏行跳过 */
    }
  }
  if (opts.type) events = events.filter((e) => e.type === opts.type);
  if (opts.taskId) events = events.filter((e) => e.taskId === opts.taskId);
  if (typeof opts.limit === 'number' && opts.limit >= 0) events = events.slice(-opts.limit);
  return events;
}

const TYPE_LABEL = {
  'flow.start': 'flow 启动',
  'flow.end': 'flow 结束',
  'flow.pause': '已暂停调度',
  'flow.resume': '已恢复调度',
  'flow.cancel': '已取消',
  'flow.abort': '异常中止',
  'task.ready': '任务就绪',
  'task.claim': '认领成功',
  'task.claim_rejected': '认领被拒',
  'task.step': '步骤',
  'task.artifact': '产物落盘',
  'task.done': '任务完成',
  'task.failed': '任务失败',
  'task.retry': '重试排期',
  'task.blocked': '依赖失败跳过',
  'worker.spawn': 'worker 启动',
  'worker.exit': 'worker 退出',
};

/** 一行人类可读的事件描述。 */
export function formatEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const time = String(event.ts || '').slice(11, 23);
  const slot = event.slotId === null || event.slotId === undefined ? '  ' : String(event.slotId).padStart(2, '0');
  const task = (event.taskId || '-').padEnd(6);
  const label = TYPE_LABEL[event.type] || event.type;
  const detail = event.data && Object.keys(event.data).length ? ` ${JSON.stringify(event.data)}` : '';
  return `[${time}] slot=${slot} ${task} ${label}${detail}`;
}
