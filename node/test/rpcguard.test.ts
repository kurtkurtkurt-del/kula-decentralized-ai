// The rpc guard (rpcguard.ts): legitimate rpc traffic passes byte for byte (HELLO's caps
// zeroed), a graph with a code op, an unknown command or a first message that is not HELLO is
// cut; its numbers are checked against the llama.cpp source the phone build fetched, when it is
// there; and the gate with rpcGuard closes such a connection before the target sees the graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { RpcGuard, RpcRefused, graphProblem, RPC_CMD, RPC_TENSOR_BYTES, RPC_TENSOR_OP_AT, RPC_CAPS_BYTES, GGML_OP_COUNT, GGML_CUSTOM_OPS } from '../src/rpcguard.ts';
import { startGateServer, Tunnel, type GateEvent } from '../src/gate.ts';

const msg = (cmd: number, body: Buffer = Buffer.alloc(0)): Buffer => {
  const h = Buffer.alloc(9);
  h[0] = cmd;
  h.writeBigUInt64LE(BigInt(body.length), 1);
  return Buffer.concat([h, body]);
};
const hello = (caps: Buffer = Buffer.alloc(RPC_CAPS_BYTES, 7)) => msg(RPC_CMD.HELLO, caps);
const graph = (ops: number[], nodes = ops.length): Buffer => {
  const b = Buffer.alloc(8 + nodes * 8 + 4 + ops.length * RPC_TENSOR_BYTES);
  b.writeUInt32LE(0, 0);
  b.writeUInt32LE(nodes, 4);
  for (let i = 0; i < nodes; i++) b.writeBigUInt64LE(BigInt(i + 1), 8 + i * 8);
  const at = 8 + nodes * 8;
  b.writeUInt32LE(ops.length, at);
  ops.forEach((op, i) => {
    b.writeBigUInt64LE(BigInt(i + 1), at + 4 + i * RPC_TENSOR_BYTES);
    b.writeUInt32LE(op, at + 4 + i * RPC_TENSOR_BYTES + RPC_TENSOR_OP_AT);
  });
  return msg(RPC_CMD.GRAPH_COMPUTE, b);
};

// feeds `input` in pieces of `step` bytes; resolves with what came out, or the refusal
function run(input: Buffer, step: number): Promise<{ out: Buffer; err: Error | null; why: string | null }> {
  return new Promise((resolve) => {
    let why: string | null = null;
    const g = new RpcGuard((w) => { why = w; });
    const parts: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null) => { if (!settled) { settled = true; resolve({ out: Buffer.concat(parts), err, why }); } };
    g.on('data', (d: Buffer) => parts.push(d));
    g.on('error', (e) => done(e));
    g.on('end', () => done(null));
    for (let i = 0; i < input.length && !g.destroyed; i += step) g.write(input.subarray(i, i + step));
    g.end();
  });
}

test('legitimate traffic passes unchanged, only HELLO caps zeroed, at any chunk size', async () => {
  const big = randomBytes(300_000);
  const input = Buffer.concat([hello(), msg(15), msg(6, big), graph([0, 1, 26, 91, 96, 100]), msg(16, Buffer.alloc(4)), msg(17, Buffer.alloc(40))]);
  const want = Buffer.from(input);
  want.fill(0, 9, 9 + RPC_CAPS_BYTES);
  for (const step of [1, 3, 9, 296, 4096, input.length]) {
    const r = await run(input, step);
    assert.equal(r.err, null, `step ${step}: ${r.err?.message}`);
    assert.ok(r.out.equals(want), `step ${step}: output differs`);
  }
});

test('a graph with a custom op or an op past the enum is cut', async () => {
  for (const op of [...GGML_CUSTOM_OPS, GGML_OP_COUNT, 0xffffffff]) {
    for (const step of [1, 1000, 1 << 20]) {
      const r = await run(Buffer.concat([hello(), graph([1, 2, op, 3])]), step);
      assert.ok(r.err instanceof RpcRefused, `op ${op} step ${step} passed`);
      assert.match(r.why ?? '', new RegExp(`op ${op}`));
      // nothing of the graph went out: only the HELLO (9 + 24 bytes)
      assert.ok(r.out.length <= 9 + RPC_CAPS_BYTES, `op ${op}: ${r.out.length} bytes went out`);
    }
  }
});

test('the first message must be HELLO of the proto 7 size; unknown commands are cut', async () => {
  assert.ok((await run(msg(15), 4)).err instanceof RpcRefused);
  assert.ok((await run(msg(RPC_CMD.HELLO, Buffer.alloc(16)), 4)).err instanceof RpcRefused);
  assert.ok((await run(Buffer.concat([hello(), msg(18)]), 4)).err instanceof RpcRefused); // RPC_CMD_NONE
  assert.ok((await run(Buffer.concat([hello(), msg(200)]), 4)).err instanceof RpcRefused);
  const tooBig = Buffer.alloc(9); tooBig[0] = RPC_CMD.GRAPH_COMPUTE; tooBig.writeBigUInt64LE(1n << 40n, 1);
  assert.ok((await run(Buffer.concat([hello(), tooBig]), 4)).err instanceof RpcRefused);
});

