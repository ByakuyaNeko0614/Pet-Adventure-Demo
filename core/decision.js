'use strict';

var Decision = (() => {
  function navigationMap(state) {
    if (!state.blocked || state.steps >= state.blocked.until) return state.map;
    const cells = state.map.cells.slice();
    cells[state.blocked.position] = 'wall';
    return { ...state.map, cells };
  }
  function nextMood(state, entered) {
    if (entered === 'spring') return { key: 'normal', remaining: 3 };
    if (entered === 'chest') return { key: 'curious', remaining: 4 };
    if (state.mood.remaining > 1) return { ...state.mood, remaining: state.mood.remaining - 1 };

    const pet = state.ticket.pet;
    const type = Rules.personalities[pet.personality];
    const random = Rules.seeded('mood', state.ticket.decisionSeed, state.steps);
    const duration = 3 + Math.floor(random() * 3);
    const threats = Maze.neighbors(state.map, state.position).filter(next => dangerous(state, next.position)).length;
    const roll = random();
    let key = 'normal';
    if (state.stamina / pet.maxStamina <= .38) key = 'tired';
    else if (threats && roll < type.threat + (state.courage / pet.maxCourage < .4 ? .18 : 0)) key = 'nervous';
    else if (pet.personality === 'impatient' && roll < .23) key = 'impulsive';
    else if (roll < .12 + type.curiosity * .25 + pet.traits.curiosity * .12) key = 'curious';
    return { key, remaining: duration };
  }

  function dangerous(state, position) {
    return ['forest', 'swamp'].includes(state.map.cells[position]);
  }

  function safety(state, position) {
    const need = Maze.stepCost(state, position);
    const cell = state.map.cells[position];
    const restores = cell === 'spring' && !state.claimed.has(position);
    const delivers = state.ticket.rulesVersion >= 4 && cell === 'exit' && state.cargo;
    if (need.stamina > state.stamina || (need.stamina === state.stamina && !restores && cell !== 'treasure' && !delivers)) {
      return '體力不足';
    }
    if (need.courage > 0 && need.courage >= state.courage) return '膽量不足';
    return '';
  }

  const goal = (kind, position, reason) => ({ kind, position, reason });

  // Selector: each child returns a goal or falls through to the next child.
  const tree = [
    ({ state }) => state.stalled >= 7 && goal('direct', state.map.treasure, '連續 7 步未縮短與終點的距離，優先脫離徘徊。'),
    ({ state, events, pet }) => {
      if (state.stamina / pet.maxStamina > .56) return null;
      const spring = events('spring', Math.min(8, state.stamina));
      return spring && goal('spring', spring.position, '體力偏低，附近有尚未使用的恢復泉。');
    },
    ({ state, events, pet, random, type, mood }) => {
      if (state.stamina < pet.maxStamina * .40 || state.detours >= 2 && state.goal?.kind !== 'chest') return null;
      const range = Math.min(7, Math.max(2, Math.floor((state.ticket.rulesVersion >= 6 ? state.patience : pet.patience) / 4) + (state.mood.key === 'curious' ? 1 : 0)));
      const chest = events('chest', range);
      if (!chest) return null;
      const keep = state.goal?.position === chest.position && (state.ticket.rulesVersion >= 2 || state.goalUntil > state.steps);
      const missionInterest = state.ticket.mission === 'collector' ? .2 : state.ticket.mission === 'courier' ? -.08 : 0;
      const curiosity = Rules.clamp(type.curiosity + mood.curiosity + (pet.traits.curiosity - .5) * .30 + missionInterest, 0, .90);
      return (keep || random() < curiosity) && goal('chest', chest.position,
        keep ? '延續前往寶箱的目標。' : '性格、個體好奇心與目前情緒觸發了寶箱探索。');
    },
    ({ state }) => state.mood.key === 'nervous' && goal('safe', state.map.treasure, '緊張時加重危險地形的成本，沿較安全路線尋寶。'),
    ({ state }) => goal('treasure', state.map.treasure, '沿路前往終點寶藏。')
  ];

  function weights(state, random) {
    const pet = state.ticket.pet;
    const personality = Rules.personalities[pet.personality];
    const mood = Rules.moods[state.mood.key];
    const factors = [1.14 - (state.ticket.rulesVersion >= 6 ? state.patience : pet.patience) / 120, 1 + (.5 - pet.traits.riskTolerance) * .22,
      1 + (.5 - pet.traits.riskTolerance) * .35];
    const base = personality.weights.map((weight, index) => weight * mood.weights[index] * factors[index]);
    const variation = personality.jitter * (state.ticket.rulesVersion >= 2 ? .5 : 1);
    return { base, actual: base.map(weight => weight * (1 + (random() * 2 - 1) * variation)) };
  }

  function plan(state) {
    if (state.ticket.rulesVersion >= 4) return deliveryPlan(state);
    const { position, version, mood } = state;
    const map = navigationMap(state);
    const revised = state.ticket.rulesVersion >= 2;
    const pet = state.ticket.pet;
    const type = Rules.personalities[pet.personality];
    const random = Rules.seeded('decision', state.ticket.decisionSeed, version);
    const available = Maze.neighbors(map, position);
    const distances = Maze.bfs(map, position);
    const events = (kind, range) => map.cells.map((cell, index) => ({ cell, position: index, distance: distances[index] }))
      .filter(entry => entry.cell === kind && entry.distance > 0 && entry.distance <= range
        && !state.claimed.has(entry.position) && (!state.attempted.has(entry.position) ||
          (state.goal?.position === entry.position && (revised || state.goalUntil > state.steps))))
      .sort((a, b) => {
        if (revised && state.goal?.position === a.position) return -1;
        if (revised && state.goal?.position === b.position) return 1;
        return a.distance - b.distance;
      })[0];
    const selectedGoal = tree.reduce((selected, node) =>
      selected || node({ state, events, pet, type, mood: Rules.moods[mood.key], random }), null);
    const weightSet = weights(state, random);
    const [distanceWeight, staminaWeight, courageWeight] = weightSet.actual;
    const enterCost = target => {
      const cost = Maze.cost(map, target);
      const revisits = state.recent.filter(cell => cell === target).length;
      const backtrack = state.recent[state.recent.length - 2] === target ? 2.4 + pet.traits.stubbornness * 3 : 0;
      return distanceWeight + staminaWeight * cost.stamina + courageWeight * cost.courage
        + revisits * 2.25 + backtrack + (mood.key === 'nervous' && dangerous(state, target) ? 1.4 : 0);
    };

    function route(target) {
      const field = Maze.dijkstra(map, target.position, enterCost, position);
      return available.map(next => {
        const issue = safety(state, next.position);
        const cost = enterCost(next.position) + field[next.position];
        return { ...next, terrain: map.cells[next.position], cost: Number.isFinite(cost) ? cost : null,
          issue: issue || (Number.isFinite(cost) ? '' : '需要折返才有通往目標的路') };
      });
    }

    let target = selectedGoal;
    let candidates = route(target);
    if (!candidates.some(candidate => !candidate.issue) && target.position !== map.treasure) {
      target = goal('treasure', map.treasure, '支線沒有安全的下一步，改走終點。');
      candidates = route(target);
    }
    let ranked = candidates.filter(candidate => !candidate.issue).sort((a, b) => a.cost - b.cost);
    if (target.kind === 'direct') {
      const nearer = ranked.filter(candidate => state.toTreasure[candidate.position] < state.toTreasure[position]);
      if (nearer.length) {
        for (const candidate of ranked) {
          if (!nearer.includes(candidate)) candidate.issue = '停滯保護優先接近終點';
        }
        ranked = nearer;
      }
    }
    const best = ranked[0];
    const goalDistances = Maze.bfs(map, target.position);
    const alternatives = best ? ranked.slice(1).filter(candidate =>
      candidate.cost <= best.cost * 1.16 + 1 && candidate.position !== state.recent[state.recent.length - 2]
      && state.recent.slice(-5).filter(cell => cell === candidate.position).length < 2
      && (!(pet.personality === 'timid' || mood.key === 'nervous') || !dangerous(state, candidate.position))
      && (!revised || (!state.visited.has(candidate.position)
        && goalDistances[candidate.position] < goalDistances[position]
        && Maze.cost(map, candidate.position).stamina <= Maze.cost(map, best.position).stamina
        && Maze.cost(map, candidate.position).courage <= Maze.cost(map, best.position).courage))) : [];
    const epsilon = Rules.clamp(type.epsilon * Rules.moods[mood.key].epsilon *
      (1 + (pet.traits.curiosity - pet.traits.stubbornness) * .25) * (revised ? .3 : 1), 0, revised ? .1 : .35);
    const explored = Boolean(alternatives.length && target.kind !== 'direct' && state.cooldown === 0 && random() < epsilon);
    const chosen = explored ? Rules.pick(alternatives, random) : best;
    const direction = name => Rules.directions[name];
    const failure = !chosen && failureReason(candidates);
    const reason = !chosen ? failure : explored
      ? `原先成本最低的方向是${direction(best.direction)}，這次在合理範圍內改走${direction(chosen.direction)}。`
      : target.kind === 'direct'
        ? `優先接近終點，在符合進度與資源條件的方向中選擇${direction(chosen.direction)}。`
        : `以地形消耗、距離與近期足跡計算，${direction(chosen.direction)}的可行路線成本最低。`;

    let thought = failure || '';
    if (chosen) {
      const destinations = { spring: '喝泉水補充體力', chest: '打開那個寶箱', direct: '趕快接近終點', safe: '安全地找到寶藏', treasure: '找到終點寶藏' };
      const need = Maze.cost(map, chosen.position);
      const other = ranked.find(candidate => candidate !== chosen);
      thought = `我想先${destinations[target.kind]}，目前至少還要走 ${goalDistances[position]} 格。`;
      if (chosen.position === state.recent[state.recent.length - 2]) {
        thought += ranked.length === 1 ? '這裡只有回頭這條路能通往目標，我得先退回去。' : '我選擇回頭，因為往回走的整段路線成本較低。';
      } else if (explored) {
        thought += `我突然想試試${direction(chosen.direction)}，這格還沒走過，而且也更靠近目標。`;
      } else if (other && dangerous(state, other.position) && !dangerous(state, chosen.position)) {
        thought += `${direction(other.direction)}是${Rules.terrain[other.terrain].name}，我選${direction(chosen.direction)}的${Rules.terrain[chosen.terrain].name}，整段路也比較划算。`;
      } else {
        thought += `我打算往${direction(chosen.direction)}走，${ranked.length === 1 ? '這是目前唯一能通往目標的方向' : '這條路把路程和消耗一起算進去最划算'}。`;
      }
      thought += `下一格會花 ${need.stamina} 體力${need.courage ? '和 ' + need.courage + ' 膽量' : ''}，我還有 ${state.stamina} 體力、${state.courage} 膽量。`;
      if (state.blocked && state.steps < state.blocked.until) thought += '我記得你的引導，暫時不走回路障那格。';
    }
    return { version, position, target, mood: { ...mood }, weights: weightSet, candidates, thought,
      chosen: chosen || null, best: best || null, explored, epsilon, reason, failure: failure || null };
  }

  function failureReason(candidates) {
    const onward = candidates.filter(next => next.cost !== null);
    const usableStamina = onward.filter(next => next.issue !== '體力不足');
    if (onward.length && !usableStamina.length) return '體力耗盡，無法安全踏出下一步。';
    if (usableStamina.length && usableStamina.every(next => next.issue === '膽量不足')) {
      return '膽量耗盡，無法通過必要的森林地形。';
    }
    return '目前沒有資源可負擔的通往終點路線。';
  }

  // Resource-constrained shortest paths. Keep non-dominated labels so a slightly
  // longer route which saves courage is not discarded in favour of an unusable one.
  function affordableRoutes(state, map, actual, stopAtChests = false) {
    const labels = map.cells.map(() => []);
    const root = { position: state.position, stamina: 0, courage: 0, cost: 0, path: [] };
    labels[root.position].push(root);
    const queue = [root];
    while (queue.length) {
      queue.sort((a, b) => b.cost - a.cost);
      const current = queue.pop();
      if (!labels[current.position].includes(current)) continue;
      const cell = map.cells[current.position];
      if (current.path.length && ((cell === 'spring' && !state.claimed.has(current.position)) ||
          (stopAtChests && cell === 'chest' && !state.claimed.has(current.position)) ||
          (cell === 'exit' && state.cargo))) continue;
      for (const next of Maze.neighbors(map, current.position)) {
        const need = Maze.stepCost(state, next.position, map);
        const stamina = current.stamina + need.stamina;
        const courage = current.courage + need.courage;
        const restores = map.cells[next.position] === 'spring' && !state.claimed.has(next.position);
        const delivers = map.cells[next.position] === 'exit' && state.cargo;
        if (stamina > state.stamina || (stamina === state.stamina && !restores && !delivers) || courage >= state.courage) continue;
        const cost = current.cost + actual[0] + actual[1] * need.stamina + actual[2] * need.courage;
        const existing = labels[next.position];
        if (existing.some(label => label.cost <= cost && label.stamina <= stamina && label.courage <= courage)) continue;
        const label = { ...next, stamina, courage, cost, path: [...current.path, next] };
        labels[next.position] = existing.filter(old => !(cost <= old.cost && stamina <= old.stamina && courage <= old.courage));
        labels[next.position].push(label);
        queue.push(label);
      }
    }
    return labels.map(entries => entries.sort((a, b) => a.cost - b.cost)[0] || null);
  }

  // With no complete route, approach a real destination instead of spending
  // the last resources walking back and forth. A partial route keeps its goal.
  function approach(state, map, kind) {
    const tile = kind === 'lantern' ? 'chest' : kind;
    const [distance, stamina, courage] = Rules.personalities[state.ticket.pet.personality].weights;
    const enterCost = position => {
      const need = Maze.stepCost(state, position, map);
      return distance + stamina * need.stamina + courage * need.courage;
    };
    const neighbors = Maze.neighbors(map, state.position);
    const candidates = [];
    for (const [position, cell] of map.cells.entries()) {
      if (cell !== tile || position === state.position || state.claimed.has(position) ||
        (kind === 'lantern' && position !== state.lampSite?.position)) continue;
      const field = Maze.dijkstra(map, position, enterCost);
      if (!Number.isFinite(field[state.position])) continue;
      const forward = neighbors.filter(step => field[step.position] < field[state.position])
        .sort((a, b) => enterCost(a.position) + field[a.position] - enterCost(b.position) - field[b.position]);
      candidates.push({position, distance:field[state.position],
        first:forward.find(step => !safety(state, step.position)),
        shortage:safety(state, forward[0]?.position ?? position)});
    }
    candidates.sort((a, b) => a.distance - b.distance || a.position - b.position);
    return candidates.find(entry => state.goal?.kind === kind && entry.position === state.goal.position) ||
      candidates.find(entry => entry.first) || candidates[0];
  }

  function deliveryPlan(state) {
    const map = navigationMap(state);
    // Stable personality preferences avoid oscillation when mood changes en route.
    const weightSet = weights({ ...state, mood: { key: 'normal' } }, () => .5);
    const routes = affordableRoutes(state, map, weightSet.actual);
    const destinations = kind => map.cells.map((cell, position) => ({ cell, position, route: routes[position] }))
      .filter(entry => entry.cell === kind && entry.route?.path.length && !state.claimed.has(entry.position))
      .sort((a, b) => a.route.cost - b.route.cost || a.position - b.position);
    const pet = state.ticket.pet;
    const chests = destinations('chest');
    const lantern = chests.find(entry => entry.position === state.lampSite?.position);
    const exits = destinations('exit');
    const springs = destinations('spring');
    const committed = (entries, kind) => entries.find(entry => entry.position === state.goal?.position && state.goal.kind === kind) || entries[0];
    const select = (entry, kind, why) => ({ entry, kind, why });
    const returnHome = why => select(committed(exits, 'exit'), 'exit', why);
    const carryingLimit = { timid: 1, steady: 2, impatient: 2, adventurous: 3 }[pet.personality];
    const reserve = Math.ceil(pet.maxStamina * ({ timid: .25, steady: .18, impatient: .12, adventurous: .08 }[pet.personality]));
    function returnFrom(chest) {
      const after = { ...state, position: chest.position, stamina: state.stamina - chest.route.stamina,
        cargo: { ...state.cargo, count: (state.cargo?.count || 0) + 1 },
        courage: state.courage - chest.route.courage };
      const onward = affordableRoutes(after, map, weightSet.actual, Boolean(map.rulesVersion));
      const home = state.map.exits.map(exit => onward[exit]).filter(Boolean).sort((a, b) => a.cost - b.cost)[0];
      return {after, home};
    }
    function firstChest() {
      const closest = committed(chests, 'chest');
      if (map.rulesVersion >= 10 && state.goal?.kind !== 'chest') {
        const viable = chests.find(chest => returnFrom(chest).home);
        if (viable) return select(viable, 'chest', '先找一箱能負擔來回體力的寶箱。');
      }
      return select(closest, 'chest', '我還沒有寶箱，先找一個走得到的寶箱。');
    }
    function nextChestWithReturn() {
      const preferred = committed(chests, 'chest');
      const ordered = preferred ? [preferred, ...chests.filter(entry => entry !== preferred)] : [];
      const range = Rules.extraChestRange(pet, state.ticket.rulesVersion >= 6 ? state.patience : pet.patience);
      for (const chest of ordered) {
        if (chest.route.path.length > range) continue;
        const {after, home} = returnFrom(chest);
        if (home && after.stamina - home.stamina >= reserve && after.courage - home.courage >= 2) {
          return select(chest, 'chest', `我現在帶著 ${state.cargo.count} 箱，${Rules.personalities[pet.personality].name}的我想再多帶一些。下一箱還有 ${chest.route.path.length} 格，之後回出口 ${home.path.length} 格，預計還能留 ${after.stamina - home.stamina} 體力。`);
        }
      }
      return null;
    }

    // Selector nodes are ordered: player command, committed retreat, resource
    // pressure, personality appetite, affordable round trip, then safe return.
    const deliveryTree = [
      () => state.intent === 'exit' && state.cargo && returnHome('你要求我前往出口，我會優先把身上的寶箱送回去。'),
      () => state.intent === 'lantern' && lantern && select(lantern, 'lantern', '你指定了螢火遺跡，我會朝地圖上的燈走。'),
      () => state.intent === 'collect' && (chests.length
        ? select(committed(chests, 'chest'), 'chest', '你要求我繼續搜寶，我會帶著現有寶箱去找下一箱。')
        : state.cargo && returnHome('已沒有能走到的下一箱，先把身上的寶箱送回去。')),
      () => !state.cargo && firstChest(),
      () => state.goal?.kind === 'exit' && returnHome('我已決定撤離，會持續朝出口走，不會中途反覆改變目標。'),
      () => (state.stamina < pet.maxStamina * .35 || state.courage < pet.maxCourage * .3) &&
        returnHome('體力或膽量偏低，身上的寶箱比下一箱更重要，我想先撤離。'),
      () => state.cargo.count >= carryingLimit && returnHome(`我已帶著 ${state.cargo.count} 箱，達到${Rules.personalities[pet.personality].name}這次願意承擔的數量，先送到出口。`),
      () => nextChestWithReturn(),
      () => returnHome('下一箱太遠，或收集後的回程餘裕不足，我想先保住身上的寶箱。')
    ];
    const selectedGoal = deliveryTree.reduce((selection, node) => selection || node(), null);
    let selected = selectedGoal.entry;
    let targetKind = selectedGoal.kind;
    let why = selectedGoal.why;
    const committedSpring = springs.find(entry => state.goal?.kind === 'spring' && entry.position === state.goal.position);
    const courageSpring = state.intent === 'auto' && (!state.cargo || !exits.length) &&
      Rules.expeditionAbility(state.ticket)?.springCourage && state.courage < pet.maxCourage * .3 &&
      springs.find(entry => entry.route.path.length <= 5 && entry.route.courage === 0);
    if (committedSpring || !selected || courageSpring || (state.stamina < pet.maxStamina * .4 && springs[0]?.route.path.length <= 5)) {
      const spring = committedSpring || courageSpring || springs[0];
      if (spring) {
        selected = spring;
        targetKind = 'spring';
        why = spring === courageSpring ? '我能在泉水邊恢復膽量，先去那裡。' :
          '目前需要補充體力，我先去這座還沒用過的泉水，再繼續原本的任務。';
      }
    }
    const staged = state.ticket.rulesVersion >= 12;
    let partial = false;
    let shortage = '';
    if (staged && !selected) {
      if (!state.cargo && state.intent === 'lantern') targetKind = 'lantern';
      const nearby = approach(state, map, targetKind);
      shortage = nearby?.shortage || '';
      if (nearby?.first) {
        const step = nearby.first;
        const need = Maze.stepCost(state, step.position, map);
        selected = {position:nearby.position, route:{...need, cost:weightSet.actual[0] +
          weightSet.actual[1] * need.stamina + weightSet.actual[2] * need.courage, path:[step]}};
        partial = true;
        why = '我還能往目標走一格，但目前的資源可能走不完整段。';
      }
    }
    let route = selected?.route;
    let first = route?.path[0];
    let explored = false;
    const routeFlex = state.ticket.rulesVersion >= 10 ? 1 + (.5 - pet.traits.stubbornness) * .8 : 1;
    const epsilon = state.ticket.rulesVersion >= 5 ? routeFlex * { timid: .25, steady: .35, impatient: .45, adventurous: .6 }[pet.personality] : 0;
    const random = Rules.seeded('delivery-detour', state.ticket.decisionSeed, state.version);
    if (first && !partial && epsilon && !state.cooldown && random() < epsilon) {
      const distances = Maze.bfs(map, selected.position);
      const alternatives = [];
      for (const next of Maze.neighbors(map, state.position)) {
        if (next.position === first.position || state.visited.has(next.position) || safety(state, next.position) ||
            distances[next.position] >= distances[state.position] || ['spring', 'chest', 'exit'].includes(map.cells[next.position])) continue;
        const need = Maze.stepCost(state, next.position, map);
        const after = { ...state, position: next.position, stamina: state.stamina - need.stamina, courage: state.courage - need.courage };
        const onward = affordableRoutes(after, map, weightSet.actual)[selected.position];
        if (!onward) continue;
        const cost = onward.cost + weightSet.actual[0] + weightSet.actual[1] * need.stamina + weightSet.actual[2] * need.courage;
        if (cost <= route.cost * 1.3 && onward.stamina + need.stamina <= route.stamina + 2 && onward.courage + need.courage <= route.courage) {
          alternatives.push({ cost, stamina: onward.stamina + need.stamina, courage: onward.courage + need.courage, path: [next, ...onward.path] });
        }
      }
      if (alternatives.length) {
        route = Rules.pick(alternatives, random);
        first = route.path[0];
        explored = true;
        why = '我想試試另一條沒走過的路，它仍然更靠近目標，而且整段路的資源足夠。' + why;
      }
    }
    const candidates = Maze.neighbors(map, state.position).map(next => ({ ...next, terrain: map.cells[next.position],
      cost: first?.position === next.position ? route.cost : null,
      issue: safety(state, next.position) || (first?.position === next.position ? '' : '目前搬運路線不經過這格') }));
    const chosen = candidates.find(next => next.position === first?.position) || null;
    const failure = staged ? (shortage ? `往目標前進的下一格${shortage}，需要先補給。` : '目前沒有可前往的目標。') :
      '剩餘體力或膽量不足以走完通往寶箱、出口或未使用泉水的路線。可先暫停使用補給；繼續則結束冒險。';
    const destination = targetKind === 'lantern' ? '前往螢火遺跡' : targetKind === 'exit' ? `把背上的 ${state.cargo.count} 個寶箱送到出口` : targetKind === 'spring' ? '先喝泉水補充體力'
      : state.cargo ? `帶著 ${state.cargo.count} 個寶箱，繼續找下一箱` : '先找到一個寶箱';
    const returnRisk = staged && (
      (Boolean(state.cargo) && !exits.length) ||
      (['chest', 'lantern'].includes(targetKind) && Boolean(chosen) &&
        (partial || !returnFrom({...selected, route}).home)));
    const reason = !chosen ? failure : partial ? '這一步還走得動，先往目標靠近。' :
      (staged ? `到目前目標需要 ${route.stamina} 體力、${route.courage} 膽量，現有資源足夠。` :
        `整段路需要 ${route.stamina} 體力、${route.courage} 膽量，現有資源足夠；維持目標直到抵達。`);
    const need = chosen && Maze.stepCost(state, chosen.position, map);
    const thought = chosen && partial ? (returnRisk ? '可能回不去……' : '') + why :
      chosen ? (returnRisk ? '以目前的資源可能回不去……' : '') + why +
      `接著${destination}（還有 ${route.path.length} 格）。整段需要 ${route.stamina} 體力、${route.courage} 膽量；現有體力 ${state.stamina}、膽量 ${state.courage}。下一步${Rules.directions[chosen.direction]}，消耗 ${need.stamina} 體力${need.courage ? '、' + need.courage + ' 膽量' : ''}。` +
      (state.blocked && state.steps < state.blocked.until ? '我記得你的引導，暫時不走回路障那格。' : '') : failure;
    return { version: state.version, position: state.position, target: goal(targetKind, selected?.position ?? state.position, reason),
      mood: { ...state.mood }, weights: weightSet, candidates, chosen, best: chosen, explored, epsilon,
      thought, reason, failure: chosen ? null : failure, lanternReachable: Boolean(lantern),
      ...(staged ? {returnRisk, shortage:chosen ? '' : shortage} : {}) };
  }

  return { nextMood, safety, weights, plan, navigationMap };
})();
