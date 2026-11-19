'use strict';

var Account = (() => {
  const pages = location.origin === 'https://byakuyaneko0614.github.io' &&
    location.pathname.startsWith('/Pet-Adventure-Demo/');
  if (pages) document.documentElement.dataset.mode = 'pages';
  if (!pages && document.documentElement.dataset.mode !== 'sheets') return null;
  const expired = '登入已失效，請重新登入。';
  // 頁面共用同一個分頁登入狀態，認證憑證只經由存檔橋接送到後端。
  const key = 'pet-adventure-session:' + (pages ? '/Pet-Adventure-Demo/' : new URL(document.baseURI).pathname);
  document.body.classList.add('account-locked');
  document.body.insertAdjacentHTML('afterbegin', `  <section class="account-gate" id="account-gate" aria-labelledby="account-title">
    <div class="account-card">
      <span class="brand-icon" aria-hidden="true">✦</span>
      <h1 id="account-title">寵物尋寶</h1>
      <p>登入後，回到你自己的寵物窩。</p>
      <form id="account-form" hidden>
        <label for="account-username">帳號名稱</label>
        <input id="account-username" autocomplete="username" maxlength="24" required>
        <label for="account-password">密碼</label>
        <input id="account-password" type="password" autocomplete="current-password" minlength="3" maxlength="256" required aria-describedby="account-password-help">
        <small id="account-password-help">至少 3 個字元。</small>
        <button class="button" id="account-submit" type="submit">登入</button>
        <button id="account-mode" type="button">第一次來？建立帳號</button>
      </form>
      <p id="account-message" role="status"></p>
      <a class="button" id="account-return" href="#" hidden>回登入畫面</a>
    </div>
  </section>`);
  const gate = document.getElementById('account-gate');
  const form = document.getElementById('account-form');
  const feedback = document.getElementById('account-message');
  const username = document.getElementById('account-username');
  const password = document.getElementById('account-password');
  const primary = document.getElementById('account-submit');
  const switchMode = document.getElementById('account-mode');
  const returnLink = document.getElementById('account-return');
  returnLink.href = location.href;
  let token = '', details = null, player = null, busy = false, registering = false;
  const pendingPages = [];
  const sessionDuration = 7 * 24 * 60 * 60 * 1000;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved?.startsWith('{')) {
      const parsed = JSON.parse(saved);
      if (parsed.expires > Date.now() && typeof parsed.token === 'string' && parsed.playerId && parsed.username) {
        details = parsed;
        token = parsed.token;
      }
    } else token = saved || '';
  } catch {}
  if (pages && details) gate.hidden = true;

  // Pages 呼叫跨站橋接；Apps Script 直接提供舊頁面時，使用內建的 google.script.run。
  function rpc(kind, method, payload) {
    if (pages) return PagesBridge.call(kind, method, payload, kind === 'game' ? token : undefined);
    return new Promise((resolve, reject) => {
      const request = google.script.run.withSuccessHandler(resolve)
        .withFailureHandler(error => reject(new Error(error.message)));
      if (kind === 'game') request.gameApi(method, payload, token);
      else request.accountApi(method, payload);
    });
  }

  const request = (method, payload) => rpc('account', method, payload);

  function saveSession(value) {
    details = value;
    token = value?.token || '';
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch {}
  }

  // 先設定玩家身分，再啟動依賴玩家資料的頁面。舊頁面的內嵌程式也在此時載入。
  function unlock(details) {
    player = { playerId: details.playerId, username: details.username };
    gate.hidden = true;
    document.body.classList.remove('account-locked');
    document.querySelectorAll('script[data-game-script]').forEach(source => {
      const script = document.createElement('script');
      script.textContent = source.textContent;
      source.replaceWith(script);
    });
    for (const start of pendingPages.splice(0)) start();
  }

  function lockPage(message) {
    if (player) {
      try { sessionStorage.removeItem('pet-adventure-view:' + key + ':' + player.playerId); } catch {}
    }
    saveSession(null);
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
      saveSession({ ...details, expires: Number(details.expires) || Date.now() + sessionDuration });
      unlock(details);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      password.value = '';
      busy = false;
      primary.disabled = switchMode.disabled = false;
    }
  });

  /*
   * 有完整且未過期的分頁登入資料時，換頁可直接顯示遊戲。
   * 舊版若只存了憑證，先向伺服器查一次身分。實際雲端讀寫仍會驗證憑證。
   */
  async function start() {
    if (details) {
      unlock(details);
      return;
    }
    if (token) {
      feedback.textContent = '正在確認登入狀態…';
      try {
        const verified = await request('session', { token });
        saveSession({ ...verified, token, expires: Number(verified.expires) || Date.now() + sessionDuration });
        unlock(verified);
        return;
      } catch (error) {
        if (isExpired(error)) saveSession(null);
        feedback.textContent = error.message;
      }
    }
    form.hidden = false;
    // 填資料的同時就準備第一次連線。已登入的快取換頁無需先連線。
    if (pages) void PagesBridge.prepare().catch(() => {});
  }

  function whenReady(start) {
    if (player) start();
    else pendingPages.push(start);
  }

  return { start, whenReady, logout, requireLogin, cacheKey: key, game: (method, payload) => rpc('game', method, payload),
    get player() { return player; } };
})();

if (document.documentElement.dataset.mode === 'pages') void Account.start();
