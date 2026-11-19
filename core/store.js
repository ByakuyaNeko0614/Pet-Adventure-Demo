'use strict';

var Store = (() => {
  const historyLimit = 24;
  const mapLimit = 30;
  const unlockedRooms = data => ['cottage', ...(data.rooms || [])];

  function fresh() {
    return { revision: 0, lastRequest: '', coins: Rules.startingCoins, hatched: 0, active: null, selected: null, egg: null,
      pets: [], maps: [], inventory: { tonic: 1, tea: 1 }, history: [] };
  }

  function view(data) {
    return {
      revision: data.revision, coins: data.coins, hatched: data.hatched, active: data.active?.id || null, egg: data.egg || null,
      rooms: unlockedRooms(data), selected: data.selected, pets: data.pets.map(pet => ({ ...pet, room: pet.room || 'cottage',
        iv: Rules.individualValues(pet), away: data.active?.pet.id === pet.id,
        condition: Rules.condition(pet, new Date().toISOString(), data.active?.pet.id === pet.id) })), inventory: data.inventory,
      maps: data.maps.map(({ cells, ...map }) => map),
      history: data.history.map(({ ticket, actions, trace, ...summary }) => summary)
    };
  }

  function find(list, id, label) {
    const found = list.find(entry => entry.id === id);
    if (!found) throw new Error(`找不到${label}。`);
    return found;
  }

  function remove(list, id, label) {
    find(list, id, label);
    return list.filter(entry => entry.id !== id);
  }

  function seed(value, fallback) {
    if (value === '' || value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > 48 || !/^[\p{L}\p{N}_-]+$/u.test(value)) {
      throw new Error('Seed 請使用 1–48 個文字、數字、底線或連字號。');
    }
    return value;
  }

  function itemFor(id) {
    if (!Rules.own(Rules.items, id)) throw new Error('找不到道具。');
    return Rules.items[id];
  }

  function changeQuantity(data, id, delta) {
    const next = (data.inventory[id] || 0) + delta;
    if (next < 0) throw new Error('背包道具不足。');
    if (next === 0) delete data.inventory[id];
    else data.inventory[id] = Math.min(Rules.maxItems, next);
  }

  function trainIv(data, pet, itemId, item, time, id) {
    const { current, chance, blocked, required, misses } = Rules.trainingOdds(pet, item);
    if (blocked === 'max') throw new Error('這項個體值已達上限。');
    if (blocked === 'level') throw new Error(`此階段需要 Lv. ${required} 才能培養。`);
    changeQuantity(data, itemId, -1);
    const success = Rules.seeded('training', id, pet.id, itemId)() * 100 < chance;
    if (success) {
      pet.condition = Rules.condition(pet, time);
      pet.iv = { ...Rules.individualValues(pet), [item.iv]: current + 1 };
      const gain = current >= Rules.birthIvCap ? 1 : item.amount;
      pet[item.stat] = Math.min(Rules.capacityFor(pet, item.stat), pet[item.stat] + gain);
    }
    pet.trainingMisses = { ...pet.trainingMisses, [item.iv]: success ? 0 : misses + 1 };
    pet.updatedAt = time;
    return { success, chance };
  }

  function makeMap(seedValue, difficulty, id, time) {
    return { ...Maze.generate(seedValue, difficulty), id, createdAt: time };
  }

  function addMap(data, map) {
    if (data.maps.length >= mapLimit) data.maps.shift();
    data.maps.push(map);
    return map;
  }

  // 出發時保存寵物狀態、補給與種子，作為稍後重播和結算的起點。
  function begin(data, input, environment) {
    if (data.active) throw new Error('請先完成或放棄目前的冒險，消耗會保留。');
    const { id, time } = environment;
    const pet = find(data.pets, input.petId, '寵物');
    pet.condition = Rules.condition(pet, time);
    if (pet.condition.stamina < 1 || pet.condition.courage <= 0) throw new Error('夥伴需要休息或補給才能出發。');
    if (!Rules.own(Rules.difficulties, input.difficulty)) throw new Error('無效的難度。');
    if (input.mission !== undefined && !Rules.own(Rules.missions, input.mission)) throw new Error('無效的探索委託。');
    const mapSeed = seed(input.mapSeed, id);
    const decisionSeed = seed(input.decisionSeed, id + '-ai');
    const layoutVersion = Rules.mapVersion(input.difficulty, Rules.version);
    const map = data.maps.find(entry => entry.seed === mapSeed && entry.difficulty === input.difficulty &&
      entry.size === Rules.wideSize && entry.cells.filter(cell => cell === 'exit').length === Rules.exitCount &&
      (!layoutVersion || entry.rulesVersion === layoutVersion))
      || addMap(data, makeMap(mapSeed, input.difficulty, id, time));
    const limit = Rules.difficultyFor(input.difficulty, Rules.version).supplyLimit ?? Rules.maxItems;
    const bag = Object.fromEntries(Object.keys(Rules.items)
      .filter(key => Rules.items[key].type === 'adventure' && data.inventory[key])
      .map(key => [key, Math.min(data.inventory[key], limit)]));
    data.active = { id, rulesVersion: Rules.version, mission: input.mission || 'courier', mapId: map.id, mapSeed, decisionSeed,
      eventSeed: decisionSeed + '-event', difficulty: map.difficulty, pet: { ...pet }, bag, startedAt: time };
    data.selected = pet.id;
    return data.active;
  }

  // 先重播驗證完整動作，再一次計入消耗與獎勵，最後清除進行中的冒險。
  function settle(data, input, time) {
    const ticket = data.active;
    if (!ticket || ticket.id !== input.id) throw new Error('這場冒險已失效，請重新開啟探索頁。');
    const state = replayProgress(ticket, input.actions);
    const log = Adventure.result(state, time);
    const pet = find(data.pets, log.petId, '出戰寵物');
    if (Object.entries(state.used).some(([key, quantity]) => (data.inventory[key] || 0) < quantity)) {
      throw new Error('背包補給不足，請確認試算表或重新開始探索。');
    }
    for (const [key, quantity] of Object.entries(state.used)) changeQuantity(data, key, -quantity);
    for (const [key, quantity] of Object.entries(log.items)) {
      const added = Math.min(quantity, Rules.maxItems - (data.inventory[key] || 0));
      if (added) changeQuantity(data, key, added);
      if (added < quantity) {
        if (added) log.items[key] = added;
        else delete log.items[key];
      }
    }
    Rules.gainExp(pet, log.exp);
    saveCondition(pet, state, time);
    pet.updatedAt = time;
    data.coins += log.coins;
    data.history.unshift(log);
    data.history.length = Math.min(historyLimit, data.history.length);
    data.active = null;
    return log;
  }

  // 客戶端傳的是整段動作。前綴必須跟已保存的進度相同，才能繼續追加。
  function replayProgress(ticket, actions) {
    const prior = ticket.progress || [];
    actions = actions || prior;
    if (JSON.stringify(actions.slice(0, prior.length)) !== JSON.stringify(prior)) throw new Error('冒險已有較新的進度，請重新載入。');
    return Adventure.replay(ticket, actions);
  }
  function saveCondition(pet, state, time) {
    pet.condition = { stamina: Math.max(0, state.stamina), courage: Math.max(0, state.courage),
      patience: Math.max(0, state.patience ?? pet.patience), at: time };
  }

  function mutate(data, command, environment) {
    const { op, input, requestId, revision } = command;
    const { id, time } = environment;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{12,64}$/.test(requestId) ||
      !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('無效的請求。');

    /*
     * 先處理已完成的結算與重送請求，再比對存檔版本。
     * 儲存成功但回應遺失時，重按結算會取得原有紀錄，避免再發一次獎勵。
     */
    if (op === 'settle') {
      const previous = data.history.find(log => log.id === input.id);
      if (previous) return { changed: false, value: previous };
    }
    if (data.lastRequest === requestId) {
      return { changed: false, value: op === 'begin' ? data.active : null };
    }
    if (revision !== data.revision) throw new Error('存檔已有新變更，已要求重新讀取，請再操作一次。');

    let value = null;
    switch (op) {
      case 'incubate': {
        if (data.egg) throw new Error('孵化窩裡已經有一顆蛋。');
        if (data.pets.some(pet => pet.needsName)) throw new Error('先幫剛破殼的夥伴取名吧。');
        if (data.pets.length >= Rules.maxPets) throw new Error('寵物欄位已滿。');
        const price = Rules.hatchPrice(data.hatched);
        if (data.coins < price) throw new Error('金幣不足。');
        data.egg = { id, startedAt: time,
          readyAt: new Date(Date.parse(time) + Rules.incubationSeconds(data.hatched) * 1000).toISOString() };
        data.coins -= price;
        value = data.egg;
        break;
      }
      case 'hatch': {
        const egg = data.egg;
        if (!egg || input.id !== egg.id) throw new Error('找不到要孵化的蛋。');
        if (data.hatched > 0 && Date.parse(time) < Date.parse(egg.readyAt)) throw new Error('蛋還需要一點時間。');
        const pet = Rules.hatch(egg.name, egg.id, egg.id, time, { newborn: true });
        data.hatched++;
        data.egg = null;
        data.pets.push(pet);
        data.selected = pet.id;
        value = pet.id;
        break;
      }
      case 'rename': {
        const pet = find(data.pets, input.petId, '寵物');
        pet.name = Rules.petName(input.name);
        delete pet.needsName;
        pet.updatedAt = time;
        break;
      }
      case 'select':
        data.selected = find(data.pets, input.petId, '寵物').id;
        break;
      case 'unlockRoom': {
        if (!Rules.own(Rules.rooms, input.roomId)) throw new Error('找不到這個房間。');
        if (unlockedRooms(data).includes(input.roomId)) throw new Error('這個房間已解鎖。');
        const {price} = Rules.rooms[input.roomId];
        if (data.coins < price) throw new Error('金幣不足，還不能解鎖這個房間。');
        data.coins -= price;
        data.rooms = [...(data.rooms || []), input.roomId];
        break;
      }
      case 'movePet': {
        if (!unlockedRooms(data).includes(input.roomId)) throw new Error('請先解鎖這個房間。');
        const pet = find(data.pets, input.petId, '寵物');
        if (data.active?.pet.id === pet.id) throw new Error('等夥伴探險回來再搬家。');
        pet.room = input.roomId;
        pet.updatedAt = time;
        break;
      }
      case 'deletePet':
        if (data.active?.pet.id === input.petId) throw new Error('請先完成或放棄這隻寵物的探索。');
        if (data.pets.length === 1 && data.pets[0].id === input.petId) {
          throw new Error('家園至少要留一隻夥伴，不能放生最後一隻。');
        }
        data.pets = remove(data.pets, input.petId, '寵物');
        if (data.selected === input.petId) data.selected = data.pets[0]?.id || null;
        break;
      case 'buy': {
        const item = itemFor(input.itemId);
        if (item.type === 'souvenir') throw new Error('探險紀念品只能從迷宮帶回家。');
        if (data.coins < item.price) throw new Error('金幣不足。');
        if (data.inventory[input.itemId] >= Rules.maxItems) throw new Error('背包數量已達上限。');
        changeQuantity(data, input.itemId, 1);
        data.coins -= item.price;
        break;
      }
      case 'train': {
        const pet = find(data.pets, input.petId, '寵物');
        if (data.active?.pet.id === pet.id) throw new Error('請先讓夥伴結束探索回家。');
        const item = itemFor(input.itemId);
        if (item.type !== 'training') throw new Error('這個道具只能在探索中使用。');
        if (item.iv) {
          value = trainIv(data, pet, input.itemId, item, time, id);
          break;
        }
        if (pet.level >= Rules.maxLevel) {
          throw new Error('寵物的這項能力已達上限。');
        }
        changeQuantity(data, input.itemId, -1);
        pet.condition = Rules.condition(pet, time);
        Rules.gainExp(pet, item.amount);
        pet.updatedAt = time;
        break;
      }
      case 'care': {
        const pet = find(data.pets, input.petId, '寵物');
        if (data.active?.pet.id === pet.id) throw new Error('探索中請使用探索頁的補給。');
        const item = itemFor(input.itemId);
        if (item.type === 'capacity') {
          value = trainIv(data, pet, input.itemId, item, time, id);
        } else if (['adventure', 'recovery'].includes(item.type)) {
          const cap = item.stat === 'patience' ? pet.patience : pet[item.stat === 'stamina' ? 'maxStamina' : 'maxCourage'];
          const current = Rules.condition(pet, time);
          if (current[item.stat] >= cap) throw new Error('這項狀態已恢復滿了。');
          changeQuantity(data, input.itemId, -1);
          pet.condition = { ...current, [item.stat]: Math.min(cap, current[item.stat] + item.amount) };
        } else throw new Error('請在養成面板使用這個道具。');
        break;
      }
      // 平常同步只提交探索進度與目前狀態，補給在結算或放棄時扣除，獎勵由結算發放。
      case 'progress': {
        if (data.active?.id !== input.id) throw new Error('這場冒險已失效。');
        const state = replayProgress(data.active, input.actions);
        data.active.progress = input.actions;
        saveCondition(find(data.pets, data.active.pet.id, '寵物'), state, time);
        break;
      }
      case 'createMap':
        value = addMap(data, makeMap(seed(input.mapSeed, id), input.difficulty, id, time)).id;
        break;
      case 'updateMap': {
        const map = find(data.maps, input.id, '地圖');
        const updated = makeMap(seed(input.mapSeed, map.seed), input.difficulty, map.id, map.createdAt);
        data.maps[data.maps.indexOf(map)] = updated;
        break;
      }
      case 'deleteMap':
        data.maps = remove(data.maps, input.id, '地圖');
        break;
      case 'deleteLog':
        data.history = remove(data.history, input.id, '冒險紀錄');
        break;
      case 'begin':
        value = begin(data, input, environment);
        break;
      case 'abandon':
        if (data.active?.id !== input.id) throw new Error('這場冒險已失效。');
        {
          const state = replayProgress(data.active, input.actions);
          for (const [key, quantity] of Object.entries(state.used)) changeQuantity(data, key, -quantity);
          saveCondition(find(data.pets, data.active.pet.id, '寵物'), state, time);
        }
        data.active = null;
        break;
      case 'settle':
        value = settle(data, input, time);
        break;
      default:
        throw new Error('不支援的資料操作。');
    }

    data.revision++;
    data.lastRequest = requestId;
    return { changed: true, value };
  }

  return { fresh, view, mutate, find };
})();
