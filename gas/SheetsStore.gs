const TABLES = {
  Players: ['playerId', 'revision', 'lastRequest', 'coins', 'hatched', 'selectedPet', 'activeTicket'],
  Pets: ['petId', 'playerId', 'name', 'species', 'personality', 'traits', 'level', 'exp',
    'maxStamina', 'maxCourage', 'patience', 'mood', 'hatchSeed', 'createdAt', 'updatedAt'],
  Maps: ['mapId', 'seed', 'difficulty', 'size', 'terrainData', 'startPosition', 'treasurePosition', 'shortest', 'createdAt', 'playerId'],
  Inventory: ['playerId', 'itemId', 'itemName', 'quantity', 'updatedAt'],
  AdventureLogs: ['adventureId', 'playerId', 'petId', 'mapId', 'petName', 'personality', 'difficulty',
    'result', 'failure', 'steps', 'shortest', 'spentStamina', 'spentCourage', 'interventions', 'attempts',
    'correct', 'explorations', 'coins', 'exp', 'items', 'summary', 'startedAt', 'finishedAt', 'ticket', 'actions', 'trace']
};

function spreadsheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('請在 Apps Script 設定有效的 SPREADSHEET_ID。');
  return id;
}

function readGameRows_() {
  const id = spreadsheetId_();
  const names = Object.keys(TABLES);
  const response = Sheets.Spreadsheets.Values.batchGet(id, { ranges: names, valueRenderOption: 'UNFORMATTED_VALUE' });
  const rows = {};
  for (const [index, name] of names.entries()) {
    const values = response.valueRanges[index].values || [];
    if (JSON.stringify(values[0]) !== JSON.stringify(TABLES[name])) {
      throw new Error(name + ' 尚未初始化，或欄位已改動。');
    }
    rows[name] = values.slice(1);
  }
  return { id, rows };
}

const PLAYER_COLUMN = { Players: 0, Pets: 1, Maps: 9, Inventory: 0, AdventureLogs: 1 };

function playerOf_(table, row) {
  return row[PLAYER_COLUMN[table]] || (table === 'Maps' ? 'owner' : '');
}

function playerRows_(rows, playerId) {
  return Object.fromEntries(Object.entries(rows).map(([table, entries]) =>
    [table, entries.filter(row => playerOf_(table, row) === playerId)]));
}

function readSheets_(playerId) {
  const { id, rows } = readGameRows_();
  const own = playerRows_(rows, playerId);
  return { id, allRows: rows, rows: own, data: decodeRows_(own), playerId };
}

function decodeRows_(rows) {
  if (!rows.Players.length) {
    if (Object.values(rows).some(table => table.length)) throw new Error('存檔缺少 Players 記錄。');
    return Store.fresh();
  }
  if (rows.Players.length !== 1) throw new Error('同一帳號有重複的存檔。');
  const [, revision, lastRequest, coins, hatched, selected, active] = rows.Players[0];
  const saved = active ? JSON.parse(active) : null;
  const packed = saved && Object.prototype.hasOwnProperty.call(saved, 'egg');
  return {
    revision, lastRequest: lastRequest || '', coins, hatched, selected: selected || null,
    active: packed ? saved.active : saved, egg: packed ? saved.egg : null, rooms: packed ? saved.rooms : undefined,
    pets: rows.Pets.map(([id, , name, species, personality, traits, level, exp, maxStamina, maxCourage, patience,
      mood, hatchSeed, createdAt, updatedAt]) => ({ id, name, species, personality, traits: JSON.parse(traits), level, exp,
      maxStamina, maxCourage, patience, ...decodePetMood_(mood), hatchSeed, createdAt, updatedAt })),
    maps: rows.Maps.map(([id, seed, difficulty, size, terrainData, start, treasure, shortest, createdAt]) => {
      const terrain = JSON.parse(terrainData);
      return { id, seed, difficulty, size, ...(Array.isArray(terrain) ? {cells: terrain} : terrain),
        start, treasure, shortest, createdAt };
    }),
    inventory: Object.fromEntries(rows.Inventory.map(([, id, , quantity]) => [id, quantity])),
    history: rows.AdventureLogs.map(row => {
      const [id, , petId, mapId, petName, personality, difficulty, result, failure, steps, shortest,
        spentStamina, spentCourage, interventions, attempts, correct, explorations, coins, exp, items, summary,
        startedAt, finishedAt, ticket, actions, trace] = row;
      return { id, petId, mapId, petName, personality, difficulty, result, failure, steps, shortest,
        spentStamina, spentCourage, interventions, attempts, correct, explorations, coins, exp, items: JSON.parse(items),
        summary, startedAt, finishedAt, ticket: JSON.parse(ticket), actions: JSON.parse(actions), trace: JSON.parse(trace) };
    })
  };
}