test('graphProblem reads a graph the way the server does', () => {
  const body = (b: Buffer) => b.subarray(9);
  assert.equal(graphProblem(body(graph([1, 2, 3]))), null);
  assert.match(graphProblem(body(graph([1, 95]))) ?? '', /op 95/);
  // declares more tensors than it carries: refused like the server refuses it
  const short = body(graph([1, 2]));
  assert.match(graphProblem(short.subarray(0, short.length - 10)) ?? '', /short/);
  assert.match(graphProblem(Buffer.alloc(4)) ?? '', /short/);
});

// The numbers against the source (b11157) the phone build fetched, when it is in this checkout.
const SRC = fileURLToPath(new URL('../../app/modules/kula-llama/android/src/main/cpp/llama.cpp/ggml/', import.meta.url));
const haveSrc = fs.existsSync(`${SRC}src/ggml-rpc/ggml-rpc.cpp`);
const enumNames = (text: string, head: RegExp): string[] => {
  const start = text.search(head);
  const body = text.slice(text.indexOf('{', start) + 1, text.indexOf('}', start));
  return body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).map((l) => l.replace(/[=,].*$/, '').trim()).filter(Boolean);
};
test('the guard\'s numbers match llama.cpp\'s source', { skip: haveSrc ? false : 'llama.cpp source not fetched here' }, () => {
  const rpc = fs.readFileSync(`${SRC}src/ggml-rpc/ggml-rpc.cpp`, 'utf8');
  const cmds = enumNames(rpc, /enum rpc_cmd \{/);
  assert.equal(cmds.indexOf('RPC_CMD_GRAPH_COMPUTE'), RPC_CMD.GRAPH_COMPUTE);
  assert.equal(cmds.indexOf('RPC_CMD_HELLO'), RPC_CMD.HELLO);
  assert.equal(cmds.indexOf('RPC_CMD_NONE'), RPC_CMD.LAST + 1);
  const ops = enumNames(fs.readFileSync(`${SRC}include/ggml.h`, 'utf8'), /enum ggml_op \{/);
  assert.equal(ops.indexOf('GGML_OP_COUNT'), GGML_OP_COUNT);
  assert.deepEqual(['GGML_OP_MAP_CUSTOM1', 'GGML_OP_MAP_CUSTOM2', 'GGML_OP_MAP_CUSTOM3', 'GGML_OP_CUSTOM'].map((n) => ops.indexOf(n)), GGML_CUSTOM_OPS);
  assert.match(fs.readFileSync(`${SRC}src/ggml-rpc/transport.h`, 'utf8'), new RegExp(`RPC_CONN_CAPS_SIZE = ${RPC_CAPS_BYTES};`));
  // the struct's fields in order (296 bytes, op at 52, as compiled against ggml.h)
  const t = rpc.slice(rpc.indexOf('struct rpc_tensor {'), rpc.indexOf('};', rpc.indexOf('struct rpc_tensor {')));
  const fields = t.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(fields, ['uint64_t id;', 'uint32_t type;', 'uint64_t buffer;', 'uint32_t ne[GGML_MAX_DIMS];', 'uint32_t nb[GGML_MAX_DIMS];', 'uint32_t op;', 'int32_t  op_params[GGML_MAX_OP_PARAMS / sizeof(int32_t)];', 'int32_t  flags;', 'uint64_t src[GGML_MAX_SRC];', 'uint64_t view_src;', 'uint64_t view_offs;', 'uint64_t data;', 'char name[GGML_MAX_NAME];', 'int32_t use_count;']);
  // the graph layout the server reads
  assert.match(rpc, /\| device \(4 bytes\) \| n_nodes \(4 bytes\) \| nodes \(n_nodes \* sizeof\(uint64_t\) \| n_tensors \(4 bytes\) \| tensors \(n_tensors \* sizeof\(rpc_tensor\)\) \|/);
});

test('the gate with rpcGuard: a good stream reaches the target, a code op closes it first', async () => {
  let seen = Buffer.alloc(0);
  const target = net.createServer((c) => { c.on('data', (d: Buffer) => { seen = Buffer.concat([seen, d]); }); c.on('error', () => {}); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', rpcGuard: true, targets: () => (target.address() as net.AddressInfo).port, onEvent: (e) => events.push(e) });
  const tunnel = new Tunnel('127.0.0.1', gate.port, 's', 'rpc');
  const local = await tunnel.listen();
  const send = async (data: Buffer): Promise<void> => {
    const c = net.connect(local, '127.0.0.1');
    c.on('error', () => {});
    await new Promise((r) => c.once('connect', r));
    c.write(data);
    await new Promise((r) => { c.once('close', r); setTimeout(() => { c.destroy(); r(null); }, 800); });
  };
  try {
    const good = Buffer.concat([hello(), graph([1, 2])]);
    await send(good);
    const want = Buffer.from(good); want.fill(0, 9, 9 + RPC_CAPS_BYTES);
    assert.ok(seen.equals(want), 'the good stream arrived as sent (caps zeroed)');
    seen = Buffer.alloc(0);
    await send(Buffer.concat([hello(), graph([1, 95])]));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.length <= 9 + RPC_CAPS_BYTES, `${seen.length} bytes reached the target`);
    assert.ok(events.some((e) => e.type === 'reject' && /rpc guard: op 95/.test(e.reason)), 'the refusal is an event');
  } finally {
    await tunnel.close();
    await gate.close();
    target.close();
  }
});
