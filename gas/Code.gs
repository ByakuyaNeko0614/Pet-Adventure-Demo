function doGet(event) {
  const pages = { hatch: 'Hatch', nursery: 'Nursery', adventure: 'Adventure', shop: 'Shop' };
  const page = event && event.parameter && event.parameter.page;
  if (page === 'bridge') {
    const nonce = event.parameter.nonce;
    if (!/^[a-f0-9-]{36}$/.test(nonce || '')) return HtmlService.createHtmlOutput('無效的連線識別。');
    const bridge = HtmlService.createTemplateFromFile('Bridge');
    bridge.nonce = nonce;
    // 只有無介面的 RPC 頁需要嵌入，正式遊戲仍由 GitHub Pages 顯示。
    return bridge.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  const template = HtmlService.createTemplateFromFile(Rules.own(pages, page) ? pages[page] : pages.hatch);
  template.appUrl = ScriptApp.getService().getUrl();
  return template.evaluate().setTitle('寵物尋寶').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
function verifyOwner_() {
  const configured = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  const active = Session.getActiveUser().getEmail();
  if (!configured || !active || configured.trim().toLowerCase() !== active.toLowerCase()) {
    throw new Error('請以 OWNER_EMAIL 設定的擁有者帳號執行管理操作。');
  }
}

function gameApi(method, payload, token) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('無效的資料請求。');
  return withGameLock_(() => {
    const playerId = authenticated_(token).row[0];
    const sheets = readSheets_(playerId);
    const data = sheets.data;
    if (method === 'read') return { data: Store.view(data), active: data.active };
    if (method === 'history') return Store.find(data.history, payload.id, '冒險紀錄');
    if (method !== 'command') throw new Error('不支援的資料操作。');
    const time = new Date().toISOString();
    const mutation = Store.mutate(data, payload, { id: Utilities.getUuid(), time });
    if (mutation.changed) writeSheets_(sheets, time);
    return { data: Store.view(data), active: data.active, value: mutation.value };
  });
}

// Run from the Apps Script editor after setting SPREADSHEET_ID and OWNER_EMAIL.
function initializeGame() {
  verifyOwner_();
  return withGameLock_(() => {
    const book = SpreadsheetApp.openById(spreadsheetId_());
    for (const [name, fields] of Object.entries({ Accounts: ACCOUNT_FIELDS, ...TABLES })) {
      const sheet = book.getSheetByName(name) || book.insertSheet(name);
      if (!sheet.getLastRow()) {
        sheet.getRange(1, 1, 1, fields.length).setValues([fields]);
        sheet.setFrozenRows(1);
      } else {
        const header = sheet.getRange(1, 1, 1, fields.length).getValues()[0];
        const legacyMaps = name === 'Maps' && header[9] === '' &&
          JSON.stringify(header.slice(0, 9)) === JSON.stringify(fields.slice(0, 9));
        if (legacyMaps) sheet.getRange(1, 10).setValue('playerId');
        else if (JSON.stringify(header) !== JSON.stringify(fields)) throw new Error(name + ' 的欄位與遊戲結構不符。');
      }
    }
    SpreadsheetApp.flush();
  });
}

// Register the destination account first, then run this from the editor.
function migrateLegacySave() {
  verifyOwner_();
  return withGameLock_(() => {
    const username = PropertiesService.getScriptProperties().getProperty('LEGACY_TARGET_USERNAME');
    const key = usernameKey_(username);
    const account = readAccounts_().rows.find(row => row[2] === key);
    if (!account) throw new Error('請先註冊要接收舊存檔的帳號。');
    const { id, rows } = readGameRows_();
    const legacy = playerRows_(rows, 'owner');
    if (!legacy.Players.length) return '沒有待轉移的舊存檔。';
    decodeRows_(legacy);
    const target = account[0];
    if (Object.values(playerRows_(rows, target)).some(entries => entries.length)) {
      throw new Error('目標帳號已有遊玩進度。請指定一個尚未開始遊玩的帳號。');
    }
    const migrated = Object.fromEntries(Object.entries(rows).map(([table, entries]) => [table, entries.map(row => {
      if (playerOf_(table, row) !== 'owner') return row;
      const updated = [...row];
      updated[PLAYER_COLUMN[table]] = target;
      return updated;
    })]));
    writeGameRows_(id, rows, migrated);
    return '已轉移舊存檔。';
  });
}
