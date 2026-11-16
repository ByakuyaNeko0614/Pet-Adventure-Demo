'use strict';

var Adventure = (() => {
  const chestLoot = Object.keys(Rules.items).filter(id => Rules.items[id].type !== 'souvenir');

  function lampSite(map) {
    const fromStart = Maze.bfs(map, map.start);
    const exits = map.exits.map(exit => Maze.bfs(map, exit));
    const chests = map.cells.flatMap((cell, position) => cell === 'chest' ? [position] : []);
    const trip = position => fromStart[position] + Math.min(...exits.map(field => field[position]));
    chests.sort((a, b) => trip(a) - trip(b) || a - b);
    const position = chests[Math.floor(chests.length / 2)];
    const open = { ...map, cells: Array(map.cells.length).fill('ground') };
    const neighbors = Maze.neighbors(open, position);
    const original = Math.min(...exits.map(field => field[position]));
    let bridge = neighbors.find(next => map.cells[next.position] === 'swamp')?.position;
    let stepsSaved = 0;
    for (const next of neighbors) {
      if (map.cells[next.position] !== 'wall') continue;
      const cells = map.cells.slice();
      cells[next.position] = 'ground';
      const distances = Maze.bfs({ ...map, cells }, position);
      const saved = original - Math.min(...map.exits.map(exit => distances[exit]));
      if (saved <= stepsSaved) continue;
      bridge = next.position;
      stepsSaved = saved;
    }
    return { position, bridge, stepsSaved };
  }

  function guidanceLeft(state) {
    return state.ticket.rulesVersion >= 7 ? Rules.guidance.total - state.guidanceSpent
      : Rules.maxInterventions - state.interventions;
  }

  function create(ticket) {
    if (!Number.isInteger(ticket.rulesVersion) || ticket.rulesVersion < 1 || ticket.rulesVersion > Rules.version) {
      throw new Error('此冒險使用不同版本的遊戲規則。');
    }
    const map = Maze.generate(ticket.mapSeed, ticket.difficulty, ticket.rulesVersion);
    return { ticket, map, toTreasure: Maze.bfs(map, map.treasure), position: map.start,
      stamina: ticket.rulesVersion >= 6 ? ticket.pet.condition?.stamina ?? ticket.pet.maxStamina : ticket.pet.maxStamina,
      courage: ticket.rulesVersion >= 6 ? ticket.pet.condition?.courage ?? ticket.pet.maxCourage : ticket.pet.maxCourage,
      patience: ticket.pet.condition?.patience ?? ticket.pet.patience, bag: { ...ticket.bag },
      mood: { key: 'normal', remaining: 3 }, recent: [map.start], visited: new Set([map.start]),
      claimed: new Set(), attempted: new Set(), goal: null, goalUntil: 0, detours: 0,
      steps: 0, version: 0, stalled: 0, bestDistance: map.shortest, cooldown: 0,
      pending: null, last: null, status: 'active', failure: '', interventions: 0, blocked: null,
      guidanceSpent: 0, lampSite: ticket.rulesVersion >= 7 && ticket.mission === 'lantern' ? lampSite(map) : null,
      encounter: null, chestOutcome: '', chestOutcomeAt: -1,
      cargo: null, intent: 'auto', delivered: 0, deliveryBonus: null,
      attempts: 0, correct: 0, explorations: 0, spentStamina: 0, spentCourage: 0,
      springs: 0, chests: 0, chestCoins: 0, chestItems: {}, used: {}, actions: [], trace: [], events: [] };
  }

  function prepare(state) {
    if (state.status !== 'active' || state.encounter) return null;
    if (!state.pending || state.pending.version !== state.version) state.pending = Decision.plan(state);
    return state.pending;
  }

  function forecast(state) {
    const next = prepare(state);
    const steps = [];
    if (!next) return { next, steps, ending: '' };

    // Use the same movement and event rules, with the live collections isolated.
    const projected = { ...state, visited: new Set(state.visited), claimed: new Set(state.claimed),
      attempted: new Set(state.attempted), chestItems: { ...state.chestItems }, actions: [], trace: [], events: [] };
    while (steps.length < 3 && projected.status === 'active' && !projected.encounter) {
      const decision = prepare(projected);
      if (decision.chosen) steps.push(decision.chosen);
      execute(projected, decision);
    }
    const ending = projected.status === 'success' ? '這段路會抵達終點寶藏。' :
      projected.encounter && projected.status === 'active' ? (projected.encounter.kind === 'exit'
        ? '抵達出口送達寶箱後，會停下來讓你決定收手或繼續。'
        : projected.encounter.kind === 'lantern' ? '抵達螢火遺跡後會停下，讓你選擇帶走什麼。'
          : '到寶箱時會停下來，由你決定開箱方式。') : projected.failure;
    return { next, steps, ending };
  }

  function finish(state, success, reason = '') {
    state.status = success ? 'success' : 'failure';
    state.failure = reason;
    state.pending = null;
  }

  function note(state, message, step = state.steps) {
    state.events.push({ step, message });
  }

  function triggerEvent(state) {
    const cell = state.map.cells[state.position];
    if (state.ticket.rulesVersion >= 4 && cell === 'exit' && state.cargo) {
      state.chestCoins += state.cargo.coins;
      for (const [id, count] of Object.entries(state.cargo.items)) state.chestItems[id] = (state.chestItems[id] || 0) + count;
      const count = state.cargo.count;
      state.delivered += count;
      state.cargo = null;
      state.goal = null;
      const contract = mission(state);
      if (contract?.complete) {
        const reward = Rules.missions[contract.id];
        state.deliveryBonus = { ...reward, coins: Rules.rewardCoins(reward.coins, state.ticket.rulesVersion) };
      }
      state.encounter = { kind: 'exit', position: state.position };
      note(state, `這次送達 ${count} 個寶箱，累計送達 ${state.delivered} 箱！可以帶走獎勵，或冒險繼續尋寶。`);
      return cell;
    }
    if (!['spring', 'chest'].includes(cell) || state.claimed.has(state.position)) return null;
    if (cell === 'chest' && state.position === state.lampSite?.position) {
      state.encounter = { kind: 'lantern', position: state.position };
      note(state, '找到螢火遺跡。可以解下螢火燈，或帶走供桌上的錢袋。');
      return cell;
    }
    state.claimed.add(state.position);
    if (cell === 'spring') {
      state.springs++;
      const healed = Math.min(Rules.difficultyFor(state.map.difficulty, state.map.rulesVersion).springHeal,
        state.ticket.pet.maxStamina - state.stamina);
      state.stamina += healed;
      const ability = Rules.expeditionAbility(state.ticket);
      const courage = ability?.springCourage ? Math.min(ability.springCourage, state.ticket.pet.maxCourage - state.courage) : 0;
      state.courage += courage;
      note(state, `找到恢復泉，體力 +${healed}${courage ? `，${ability.name}讓膽量 +${courage}` : ''}。`);
    } else {
      if (state.ticket.rulesVersion >= 4) {
        const random = Rules.seeded('cargo', state.ticket.eventSeed, state.position);
        const coins = Rules.rewardCoins(12 + Math.floor(random() * 11), state.ticket.rulesVersion);
        const items = { ...(state.cargo?.items || {}) };
        if (random() < .4) {
          const item = Rules.pick(state.ticket.rulesVersion >= 6 ? chestLoot : ['tonic', 'tea', 'treat', 'badge'], random);
          items[item] = (items[item] || 0) + 1;
        }
        state.cargo = { count: (state.cargo?.count || 0) + 1, coins: (state.cargo?.coins || 0) + coins, items };
        state.chests++;
        state.goal = null;
        note(state, `背起價值 ${coins} 金幣的寶箱，現在帶著 ${state.cargo.count} 箱、共 ${state.cargo.coins} 金幣。依照目前目標繼續行動。`);
        return cell;
      }
      if (state.ticket.rulesVersion >= 3) {
        state.encounter = { position: state.position };
        note(state, '發現上鎖的寶箱！要穩拿獎勵，還是冒險破解？');
        return cell;
      }
      state.chests++;
      const random = Rules.seeded('event', state.ticket.eventSeed, state.position);
      const coins = 4 + Math.floor(random() * 7);
      state.chestCoins += coins;
      let text = `打開神秘寶箱，金幣 +${coins}`;
      if (random() < .55) {
        const item = Rules.pick(state.ticket.rulesVersion >= 6 ? Object.keys(Rules.items) : ['tonic', 'tea', 'treat', 'badge'], random);
        state.chestItems[item] = (state.chestItems[item] || 0) + 1;
        text += `、${Rules.items[item].name} ×1`;
      }
      note(state, text + '。');
    }
    return cell;
  }

  function move(state, next, snapshot) {
    const need = Maze.stepCost(state, next.position);
    state.stamina -= need.stamina;
    state.courage -= need.courage;
    state.spentStamina += need.stamina;
    state.spentCourage += need.courage;
    state.position = next.position;
    state.steps++;
    if (state.ticket.rulesVersion >= 6) state.patience = Math.max(0, state.patience - Rules.patiencePerStep);
    state.version++;
    state.pending = null;
    state.recent = [...state.recent.slice(-9), next.position];
    state.visited.add(next.position);
    const distance = state.toTreasure[next.position];
    state.stalled = distance < state.bestDistance ? 0 : state.stalled + 1;
    state.bestDistance = Math.min(distance, state.bestDistance);
    state.cooldown = snapshot?.explored ? (state.ticket.rulesVersion >= 5 ? 2 : state.ticket.rulesVersion >= 2 ? 5 : 2) : Math.max(0, state.cooldown - 1);
    if (snapshot) {
      const goal = snapshot.target;
      if (state.goal?.position !== goal.position || state.goal?.kind !== goal.kind) {
        state.goalUntil = state.steps + 6;
        if (goal.kind === 'chest') state.detours++;
        if (goal.kind === 'chest' || goal.kind === 'spring') state.attempted.add(goal.position);
      }
      state.goal = goal;
      if (snapshot.explored) state.explorations++;
    } else {
      state.goal = null;
    }

    const entered = triggerEvent(state);
    const previousMood = state.mood.key;
    state.mood = Decision.nextMood(state, entered);
    if (previousMood !== state.mood.key) note(state, `情緒變為${Rules.moods[state.mood.key].name}。`);

    state.trace.push([next.position, next.direction, snapshot?.target.kind || 'manual', snapshot?.target.position ?? null,
      snapshot?.mood.key || previousMood, snapshot?.best?.direction || null, Boolean(snapshot?.explored),
      snapshot?.weights.actual || null]);
    if (state.ticket.rulesVersion >= 4 && state.encounter?.kind === 'exit') return;
    if (state.ticket.rulesVersion < 4 && next.position === state.map.treasure) finish(state, true);
    else if (state.stamina <= 0) finish(state, false, '體力耗盡。');
    else if (state.courage <= 0) finish(state, false, '膽量耗盡。');
    else if (state.steps >= Rules.difficulties[state.map.difficulty].limit) finish(state, false, '已達探索步數上限。');
  }

  function execute(state, snapshot, guess = null) {
    if (state.status !== 'active' || !snapshot || snapshot !== state.pending || snapshot.version !== state.version) {
      throw new Error('這一步的決策已失效。');
    }
    if (guess !== null && (!snapshot.chosen || !options(state).some(next => next.direction === guess && !next.issue))) {
      throw new Error('請預測一個可通行的方向。');
    }
    state.pending = null;
    state.actions.push(guess === null ? ['ai'] : ['predict', guess]);
    state.last = { ...snapshot, manual: false, guess };
    if (!snapshot.chosen) {
      state.trace.push([state.position, null, snapshot.target.kind, snapshot.target.position,
        snapshot.mood.key, null, false, snapshot.weights.actual]);
      return finish(state, false, snapshot.failure);
    }
    if (guess !== null) {
      state.attempts++;
      if (guess === snapshot.chosen.direction) state.correct++;
      note(state, guess === snapshot.chosen.direction ? '預測正確！' : `預測落空，實際走向${Rules.directions[snapshot.chosen.direction]}。`, state.steps + 1);
    }
    if (snapshot.explored) note(state, snapshot.reason, state.steps + 1);
    move(state, snapshot.chosen, snapshot);
  }

  function options(state) {
    if (state.encounter) return [];
    return Maze.neighbors(Decision.navigationMap(state), state.position).map(next => ({ ...next, issue: Decision.safety(state, next.position) }));
  }

  function intervene(state, direction) {
    if (state.status !== 'active' || guidanceLeft(state) < Rules.guidance.step) {
      throw new Error(state.ticket.rulesVersion >= 7 ? '引導額度不足。' : '無法再進行干涉。');
    }
    const next = options(state).find(option => option.direction === direction);
    if (!next || next.issue) throw new Error(next?.issue || '這個方向是岩牆或超出地圖。');
    state.interventions++;
    if (state.ticket.rulesVersion >= 7) state.guidanceSpent += Rules.guidance.step;
    state.actions.push(['manual', direction]);
    let guidance = '';
    if (state.ticket.rulesVersion >= 2 && state.ticket.rulesVersion < 7) {
      const cells = state.map.cells.slice();
      cells[state.position] = 'wall';
      const field = Maze.bfs({ ...state.map, cells }, next.position);
      const reachable = state.ticket.rulesVersion >= 4
        ? state.map.exits.some(exit => Number.isFinite(field[exit])) && (state.cargo ||
          state.map.cells.some((cell, index) => cell === 'chest' && !state.claimed.has(index) && Number.isFinite(field[index])))
        : Number.isFinite(field[state.map.treasure]);
      state.blocked = reachable ? { position: state.position, until: state.steps + 5 } : null;
      guidance = state.blocked ? '原位設置路障，接下來 4 步無法通過。' : '這裡需要經過原位才能抵達終點，因此保留回頭路。';
    }
    const reason = `玩家引導向${Rules.directions[direction]}移動一格。${guidance}`;
    state.last = { manual: true, reason, chosen: next, candidates: [] };
    note(state, reason, state.steps + 1);
    move(state, next, null);
  }

  function useItem(state, itemId) {
    const item = Rules.own(Rules.items, itemId) && Rules.items[itemId];
    if (state.status !== 'active' || !item || item.type !== 'adventure' || !(state.bag[itemId] > 0)) {
      throw new Error('沒有可在本場探索使用的這個道具。');
    }
    const cap = item.stat === 'stamina' ? state.ticket.pet.maxStamina : state.ticket.pet.maxCourage;
    const amount = Math.min(item.amount, cap - state[item.stat]);
    if (!amount) throw new Error('能力已滿。');
    state[item.stat] += amount;
    state.bag[itemId]--;
    state.used[itemId] = (state.used[itemId] || 0) + 1;
    state.version++;
    state.pending = null;
    state.actions.push(['item', itemId]);
    note(state, `使用${item.name}，${item.stat === 'stamina' ? '體力' : '膽量'} +${amount}。`);
  }

  function replay(ticket, actions) {
    const state = create(ticket);
    const maxActions = Rules.difficulties[ticket.difficulty].limit * (ticket.rulesVersion >= 4 ? 10 : 1) + 1 +
      (ticket.rulesVersion >= 3 ? Rules.difficulties[ticket.difficulty].chests * (ticket.rulesVersion >= 4 ? 3 : 1) : 0)
      + Object.values(ticket.bag).reduce((total, quantity) => total + quantity, 0);
    if (!Array.isArray(actions) || actions.length > maxActions) throw new Error('無效的操作紀錄。');
    for (const action of actions) applyAction(state, action);
    return state;
  }

  function applyAction(state, action) {
    if (!Array.isArray(action) || state.status !== 'active') throw new Error('無效的探索操作。');
    const [kind, value] = action;
    if (kind === 'ai' && action.length === 1) execute(state, prepare(state));
    else if (kind === 'predict' && action.length === 2 && Rules.own(Rules.directions, value)) execute(state, prepare(state), value);
    else if (kind === 'manual' && action.length === 2 && Rules.own(Rules.directions, value)) intervene(state, value);
    else if (kind === 'item' && action.length === 2 && Rules.own(Rules.items, value)) useItem(state, value);
    else if (kind === 'chest' && action.length === 2) resolveChest(state, value);
    else if (kind === 'exit' && action.length === 2) resolveExit(state, value);
    else if (kind === 'route' && action.length === 2) chooseRoute(state, value);
    else if (kind === 'lantern' && action.length === 2) resolveLantern(state, value);
    else if (kind === 'bridge' && value === 'repair' && action.length === 2) repairBridge(state);
    else throw new Error('不支援的探索操作。');
  }

  function result(state, finishedAt) {
    if (state.status === 'active') throw new Error('冒險仍在進行。');
    const difficulty = Rules.difficulties[state.map.difficulty];
    const success = state.status === 'success';
    const items = { ...state.chestItems };
    if (success) items[difficulty.prize] = (items[difficulty.prize] || 0) + 1;
    const pet = state.ticket.pet;
    const contract = mission(state);
    const bonus = success && contract?.complete ? Rules.missions[contract.id] : { coins: 0, exp: 0 };
    const delivery = state.ticket.rulesVersion >= 4 ? bank(state, !success) : null;
    return {
      id: state.ticket.id, mapId: state.ticket.mapId, petId: pet.id, petName: pet.name, personality: pet.personality,
      result: state.status, failure: state.failure, difficulty: state.map.difficulty, steps: state.steps,
      shortest: state.map.shortest, spentStamina: state.spentStamina, spentCourage: state.spentCourage,
      interventions: state.interventions, attempts: state.attempts, correct: state.correct, explorations: state.explorations,
      coins: delivery ? delivery.coins : state.chestCoins + (success ? difficulty.coins : 0) + bonus.coins,
      exp: delivery ? delivery.exp : (success ? difficulty.exp : Math.min(14, Math.floor(state.steps / 4))) + bonus.exp,
      items: delivery ? delivery.items : items,
      summary: delivery ? `搬起 ${state.chests} 個寶箱，送達 ${state.delivered} 個。` +
        (success ? '已在出口安全收手，領取完整獎勵。' : state.delivered ? '繼續冒險失敗：已送達獎勵保留 50%（各項向下取整），未送達寶箱失去。' : '尚未將寶箱送到出口，沒有帶回獎勵。') :
        `${pet.name}本次隨機改道 ${state.explorations} 次，主動選擇寶箱目標 ${state.detours} 次，打開 ${state.chests} 個寶箱並使用 ${state.springs} 座泉水。` +
        (contract ? `委託「${Rules.missions[contract.id].name}」${success && contract.complete ? '完成，額外獲得 ' + bonus.coins + ' 金幣與 ' + bonus.exp + ' EXP' : '未完成'}。` : ''),
      startedAt: state.ticket.startedAt, finishedAt, ticket: state.ticket, actions: state.actions, trace: state.trace
    };
  }

  function mission(state) {
    const id = state.ticket.mission;
    if (!Rules.own(Rules.missions, id)) return null;
    const limit = state.map.shortest + 8;
    const stamina = Math.ceil(state.ticket.pet.maxStamina * .4);
    const courage = Math.ceil(state.ticket.pet.maxCourage * .5);
    const conditions = {
      courier: { complete: state.steps <= limit, progress: `已走 ${state.steps} / ${limit} 步` },
      collector: { complete: (state.ticket.rulesVersion >= 4 ? state.delivered : state.chests) >= 2,
        progress: state.ticket.rulesVersion >= 4 ? `已送達 ${state.delivered} / 2 個寶箱` : `已開 ${state.chests} / 2 個寶箱` },
      lantern: { complete: Boolean(state.chestItems.fireflyLamp),
        progress: state.chestItems.fireflyLamp ? '螢火燈已送達' : state.cargo?.items.fireflyLamp ? '帶著螢火燈，前往出口' : '尋找地圖上的螢火遺跡' },
      careful: { complete: state.stamina >= stamina && state.courage >= courage,
        progress: `體力 ${state.stamina} / 至少 ${stamina}，膽量 ${state.courage} / 至少 ${courage}` }
    };
    return { id, ...conditions[id] };
  }

  function resolveChest(state, choice) {
    if (state.ticket.rulesVersion >= 4 || state.status !== 'active' || !state.encounter || !['safe', 'risk'].includes(choice)) {
      throw new Error('目前沒有待開啟的寶箱。');
    }
    if (choice === 'risk' && state.stamina <= 6) throw new Error('冒險開箱至少需要 7 點體力。');
    const random = Rules.seeded('chest-choice', state.ticket.eventSeed, state.encounter.position);
    let outcome = '小心打開外層，獲得 8 金幣。';
    if (choice === 'safe') state.chestCoins += 8;
    else if (random() < .6) {
      const item = Rules.pick(state.ticket.rulesVersion >= 6 ? Object.keys(Rules.items) : ['tonic', 'tea', 'treat', 'badge'], random);
      state.chestCoins += 18;
      state.chestItems[item] = (state.chestItems[item] || 0) + 1;
      outcome = `破解成功！獲得 18 金幣與${Rules.items[item].name} ×1。`;
      state.mood = { key: 'curious', remaining: 4 };
    } else {
      state.stamina -= 6;
      state.spentStamina += 6;
      outcome = '觸發小陷阱！損失 6 體力，這個寶箱沒有獎勵。';
      state.mood = { key: 'nervous', remaining: 3 };
    }
    state.chests++;
    state.encounter = null;
    state.pending = null;
    state.version++;
    state.actions.push(['chest', choice]);
    state.chestOutcome = outcome;
    state.chestOutcomeAt = state.steps;
    note(state, outcome);
  }

  function bank(state, reduced = false) {
    if (!state.delivered) return { coins: 0, exp: 0, items: {} };
    const difficulty = Rules.difficulties[state.map.difficulty];
    const fraction = reduced ? .5 : 1;
    const items = { ...state.chestItems };
    const prize = state.map.difficulty === 'expert' ? Rules.pick(['staminaSeed','courageSeed','badge'],
      Rules.seeded('expert-prize', state.ticket.mapSeed, state.ticket.decisionSeed)) : difficulty.prize;
    items[prize] = (items[prize] || 0) + 1;
    for (const id of Object.keys(items)) {
      if (id === 'fireflyLamp') continue;
      items[id] = Math.floor(items[id] * fraction);
      if (!items[id]) delete items[id];
    }
    return { coins: Math.floor((state.chestCoins + Rules.rewardCoins(difficulty.coins, state.ticket.rulesVersion) +
      (state.deliveryBonus?.coins || 0)) * fraction),
      exp: Math.floor((difficulty.exp + (state.deliveryBonus?.exp || 0)) * fraction), items };
  }

  function canContinue(state) {
    return state.stamina > 1 && state.courage > 0 && state.steps < Rules.difficulties[state.map.difficulty].limit &&
      state.map.cells.some((cell, index) => cell === 'chest' && !state.claimed.has(index));
  }

  function resolveExit(state, choice) {
    if (state.ticket.rulesVersion < 4 || state.status !== 'active' || state.encounter?.kind !== 'exit' ||
        !['cashout', 'continue'].includes(choice)) throw new Error('目前沒有出口抉擇。');
    if (choice === 'continue' && !canContinue(state)) throw new Error('沒有剩餘寶箱或資源不足，請帶走獎勵。');
    state.actions.push(['exit', choice]);
    state.encounter = null;
    state.version++;
    state.pending = null;
    state.goal = null;
    state.intent = 'auto';
    if (choice === 'cashout') finish(state, true);
    else note(state, '決定繼續冒險。若之後失敗，已送達獎勵只保留 50%，未送達寶箱會失去。');
  }

  function chooseRoute(state, choice) {
    if (state.ticket.rulesVersion < 4 || state.status !== 'active' || state.encounter ||
        !['auto', 'collect', 'exit', 'lantern'].includes(choice) || choice === state.intent ||
        (choice === 'exit' && !state.cargo)) throw new Error('目前不能變更搬運目標。');
    if (choice === 'lantern' && (!state.lampSite || state.claimed.has(state.lampSite.position))) throw new Error('目前沒有可探索的螢火遺跡。');
    if (choice === 'collect' && !canContinue(state)) throw new Error('沒有剩餘寶箱或資源不足，請前往出口。');
    if (state.ticket.rulesVersion >= 7 && choice !== 'auto') {
      if (guidanceLeft(state) < Rules.guidance.goal) throw new Error('指定目標需要 3 點引導點。');
      if (choice === 'lantern' && !prepare(state)?.lanternReachable) throw new Error('現有資源無法走到螢火遺跡。');
      state.guidanceSpent += Rules.guidance.goal;
    }
    state.actions.push(['route', choice]);
    state.intent = choice;
    state.goal = null;
    state.pending = null;
    state.version++;
    note(state, choice === 'auto' ? '玩家恢復寵物自主判斷。' : choice === 'collect' ? '玩家要求繼續搜寶，直到改變指令或抵達出口。'
      : choice === 'lantern' ? '玩家指定前往螢火遺跡。' : `玩家要求將身上的 ${state.cargo.count} 個寶箱帶到出口。`);
  }

  function resolveLantern(state, choice) {
    if (state.status !== 'active' || state.encounter?.kind !== 'lantern' || !['lamp', 'coins'].includes(choice)) {
      throw new Error('目前沒有螢火遺跡的選擇。');
    }
    const lamp = choice === 'lamp';
    if (lamp && state.stamina <= 3) throw new Error('解下螢火燈需要 3 體力，且至少保留 1 點。');
    const items = { ...state.cargo?.items };
    if (lamp) {
      state.stamina -= 3;
      state.spentStamina += 3;
      items.fireflyLamp = 1;
    }
    state.cargo = { count: (state.cargo?.count || 0) + 1,
      coins: (state.cargo?.coins || 0) + (lamp ? 0 : Rules.rewardCoins(28, state.ticket.rulesVersion)), items };
    state.chests++;
    state.claimed.add(state.position);
    state.encounter = null;
    state.intent = 'auto';
    state.goal = null;
    state.pending = null;
    state.version++;
    state.actions.push(['lantern', choice]);
    note(state, lamp ? '解下螢火燈。送到出口後就會成為小屋的紀念品。' :
      `帶走 ${Rules.rewardCoins(28, state.ticket.rulesVersion)} 金幣的錢袋，送到出口才算入帳。`);
  }

  function canRepairBridge(state) {
    return state.status === 'active' && state.lampSite?.position === state.position &&
      ['swamp', 'wall'].includes(state.map.cells[state.lampSite.bridge]) && guidanceLeft(state) > 0 &&
      (!state.encounter || state.encounter.kind === 'lantern');
  }

  function repairBridge(state) {
    if (!canRepairBridge(state)) throw new Error('必須在遺跡旁，並保留 1 點引導點。');
    const cells = state.map.cells.slice();
    cells[state.lampSite.bridge] = 'ground';
    state.map = { ...state.map, cells };
    state.guidanceSpent += Rules.guidance.step;
    state.pending = null;
    state.version++;
    state.actions.push(['bridge', 'repair']);
    note(state, '花 1 點引導點架起便橋，現在可從標記的格子通過。');
  }

  return { create, prepare, forecast, execute, options, intervene, useItem, replay, applyAction, result, mission, resolveChest, resolveExit, bank, canContinue, chooseRoute, guidanceLeft, resolveLantern, canRepairBridge, repairBridge };
})();
