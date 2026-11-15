// The rpc guard (16.11.2026): what kula's phone build does inside llama.cpp
// (app/modules/kula-llama/tools/patches/kula-rpc-no-code-ops.patch), done on a computer in
// the gate, because the llama.cpp a computer downloads is not patched. ggml's custom ops
// (MAP_CUSTOM1..3, CUSTOM) keep a function pointer in op_params that the CPU backend calls,
// so a client of ggml-rpc-server could make it jump anywhere (security review 8A.1). The gate
// sits between every remote client and the server, so it reads what the client sends and
// cuts the connection before such a graph reaches the server.
//
// llama.cpp b11157, ggml/src/ggml-rpc/ggml-rpc.cpp (rpc proto 7):
//   every client message is | cmd (1 byte) | size (u64 le) | payload (size bytes) |, the first
//   one HELLO (14) with 24 bytes of connection caps (transport.h RPC_CONN_CAPS_SIZE);
//   the only command that runs ops is GRAPH_COMPUTE (10), payload
//   | device u32 | n_nodes u32 | n_nodes × u64 | n_tensors u32 | n_tensors × rpc_tensor |;
//   GRAPH_RECOMPUTE (16) runs the graph stored by the last GRAPH_COMPUTE, which passed here.
//   rpc_tensor is packed, 296 bytes, its op a u32 at byte 52 (checked by compiling the struct
//   against ggml.h: GGML_OP_MAP_CUSTOM1..3 = 92..94, GGML_OP_CUSTOM = 95, GGML_OP_COUNT = 101).
// The HELLO caps are zeroed: a transport upgrade (RDMA) would carry later bytes past the gate.
// When llama.cpp's tag changes, these numbers are checked again (test/rpcguard.test.ts).
import { Transform, type TransformCallback } from 'node:stream';

export const RPC_CMD = { GRAPH_COMPUTE: 10, HELLO: 14, LAST: 17 } as const; // LAST: MEMSET_TENSOR
export const RPC_TENSOR_BYTES = 296;
export const RPC_TENSOR_OP_AT = 52;
export const RPC_CAPS_BYTES = 24;
export const GGML_OP_COUNT = 101;
export const GGML_CUSTOM_OPS = [92, 93, 94, 95];
// a graph of a large model has some thousands of tensors (296 bytes each); far below this
export const GRAPH_MAX_BYTES = 64 * 1024 * 1024;

export class RpcRefused extends Error {}

// Why a GRAPH_COMPUTE payload is refused, or null. Read the way the server reads it: the
// tensors it declares must be there, and none may carry a code op.
export function graphProblem(p: Buffer): string | null {
  if (p.length < 8) return 'graph too short';
  const nNodes = p.readUInt32LE(4);
  const countAt = 8 + nNodes * 8;
  if (p.length < countAt + 4) return 'graph too short';
  const nTensors = p.readUInt32LE(countAt);
  const first = countAt + 4;
  if (p.length < first + nTensors * RPC_TENSOR_BYTES) return 'graph too short';
  for (let i = 0; i < nTensors; i++) {
    const op = p.readUInt32LE(first + i * RPC_TENSOR_BYTES + RPC_TENSOR_OP_AT);
    if (op >= GGML_OP_COUNT || GGML_CUSTOM_OPS.includes(op)) return `op ${op} is not allowed over rpc`;
  }
  return null;
}

// The client-to-server half of an rpc connection. Passes everything through unchanged except
// the HELLO caps (zeroed); a graph with a code op, an unknown command, or a first message
// that is not HELLO ends the stream with RpcRefused (the gate then closes both sides).
export class RpcGuard extends Transform {
  private stage: 'cmd' | 'size' | 'body' = 'cmd';
  private cmd = -1;
  private seen = 0;              // messages started
  private head = Buffer.alloc(9); // cmd + size, kept while a buffered body comes in
  private headLen = 0;
  private left = 0;              // body bytes still to come
  private hold: Buffer[] | null = null; // the body of HELLO or GRAPH_COMPUTE, checked when whole
  private holdLen = 0;

  private readonly onRefuse: ((why: string) => void) | undefined;

  constructor(onRefuse?: (why: string) => void) { super(); this.onRefuse = onRefuse; }

  private refuse(why: string, cb: TransformCallback): void {
    this.onRefuse?.(why);
    cb(new RpcRefused(why));
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.stage === 'cmd') {
        const c = chunk[i++];
        if (this.seen === 0 && c !== RPC_CMD.HELLO) return this.refuse('the first message is not HELLO', cb);
        if (c > RPC_CMD.LAST) return this.refuse(`unknown command ${c}`, cb);
        this.seen++;
        this.cmd = c;
        this.head[0] = c;
        this.headLen = 1;
        this.stage = 'size';
        continue;
      }
      if (this.stage === 'size') {
        const n = Math.min(9 - this.headLen, chunk.length - i);
        chunk.copy(this.head, this.headLen, i, i + n);
        this.headLen += n;
        i += n;
        if (this.headLen < 9) continue;
        const size = this.head.readBigUInt64LE(1);
        if (size > BigInt(Number.MAX_SAFE_INTEGER)) return this.refuse('message too large', cb);
        this.left = Number(size);
        if (this.cmd === RPC_CMD.HELLO && this.left !== RPC_CAPS_BYTES) return this.refuse('HELLO of another size (another rpc version?)', cb);
        if (this.cmd === RPC_CMD.GRAPH_COMPUTE && this.left > GRAPH_MAX_BYTES) return this.refuse('graph too large', cb);
        if (this.cmd === RPC_CMD.HELLO || this.cmd === RPC_CMD.GRAPH_COMPUTE) {
          this.hold = [];
          this.holdLen = 0;
        } else {
          this.push(Buffer.from(this.head));
        }
        this.stage = 'body';
        if (this.left === 0) {
          const bad = this.finishBody();
          if (bad) return this.refuse(bad, cb);
        }
        continue;
      }
      // body
      const n = Math.min(this.left, chunk.length - i);
      const part = chunk.subarray(i, i + n);
      i += n;
      this.left -= n;
      if (this.hold) { this.hold.push(Buffer.from(part)); this.holdLen += n; } else this.push(part);
      if (this.left === 0) {
        const bad = this.finishBody();
        if (bad) return this.refuse(bad, cb);
      }
    }
    cb();
  }

  // a whole body: a held one is checked and sent with its header; then the next command
  private finishBody(): string | null {
    if (this.hold) {
      const body = Buffer.concat(this.hold, this.holdLen);
      this.hold = null;
      this.holdLen = 0;
      if (this.cmd === RPC_CMD.HELLO) body.fill(0);
      if (this.cmd === RPC_CMD.GRAPH_COMPUTE) {
        const bad = graphProblem(body);
        if (bad) return bad;
      }
      this.push(Buffer.concat([this.head, body]));
    }
    this.stage = 'cmd';
    return null;
  }
}