function encodeRows_(data, previous, time, playerId) {
  return {
    Players: [[playerId, data.revision, data.lastRequest, data.coins, data.hatched, data.selected || '',
      data.egg || data.rooms?.length ? JSON.stringify({active: data.active, egg: data.egg || null, rooms: data.rooms}) :
        data.active ? JSON.stringify(data.active) : '']],
    Pets: data.pets.map(pet => [pet.id, playerId, pet.name, pet.species, pet.personality, JSON.stringify(pet.traits),
      pet.level, pet.exp, pet.maxStamina, pet.maxCourage, pet.patience, JSON.stringify({ mood: pet.mood, condition: pet.condition,
        iv: pet.iv, needsName: pet.needsName, room: pet.room, trainingMisses: pet.trainingMisses }), pet.hatchSeed, pet.createdAt, pet.updatedAt]),
    Maps: data.maps.map(map => [map.id, map.seed, map.difficulty, map.size,
      JSON.stringify(map.rulesVersion ? {cells: map.cells, rulesVersion: map.rulesVersion} : map.cells), map.start,
      map.treasure, map.shortest, map.createdAt, playerId]),
    Inventory: Object.keys(Rules.items).filter(id => data.inventory[id]).map(id => {
      const prior = previous.Inventory.find(row => row[1] === id);
      const quantity = data.inventory[id];
      return [playerId, id, Rules.items[id].name, quantity, prior && prior[3] === quantity ? prior[4] : time];
    }),
    AdventureLogs: data.history.map(log => [log.id, playerId, log.petId, log.mapId, log.petName, log.personality,
      log.difficulty, log.result, log.failure, log.steps, log.shortest, log.spentStamina, log.spentCourage,
      log.interventions, log.attempts, log.correct, log.explorations, log.coins, log.exp, JSON.stringify(log.items),
      log.summary, log.startedAt, log.finishedAt, JSON.stringify(log.ticket), JSON.stringify(log.actions), JSON.stringify(log.trace)])
  };
}

function writeSheets_(sheets, time) {
  const own = encodeRows_(sheets.data, sheets.rows, time, sheets.playerId);
  const rows = Object.fromEntries(Object.entries(sheets.allRows).map(([table, entries]) => {
    let inserted = false;
    const updated = entries.flatMap(row => {
      if (playerOf_(table, row) !== sheets.playerId) return [row];
      if (inserted) return [];
      inserted = true;
      return own[table];
    });
    if (!inserted) updated.push(...own[table]);
    return [table, updated];
  }));
  writeGameRows_(sheets.id, sheets.allRows, rows);
}

function writeGameRows_(id, previous, rows) {
  const changed = Object.keys(TABLES).filter(name =>
    JSON.stringify(normalizeRows_(name, rows[name])) !== JSON.stringify(normalizeRows_(name, previous[name])));
  if (!changed.length) return;
  const book = Sheets.Spreadsheets.get(id, { fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))' });
  const properties = Object.fromEntries(book.sheets.map(sheet => [sheet.properties.title, sheet.properties]));
  const requests = [];
  for (const name of changed) {
    const { sheetId, gridProperties } = properties[name];
    const endRowIndex = 1 + Math.max(rows[name].length, previous[name].length);
    if (endRowIndex > gridProperties.rowCount) requests.push({
      appendDimension: { sheetId, dimension: 'ROWS', length: endRowIndex - gridProperties.rowCount }
    });
    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: 1, endRowIndex, startColumnIndex: 0, endColumnIndex: TABLES[name].length },
        rows: normalizeRows_(name, rows[name]).map(row => ({ values: row.map(value => ({
          userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: String(value) }
        })) })),
        fields: 'userEnteredValue'
      }
    });
  }
  // All modified tables, including the consumed adventure ticket, commit together.
  Sheets.Spreadsheets.batchUpdate({ requests }, id);
}

function normalizeRows_(table, rows) {
  return rows.map(row => Array.from({ length: TABLES[table].length }, (_, index) => row[index] ?? ''));
}

function decodePetMood_(value) {
  if (typeof value === 'string' && value.startsWith('{')) return JSON.parse(value);
  return { mood: value || 'normal' };
}
