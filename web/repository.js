'use strict';

var Repository = (() => {
  const storageKey = 'pet-treasure-adventure-v1';
  const mode = document.documentElement.dataset.mode;
  const isSheets = mode === 'sheets' || mode === 'pages';
  const isLegacy = mode === 'sheets';
  const snapshotTtl = 45000;
  const id = () => crypto.randomUUID();
  let loading;

  function snapshotKey() {
    return 'pet-adventure-view:' + Account.cacheKey + ':' + Account.player.playerId;
  }

  function readSnapshot() {
    try { return JSON.parse(sessionStorage.getItem(snapshotKey())); } catch { return null; }
  }

  function cacheSnapshot(result, key = snapshotKey()) {
    try {
      const existing = JSON.parse(sessionStorage.getItem(key));
      // 一次較慢的讀取可能比剛完成的寫入晚回來，不能覆蓋更新的版本。
      if (existing?.result.data.revision > result.data.revision) return;
      sessionStorage.setItem(key, JSON.stringify({
        expires: Date.now() + snapshotTtl,
        result: { data: result.data, active: result.active }
      }));
    } catch {}
  }

  function local() {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return Store.fresh();
    return JSON.parse(raw);
  }

  function localOperation(method, payload) {
    const readWrite = () => {
      const data = local();
      if (method === 'read') return { data: Store.view(data), active: data.active };
      if (method === 'history') return Store.find(data.history, payload.id, '冒險紀錄');
      const mutation = Store.mutate(data, payload, { id: id(), time: new Date().toISOString() });
      if (mutation.changed) localStorage.setItem(storageKey, JSON.stringify(data));
      return { data: Store.view(data), value: mutation.value };
    };
    return navigator.locks ? navigator.locks.request(storageKey, readWrite) : Promise.resolve().then(readWrite);
  }

  async function remote(method, payload) {
    const key = snapshotKey();
    try {
      const result = await Account.game(method, payload);
      if (method !== 'history' && Account.player && key === snapshotKey()) cacheSnapshot(result, key);
      return result;
    } catch (error) {
      Account.requireLogin(error);
      throw error;
    }
  }

  function call(method, payload = {}) {
    return isSheets ? remote(method, payload) : localOperation(method, payload);
  }

  function read({ fresh = false } = {}) {
    if (!isSheets) return localOperation('read', {});
    // 同一分頁的短期快取只加速呈現。伺服器驗證仍用於所有實際讀寫。
    const cached = readSnapshot();
    if (!fresh && cached?.expires > Date.now()) return Promise.resolve(cached.result);
    if (!loading) loading = remote('read', {}).finally(() => { loading = null; });
    return loading;
  }

  function startPage(start) {
    if (isSheets) Account.whenReady(start);
    else start();
  }

  function playerKey(prefix) {
    return isSheets ? prefix + '-sheets-' + Account.player.playerId : prefix;
  }

  return { isSheets, isLegacy, startPage, playerKey, read, history: id => call('history', { id }),
    command: (op, input, revision, requestId = id()) => call('command', { op, input, revision, requestId }) };
})();
