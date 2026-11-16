const ACCOUNT_FIELDS = ['playerId', 'username', 'usernameKey', 'salt', 'passwordHash', 'iterations', 'sessions'];
const PASSWORD_ITERATIONS = 600000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ERROR = '登入已失效，請重新登入。';

function withGameLock_(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return action(); } finally { lock.releaseLock(); }
}

function usernameKey_(username) {
  const key = typeof username === 'string' ? username.trim().normalize('NFKC').toLowerCase() : '';
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(key)) throw new Error('帳號請用 3–24 個文字、數字、底線或連字號。');
  return key;
}

function readAccounts_() {
  const id = spreadsheetId_();
  const { values = [] } = Sheets.Spreadsheets.Values.get(id, 'Accounts!A:G', { valueRenderOption: 'UNFORMATTED_VALUE' });
  if (JSON.stringify(values[0]) !== JSON.stringify(ACCOUNT_FIELDS)) throw new Error('Accounts 尚未初始化，或欄位已改動。');
  return { id, rows: values.slice(1) };
}

function saveAccount_(accounts, index, row) {
  const range = 'Accounts!A' + (index + 2) + ':G' + (index + 2);
  if (index === accounts.rows.length) {
    Sheets.Spreadsheets.Values.append({ values: [row] }, accounts.id, 'Accounts!A:G',
      { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  } else {
    Sheets.Spreadsheets.Values.update({ values: [row] }, accounts.id, range, { valueInputOption: 'RAW' });
  }
}

function uuidBytes_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function sessionHash_(token) {
  return AccountCrypto.digest(token);
}

function issueSession_(accounts, index, row) {
  const token = row[0] + '.' + uuidBytes_() + uuidBytes_();
  const now = Date.now();
  const sessions = JSON.parse(row[6] || '[]').filter(session => session.expires > now).slice(-7);
  sessions.push({ hash: sessionHash_(token), expires: now + SESSION_MS });
  row[6] = JSON.stringify(sessions);
  saveAccount_(accounts, index, row);
  return { playerId: row[0], username: row[1], token };
}

function authenticated_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) throw new Error(SESSION_ERROR);
  const accounts = readAccounts_();
  const index = accounts.rows.findIndex(row => row[0] === token.slice(0, 32));
  if (index < 0) throw new Error(SESSION_ERROR);
  const row = accounts.rows[index];
  const hash = sessionHash_(token);
  const sessions = JSON.parse(row[6] || '[]').filter(session => session.expires > Date.now());
  if (!sessions.some(session => session.hash === hash)) throw new Error(SESSION_ERROR);
  return { accounts, index, row, hash, sessions };
}

function countAttempt_(method, key) {
  const cache = CacheService.getScriptCache();
  const minute = Math.floor(Date.now() / 60000);
  const global = 'accounts:' + method + ':' + minute;
  const personal = 'accounts:login:' + Math.floor(minute / 10) + ':' + sessionHash_(key);
  const total = Number(cache.get(global) || 0);
  const attempts = Number(cache.get(personal) || 0);
  if (total >= (method === 'register' ? 20 : 60) || (method === 'login' && attempts >= 8)) {
    throw new Error('操作太頻繁，請稍後再試。');
  }
  cache.put(global, String(total + 1), 60);
  if (method === 'login') cache.put(personal, String(attempts + 1), 600);
}

function sameHash_(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function accountApi(method, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('無效的帳號請求。');
  if (method === 'session' || method === 'logout') return withGameLock_(() => {
    const { accounts, index, row, hash, sessions } = authenticated_(payload.token);
    if (method === 'logout') {
      row[6] = JSON.stringify(sessions.filter(session => session.hash !== hash));
      saveAccount_(accounts, index, row);
      return { signedOut: true };
    }
    return { playerId: row[0], username: row[1] };
  });
  if (method !== 'login' && method !== 'register') throw new Error('不支援的帳號操作。');

  const key = usernameKey_(payload.username);
  const password = payload.password;
  if (typeof password !== 'string' || password.length > 256 || [...password].length < 15 || [...password].length > 128) {
    throw new Error('密碼請使用 15–128 個字元。');
  }
  const existing = withGameLock_(() => {
    countAttempt_(method, key);
    return readAccounts_().rows.find(row => row[2] === key);
  });
  if (method === 'register' && existing) throw new Error('這個帳號名稱已有人使用。');
  const salt = existing?.[3] || uuidBytes_();
  const iterations = existing?.[5] || PASSWORD_ITERATIONS;
  const hash = AccountCrypto.passwordHash(password, salt, iterations);
  if (method === 'login' && (!existing || !sameHash_(hash, existing[4]))) throw new Error('帳號或密碼錯誤。');
  return withGameLock_(() => {
    const accounts = readAccounts_();
    const index = accounts.rows.findIndex(row => row[2] === key);
    if (method === 'register') {
      if (index >= 0) throw new Error('這個帳號名稱已有人使用。');
      const row = [uuidBytes_(), payload.username.trim().normalize('NFKC'), key, salt, hash, iterations, '[]'];
      return issueSession_(accounts, accounts.rows.length, row);
    }
    const row = accounts.rows[index];
    if (!row || row[0] !== existing[0] || row[4] !== existing[4] || row[3] !== salt || row[5] !== iterations) {
      throw new Error('帳號或密碼錯誤。');
    }
    return issueSession_(accounts, index, row);
  });
}
