'use strict';

var Repository = (() => {
  const storageKey = 'pet-treasure-adventure-v1';
  const isSheets = document.documentElement.dataset.mode === 'sheets';
  const id = () => crypto.randomUUID();

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

  function remote(method, payload) {
    return new Promise((resolve, reject) => {
      google.script.run.withSuccessHandler(resolve).withFailureHandler(error => {
        const failure = new Error(error.message);
        Account.requireLogin(failure);
        reject(failure);
      }).gameApi(method, payload, Account.token);
    });
  }

  function call(method, payload = {}) {
    return isSheets ? remote(method, payload) : localOperation(method, payload);
  }

  function playerKey(prefix) {
    return isSheets ? prefix + '-sheets-' + Account.player.playerId : prefix;
  }

  return { isSheets, playerKey, read: () => call('read'), history: id => call('history', { id }),
    command: (op, input, revision, requestId = id()) => call('command', { op, input, revision, requestId }) };
})();
