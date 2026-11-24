// ============================================================================
// agents-workbench / 模型层
//   - provider 注册表：mock（默认，离线）与 openai-compatible（仅配置解析）
//   - 只用 Node 内置模块，零第三方依赖，无构建步骤
//   - provider=mock 时完全离线：确定性输出、不发起任何外部请求、无需 API key
// 详见 TEAM.md 第 6 节「运行契约」与 workbench.config.json 的 model 字段。
// ============================================================================
import { createHash } from 'node:crypto';

export const PROVIDERS = Object.freeze(['mock', 'openai-compatible']);

/** 模型层配置错误：带稳定的 code，便于 verify 断言与人工排查。 */
export class ModelConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelConfigError';
    this.code = code;
  }
}

function digest(input, size = 12) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, size);
}

function readEnv(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 解析 workbench.config.json 的 model 字段。
 * options.providerOverride 允许 CLI 用 --provider=mock 临时覆盖（不落盘、不改配置）。
 */
export function resolveModelConfig(config, options = {}) {
  const model = config ? config.model : null;
  if (!model || typeof model !== 'object') {
    throw new ModelConfigError('MODEL_CONFIG_INVALID', 'workbench.config.json 缺少 model 对象');
  }
  const provider = String(options.providerOverride || model.provider || '').trim();
  if (!provider) {
    throw new ModelConfigError(
      'MODEL_PROVIDER_MISSING',
      `model.provider 为空；期望 ${PROVIDERS.join(' / ')}`,
    );
  }
  return {
    provider,
    id: String(model.id || '(unnamed)'),
    baseUrl: String(model.baseUrl || ''),
    apiKeyEnv: String(model.apiKeyEnv || 'WORKBENCH_MODEL_API_KEY').trim(),
    note: typeof model.note === 'string' ? model.note : '',
  };
}

/** 只读描述（不创建 adapter、不校验 key）：给 board 用。 */
export function describeModel(config, options = {}) {
  const cfg = resolveModelConfig(config, options);
  if (cfg.provider === 'mock') {
    return { ...cfg, transport: 'none', offline: true, ready: true, problem: null };
  }
  if (cfg.provider === 'openai-compatible') {
    const key = readEnv(cfg.apiKeyEnv);
    return {
      ...cfg,
      transport: 'external-not-bundled',
      offline: false,
      ready: key.length > 0,
      problem: key.length > 0 ? null : `环境变量 ${cfg.apiKeyEnv} 未设置或为空`,
    };
  }
  return {
    ...cfg,
    transport: 'unknown',
    offline: false,
    ready: false,
    problem: `不支持的 provider：${cfg.provider}（可选 ${PROVIDERS.join(' / ')}）`,
  };
}

/**
 * 创建模型 adapter。接口：complete(prompt, opts) -> { text, usage }
 * 配置不合法（未知 provider / 缺少 API key）时抛 ModelConfigError → 调用方以非 0 退出码收尾。
 */
export function createModel(config, options = {}) {
  const cfg = resolveModelConfig(config, options);
  if (cfg.provider === 'mock') return createMockAdapter(cfg);
  if (cfg.provider === 'openai-compatible') return createOpenAiCompatibleAdapter(cfg);
  throw new ModelConfigError(
    'MODEL_PROVIDER_UNKNOWN',
    `不支持的 model.provider：${cfg.provider}（可选 ${PROVIDERS.join(' / ')}）`,
  );
}

/**
 * mock adapter：确定性（同一 prompt 永远产出同一 text）、离线、无副作用。
 * 输出固定体现「领取 → 执行 → 产物 → 验收」四段流转。
 */
export function createMockAdapter(cfg) {
  let calls = 0;
  const info = { provider: cfg.provider, id: cfg.id, transport: 'none', offline: true };
  return {
    ...info,
    describe: () => ({ ...info }),
    complete(prompt) {
      calls += 1;
      const text = [
        `[${cfg.id}] 离线确定性输出 —— 四段流转：`,
        '1. 领取 claim    —— 读取任务文件、校验 blockedBy 是否全部 done，登记 owner 与写入范围',
        '2. 执行 execute  —— provider=mock，不发起任何外部请求，按 prompt 生成确定性执行方案',
        '3. 产物 artifact —— 落盘 runs/run-<timestamp>-<taskId>.json 与同名 .log',
        '4. 验收 verify   —— 逐条跑 acceptance 断言，输出 PASS / FAIL / SKIP',
        `prompt-digest: ${digest(prompt, 16)}`,
        `prompt-head: ${String(prompt).split('\n')[0]}`,
      ].join('\n');
      return {
        text,
        digest: digest(prompt, 16),
        usage: { calls, promptChars: String(prompt).length, completionChars: text.length },
        model: cfg.id,
        provider: cfg.provider,
        transport: 'none',
        offline: true,
      };
    },
  };
}

/**
 * openai-compatible adapter 的配置层：从 apiKeyEnv 指定的环境变量读取 key（绝不落盘、绝不打印 key 本身）。
 * 本离线构建（runtime.requireNoNetwork=true）不内置外部传输层，因此 complete() 明确报错而不是偷偷发请求。
 */
export function createOpenAiCompatibleAdapter(cfg) {
  const apiKey = readEnv(cfg.apiKeyEnv);
  if (!apiKey) {
    throw new ModelConfigError(
      'MODEL_API_KEY_MISSING',
      `provider=openai-compatible 需要环境变量 ${cfg.apiKeyEnv} 提供 API key，当前未设置或为空。` +
        `请先 export ${cfg.apiKeyEnv}=... 再重试；离线自测请保持 provider=mock。`,
    );
  }
  const baseUrl = cfg.baseUrl && cfg.baseUrl !== 'about:mock://local' ? cfg.baseUrl : '(未配置 baseUrl)';
  const info = {
    provider: cfg.provider,
    id: cfg.id,
    baseUrl,
    apiKeyEnv: cfg.apiKeyEnv,
    apiKeyLoaded: true,
    apiKeyLength: apiKey.length,
    transport: 'external-not-bundled',
    offline: false,
  };
  return {
    ...info,
    describe: () => ({ ...info }),
    complete() {
      throw new ModelConfigError(
        'MODEL_TRANSPORT_NOT_BUNDLED',
        `已从 ${cfg.apiKeyEnv} 读取到 API key（长度 ${apiKey.length}），但本离线构建不内置外部传输层` +
          `（runtime.requireNoNetwork=true）。接真实模型时请在 scripts/model/ 下实现传输层，并保持 mock 为默认。`,
      );
    },
  };
}
