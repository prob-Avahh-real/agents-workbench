// ============================================================================
// flow/model.mjs — v0.2 模型适配层（pilot）
//   接口契约见 flow/SPEC.md §7。只用 Node 内置模块，零第三方依赖。
//   provider=mock（默认）：完全离线、确定性输出、按 latencyMs 真实等待；
//   provider=openai-compatible：只做配置解析，本版本不内置传输层（保持离线）。
//   本文件不引入任何传输层模块，也不发起外部请求。
// ============================================================================
import { createHash } from 'node:crypto';

export const PROVIDERS = Object.freeze(['mock', 'openai-compatible']);

/** 配置错误（缺 key / provider 非法等）：不可重试，调用方以配置错误语义处理。 */
export class ModelConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelConfigError';
    this.code = code;
  }
}

/** 执行期失败（含 mock 故障注入）：可重试。 */
export class ModelExecError extends Error {
  constructor(code, message, meta = null) {
    super(message);
    this.name = 'ModelExecError';
    this.code = code;
    this.meta = meta;
  }
}

function digest(input, size = 16) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, size);
}

function readEnv(name) {
  const raw = name ? process.env[name] : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function sleep(ms) {
  return ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve();
}

/** latencyMs 归一化为 [min,max]，缺省 [0,0]；非数组/负数一律按契约降级。 */
function toRange(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [0, 0];
  const min = Math.max(0, Number(raw[0]) || 0);
  const max = Math.max(min, Number(raw[1] !== undefined ? raw[1] : raw[0]) || 0);
  return [min, max];
}

/** 把 model 配置归一化；provider 缺省为 mock（SPEC §7）。 */
export function resolveModelConfig(modelCfg) {
  const model = modelCfg && typeof modelCfg === 'object' ? modelCfg : {};
  const provider = String(model.provider ?? 'mock').trim() || 'mock';
  if (!PROVIDERS.includes(provider)) {
    throw new ModelConfigError(
      'MODEL_PROVIDER_UNKNOWN',
      `不支持的 model.provider：${provider}（可选 ${PROVIDERS.join(' / ')}）`,
    );
  }
  return {
    provider,
    id: String(model.id ?? 'mock-flow-v1'),
    baseUrl: String(model.baseUrl ?? ''),
    apiKeyEnv: String(model.apiKeyEnv ?? 'WORKBENCH_MODEL_API_KEY').trim() || 'WORKBENCH_MODEL_API_KEY',
    latencyMs: toRange(model.latencyMs),
    failFirst: model.failFirst && typeof model.failFirst === 'object' ? { ...model.failFirst } : {},
    note: typeof model.note === 'string' ? model.note : '',
  };
}

/**
 * 创建模型 adapter。
 * @param {object} modelCfg flow.model 配置对象
 * @param {{runDir?:string|null, taskId?:string|null, attempt?:number}} [ctx]
 * @returns {{provider:string, id:string, describe:Function, complete:Function}}
 */
export function createModel(modelCfg, { runDir = null, taskId = null, attempt = 1 } = {}) {
  const cfg = resolveModelConfig(modelCfg);
  const ctx = {
    runDir: runDir == null ? null : String(runDir),
    taskId: taskId == null ? null : String(taskId),
    attempt: Number(attempt) || 1,
  };
  if (cfg.provider === 'mock') return createMockAdapter(cfg, ctx);
  return createOpenAiCompatibleAdapter(cfg, ctx);
}

/** 由哈希决定的确定性等待时长：同一 taskId+attempt+prompt 永远得到同一 ms。 */
function latencyFor([min, max], hex) {
  const span = max - min;
  if (span <= 0) return min;
  return min + (Number.parseInt(hex.slice(0, 8), 16) % (span + 1));
}

/**
 * mock adapter：零外部请求、输出确定性（对 taskId+attempt+prompt 哈希）。
 * 耗时取自 cfg.latencyMs，用 await sleep() 真实等待，便于观察并发。
 */
export function createMockAdapter(cfg, ctx = {}) {
  const taskId = ctx.taskId == null ? '(unknown-task)' : String(ctx.taskId);
  const info = {
    provider: 'mock',
    id: cfg.id,
    transport: 'none',
    offline: true,
    latencyMs: [...cfg.latencyMs],
    failFirst: { ...cfg.failFirst },
  };
  let calls = 0;

  return {
    provider: cfg.provider,
    id: cfg.id,
    transport: 'none',
    offline: true,
    describe: () => ({ ...info, taskId }),
    async complete(prompt, opts = {}) {
      calls += 1;
      const attemptNo = Number(opts.attempt ?? ctx.attempt ?? 1) || 1;
      const text = String(prompt ?? '');
      // 确定性种子：taskId + attempt + prompt（契约冻结）
      const seed = `${taskId}\u0000${attemptNo}\u0000${text}`;
      const promptDigest = digest(seed, 16);
      const plannedMs = latencyFor(cfg.latencyMs, promptDigest);
      const started = Date.now();
      await sleep(plannedMs);

      // 故障注入：model.failFirst = {"T-005": 1} → 该任务前 1 次尝试失败
      const injected = Number(cfg.failFirst[taskId]);
      if (Number.isFinite(injected) && injected > 0 && attemptNo <= injected) {
        throw new ModelExecError(
          'MOCK_INJECTED_FAILURE',
          `mock 故障注入：task=${taskId} 第 ${attemptNo} 次尝试失败（model.failFirst[${taskId}]=${injected}）`,
          { taskId, attempt: attemptNo, latencyMs: Date.now() - started },
        );
      }

      const body = [
        `[${cfg.id}] mock 确定性输出（provider=mock，完全离线，无外部请求）`,
        `task=${taskId} attempt=${attemptNo} seed-digest=${promptDigest}`,
        `prompt-chars=${text.length} prompt-head=${text.split('\n')[0] || ''}`,
        '四段流转：claim 领取 → execute 执行（本步）→ artifact 产物 → verify 验收',
      ].join('\n');
      const latencyMs = Date.now() - started;
      return {
        text: body,
        usage: {
          calls,
          promptChars: text.length,
          completionChars: body.length,
          totalChars: text.length + body.length,
        },
        latencyMs,
        digest: promptDigest,
        model: cfg.id,
        provider: cfg.provider,
        attempt: attemptNo,
      };
    },
  };
}

/**
 * openai-compatible adapter：只解析配置层。
 * 缺 key 抛 ModelConfigError('MODEL_API_KEY_MISSING')；
 * complete() 抛 ModelConfigError('MODEL_TRANSPORT_NOT_BUNDLED')（本版本不内置传输层）。
 * 绝不打印 key 本身。
 */
export function createOpenAiCompatibleAdapter(cfg, ctx = {}) {
  const apiKey = readEnv(cfg.apiKeyEnv);
  if (!apiKey) {
    throw new ModelConfigError(
      'MODEL_API_KEY_MISSING',
      `provider=openai-compatible 需要环境变量 ${cfg.apiKeyEnv} 提供 API key，当前未设置或为空。` +
        `请先 export ${cfg.apiKeyEnv}=... 再重试；离线自测请保持 provider=mock。`,
    );
  }
  const info = {
    provider: cfg.provider,
    id: cfg.id,
    baseUrl: cfg.baseUrl || '(未配置 baseUrl)',
    apiKeyEnv: cfg.apiKeyEnv,
    apiKeyLoaded: true,
    apiKeyLength: apiKey.length,
    transport: 'external-not-bundled',
    offline: false,
    taskId: ctx.taskId,
  };
  return {
    provider: cfg.provider,
    id: cfg.id,
    transport: 'external-not-bundled',
    offline: false,
    describe: () => ({ ...info }),
    complete() {
      throw new ModelConfigError(
        'MODEL_TRANSPORT_NOT_BUNDLED',
        `已从 ${cfg.apiKeyEnv} 读取到 API key（长度 ${apiKey.length}），但本版本不内置外部传输层；` +
          `离线自测请保持 provider=mock。`,
      );
    },
  };
}
