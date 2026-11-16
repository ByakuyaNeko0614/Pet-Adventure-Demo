'use strict';

var Account = (() => {
  const expired = '登入已失效，請重新登入。';
  const key = 'pet-adventure-session:' + new URL(document.baseURI).pathname;
  const gate = document.getElementById('account-gate');
  const form = document.getElementById('account-form');
  const feedback = document.getElementById('account-message');
  const username = document.getElementById('account-username');
  const password = document.getElementById('account-password');
  const primary = document.getElementById('account-submit');
  const switchMode = document.getElementById('account-mode');
  const returnLink = document.getElementById('account-return');
  let token = '', player = null, busy = false, registering = false;
  try { token = sessionStorage.getItem(key) || ''; } catch {}

  function request(method, payload) {
    return new Promise((resolve, reject) => {
      google.script.run.withSuccessHandler(resolve)
        .withFailureHandler(error => reject(new Error(error.message))).accountApi(method, payload);
    });
  }

  function saveToken(value) {
    token = value;
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {}
  }

  function unlock(details) {
    player = { playerId: details.playerId, username: details.username };
    gate.hidden = true;
    document.body.classList.remove('account-locked');
    document.querySelectorAll('script[data-game-script]').forEach(source => {
      const script = document.createElement('script');
      script.textContent = source.textContent;
      source.replaceWith(script);
    });
  }

  function lockPage(message) {
    saveToken('');
    player = null;
    document.body.classList.add('account-locked');
    document.dispatchEvent(new Event('account-locked'));
    gate.hidden = false;
    form.hidden = true;
    feedback.textContent = message;
    returnLink.hidden = false;
    returnLink.focus();
  }

  function isExpired(error) { return error.message.includes(expired); }

  function requireLogin(error) {
    if (isExpired(error) && player) lockPage(expired);
  }

  async function logout() {
    try {
      await request('logout', { token });
      lockPage('已登出。');
    } catch (error) {
      if (!isExpired(error)) throw error;
      lockPage(expired);
    }
  }

  switchMode.addEventListener('click', () => {
    registering = !registering;
    primary.textContent = registering ? '建立帳號' : '登入';
    switchMode.textContent = registering ? '已有帳號，回到登入' : '第一次來？建立帳號';
    password.autocomplete = registering ? 'new-password' : 'current-password';
    password.value = '';
    feedback.textContent = '';
    username.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    primary.disabled = switchMode.disabled = true;
    feedback.textContent = registering ? '正在建立帳號…' : '正在登入…';
    try {
      const details = await request(registering ? 'register' : 'login', { username: username.value, password: password.value });
      saveToken(details.token);
      unlock(details);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      password.value = '';
      busy = false;
      primary.disabled = switchMode.disabled = false;
    }
  });

  async function start() {
    if (token) {
      feedback.textContent = '正在確認登入狀態…';
      try {
        unlock(await request('session', { token }));
        return;
      } catch (error) {
        if (isExpired(error)) saveToken('');
        feedback.textContent = error.message;
      }
    }
    form.hidden = false;
  }

  return { start, logout, requireLogin, get token() { return token; }, get player() { return player; } };
})();
