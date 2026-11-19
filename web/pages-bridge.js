'use strict';

var PagesBridge = (() => {
  const deployment = 'https://script.google.com/macros/s/AKfycbwLmvpAKWny5Tdf8DYRKeYS_QJv7KVJfIP_qTuOx3ZUA7KibOgCOVthRt9VaVdFOJ-x/exec';
  const protocol = 'pet-adventure-v1';
  const pending = new Map();
  let connection;

  function trustedOrigin(origin) {
    return /^https:\/\/(?:script\.google\.com|(?:[a-z0-9-]+-)?script\.googleusercontent\.com)$/.test(origin);
  }

  function insideFrame(source, frame) {
    // Apps Script 可能再嵌一層 sandbox。只接受這個 iframe 底下的視窗。
    for (let current = source, depth = 0; current && depth < 5; depth++) {
      if (current === frame.contentWindow) return true;
      if (current === window || current.parent === current) return false;
      current = current.parent;
    }
    return false;
  }

  window.addEventListener('message', event => {
    const active = connection;
    const message = event.data;
    if (!active || message?.protocol !== protocol || message.nonce !== active.nonce) return;
    if (!active.source) {
      if (message.type !== 'ready' || !trustedOrigin(event.origin) || !insideFrame(event.source, active.frame)) return;
      active.source = event.source;
      active.origin = event.origin;
      clearTimeout(active.timeout);
      active.resolve(active);
      return;
    }
    if (event.source !== active.source || event.origin !== active.origin || message.type !== 'result') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (typeof message.error === 'string') request.reject(new Error(message.error));
    else request.resolve(message.result);
  });

  function open() {
    if (connection) return connection.ready;
    const frame = document.createElement('iframe');
    const nonce = crypto.randomUUID();
    const url = new URL(deployment);
    url.search = new URLSearchParams({ page: 'bridge', nonce });
    frame.src = url.href;
    frame.title = '遊戲存檔連線';
    frame.hidden = true;
    frame.referrerPolicy = 'no-referrer';
    const active = { frame, nonce };
    connection = active;
    active.ready = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.timeout = setTimeout(() => {
        frame.remove();
        if (connection === active) connection = null;
        reject(new Error('暫時無法連到遊戲存檔服務，請稍後重試。'));
      }, 16000);
    });
    document.body.append(frame);
    return active.ready;
  }

  async function call(kind, method, payload, token) {
    const { source, origin, nonce } = await open();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('存檔服務回應逾時，請再試一次。'));
      }, 30000);
      pending.set(id, { resolve, reject, timeout });
      source.postMessage({ protocol, nonce, type: 'request', id, kind, method, payload, token }, origin);
    });
  }

  return { call, prepare: open };
})();
