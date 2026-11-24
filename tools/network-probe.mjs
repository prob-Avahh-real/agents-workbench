// ============================================================================
// tools/network-probe.mjs —— 自测脚手架（不属于 scripts/ 交付代码）
//
// 目的：为「provider=mock 时零网络请求」提供**运行时**证据，而不只是静态 grep。
//
// 方法（对应 audit 的 D5 方法学意见）：
//   1. 先打桩全部出网原语（含 net/dns/http/https/http2/tls/dgram/fetch/WebSocket）
//   2. **对照实验**：主动调用其中 3 个原语，必须被拦截 → 证明探针真的会触发（HIT>0）
//   3. 清零计数后，在同一进程里 import runner 并真实跑 board / run W-001
//      → 被验 CLI 必须 HIT=0
//
// 用法：cd active/agents-workbench && node tools/network-probe.mjs
// 退出码：0 = 对照触发且被验 CLI 零出网；1 = 否则
// ============================================================================
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';

const hits = [];

function trap(name) {
  return function trapped(...args) {
    hits.push(`${name}/${args.length}args`);
    throw new Error(`NETWORK_BLOCKED: ${name} 被运行时探针拦截`);
  };
}

// --- 1) 打桩（覆盖 17+ 个出网入口） ---
net.connect = trap('net.connect');
net.createConnection = trap('net.createConnection');
net.Socket.prototype.connect = trap('net.Socket.connect');
dns.lookup = trap('dns.lookup');
dns.resolve = trap('dns.resolve');
if (dns.promises) {
  dns.promises.lookup = trap('dns.promises.lookup');
  dns.promises.resolve = trap('dns.promises.resolve');
}
http.request = trap('http.request');
http.get = trap('http.get');
https.request = trap('https.request');
https.get = trap('https.get');
http2.connect = trap('http2.connect');
tls.connect = trap('tls.connect');
dgram.createSocket = trap('dgram.createSocket');

const originalFetch = globalThis.fetch;
globalThis.fetch = trap('fetch');
if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = class BlockedWebSocket {
    constructor() {
      hits.push('WebSocket');
      throw new Error('NETWORK_BLOCKED: WebSocket 被运行时探针拦截');
    }
  };
}

// --- 2) 对照实验：探针必须真的会拦截（否则 HIT=0 毫无意义） ---
const controlResults = [];
function control(label, fn) {
  try {
    fn();
    controlResults.push(`${label}=NOT-TRAPPED`);
  } catch {
    controlResults.push(`${label}=TRAPPED`);
  }
}
control('net.connect', () => net.connect({ port: 1 }));
control('dns.lookup', () => dns.lookup('probe.invalid', () => {}));
control('fetch', () => {
  globalThis.fetch('http://probe.invalid/');
});
const controlHits = hits.length;
hits.length = 0;

// --- 3) 被验对象：同一进程内驱动真实 runner ---
const { main } = await import('../scripts/workbench.mjs');
const boardCode = await main(['board']);
const runCode = await main(['run', 'W-001']);
const runnerHits = hits.length;

console.log('--- network-probe ---');
console.log(`对照实验 control: ${controlResults.join(', ')}  HIT=${controlHits}`);
console.log(`被验 CLI board      exitCode=${boardCode}  HIT=${runnerHits}`);
console.log(`被验 CLI run W-001  exitCode=${runCode}  HIT=${runnerHits}`);
console.log(`被验累计出网尝试 runnerHits=${runnerHits}${runnerHits ? ` -> ${hits.join(', ')}` : ''}`);
console.log(`fetch(原始) 已被替换=${globalThis.fetch !== originalFetch}`);
console.log('说明: verify 的契约探针会 spawn 子进程（子进程未被本探针覆盖）；该路径由 scripts/ 静态扫描（零出网原语）兜底。');

const controlTriggered = controlHits >= 3 && controlResults.every((r) => r.endsWith('TRAPPED'));
const pass = controlTriggered && runnerHits === 0 && boardCode === 0 && runCode === 0;
console.log(
  pass
    ? 'PROBE PASS: 对照实验证明探针可拦截（HIT>=3），被验 CLI 零出网（HIT=0）'
    : 'PROBE FAIL: 对照未触发或被验 CLI 出现了出网尝试',
);
process.exitCode = pass ? 0 : 1;
