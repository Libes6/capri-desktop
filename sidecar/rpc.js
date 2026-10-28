'use strict';

// JSON-RPC 2.0 between the Rust shell and this sidecar, one JSON object per line over stdin/stdout.
// Both sides call both ways: a message with `method` and `id` is a request (answered with a message
// carrying the same id and `result` or `error`), with `method` and no `id` a notification. Ids are
// the sender's own, so the two directions never clash. The Rust half is src-tauri/src/rpc.rs.
//
//   const peer = createPeer({ write(line), onRequest(method, params), onNotification(method, params), timeoutMs, log })
//   peer.feed(chunk)       text read from the other side (any split of lines)
//   peer.request(method, params, { timeoutMs }) -> Promise
//   peer.notify(method, params)
//   peer.close(reason)     rejects everything waiting

const DEFAULT_TIMEOUT_MS = 30000;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function createPeer({ write, onRequest = async () => { throw new RpcError(-32601, 'no handler'); }, onNotification = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
  let nextId = 1;
  let buffer = '';
  let closed = null;
  const pending = new Map(); // id -> { resolve, reject, timer, method }

  const send = (message) => write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

  function request(method, params, { timeoutMs: ms = timeoutMs } = {}) {
    if (closed) return Promise.reject(new RpcError(-32000, `rpc closed: ${closed}`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcError(-32001, `${method}: no answer in ${ms} ms`));
      }, ms);
      pending.set(id, { resolve, reject, timer, method });
      try {
        send({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params) {
    if (closed) return;
    try { send({ method, params }); } catch (err) { log(`notify ${method}: ${err.message}`); }
  }

  async function incoming(message) {
    if (message.method) {
      if (message.id === undefined || message.id === null) {
        try { onNotification(message.method, message.params); } catch (err) { log(`notification ${message.method}: ${err.message}`); }
        return;
      }
      try {
        const result = await onRequest(message.method, message.params);
        send({ id: message.id, result: result === undefined ? null : result });
      } catch (err) {
        send({ id: message.id, error: { code: err.rpcCode || -32000, message: String(err.message || err), data: err.code ? { code: err.code } : undefined } });
      }
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return; // late: it had timed out
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new RpcError(message.error.code ?? -32000, message.error.message || 'error'));
    else waiting.resolve(message.result);
  }

  function feed(chunk) {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log(`not JSON: ${line.slice(0, 120)}`);
        continue;
      }
      if (message && typeof message === 'object') incoming(message);
    }
  }

  function close(reason = 'closed') {
    closed = reason;
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new RpcError(-32000, `rpc closed: ${reason}`));
      pending.delete(id);
    }
  }

  return { feed, request, notify, close, pending: () => pending.size };
}

module.exports = { createPeer, RpcError, DEFAULT_TIMEOUT_MS };
