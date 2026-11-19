'use strict';

var Maze = (() => {
  function neighbors(map, position) {
    const { size, cells } = map;
    const x = position % size;
    const y = Math.floor(position / size);
    const adjacent = [];
    if (y > 0) adjacent.push({ direction: 'up', position: position - size });
    if (x < size - 1) adjacent.push({ direction: 'right', position: position + 1 });
    if (position + size < cells.length) adjacent.push({ direction: 'down', position: position + size });
    if (x > 0) adjacent.push({ direction: 'left', position: position - 1 });
    return adjacent.filter(next => cells[next.position] !== 'wall');
  }

  // 從起點逐層搜尋。每格走一步，結果用來比較距離與檢查連通性。
  function bfs(map, start) {
    const distances = Array(map.cells.length).fill(Infinity);
    const queue = [start];
    distances[start] = 0;
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const next of neighbors(map, current)) {
        if (distances[next.position] !== Infinity) continue;
        distances[next.position] = distances[current] + 1;
        queue.push(next.position);
      }
    }
    return distances;
  }

  // 從目的地反向算路徑。前一格必須付出進入目前格子的地形成本。
  function dijkstra(map, target, enterCost, excluded = -1) {
    const distances = Array(map.cells.length).fill(Infinity);
    const settled = new Set();
    distances[target] = 0;
    for (let step = 0; step < map.cells.length; step++) {
      let current = -1;
      let best = Infinity;
      for (let index = 0; index < distances.length; index++) {
        if (distances[index] < best && !settled.has(index)) {
          current = index;
          best = distances[index];
        }
      }
      if (current < 0) break;
      settled.add(current);
      const through = best + enterCost(current);
      for (const next of neighbors(map, current)) {
        if (next.position === excluded || settled.has(next.position)) continue;
        if (through < distances[next.position]) distances[next.position] = through;
      }
    }
    return distances;
  }

  function generate(seed, difficulty, rulesVersion = Rules.version) {
    if (!Rules.own(Rules.difficulties, difficulty) || (difficulty === 'expert' && rulesVersion < 11)) throw new Error('無效的難度。');
    const size = rulesVersion >= 7 ? Rules.wideSize : Rules.size;
    const rows = rulesVersion >= 7 ? 8 : size;
    const config = Rules.difficultyFor(difficulty, rulesVersion);
    const random = Rules.seeded('map', seed, difficulty);
    const cells = Array.from({ length: size * rows }, () => {
      const roll = random();
      if (roll < config.walls) return 'wall';
      if (roll < config.walls + config.swamp) return 'swamp';
      if (roll < config.walls + config.swamp + config.forest) return 'forest';
      return 'ground';
    });
    const start = Math.floor(random() * 3);
    const treasure = cells.length - 1 - Math.floor(random() * 3);
    const layoutVersion = Rules.mapVersion(difficulty, rulesVersion);
    const map = { seed, difficulty, size, start, treasure, cells, ...(layoutVersion ? { rulesVersion: layoutVersion } : {}) };

    // 先打通起點到寶藏的路，再保留種子決定的岔路與地形。
    let x = start;
    let y = 0;
    const endX = treasure % size;
    while (x < endX || y < rows - 1) {
      if (y === rows - 1 || (x < endX && random() < .5)) x++;
      else y++;
      const index = y * size + x;
      if (cells[index] === 'wall' || (difficulty === 'easy' && random() < .70)) cells[index] = 'ground';
    }
    cells[map.start] = 'start';
    cells[map.treasure] = 'treasure';
    const distances = bfs(map, map.start);
    if (!Number.isFinite(distances[map.treasure])) throw new Error('迷宮連通性驗證失敗。');

    const boundary = index => index < size || index >= size * (rows - 1) ||
      index % size === 0 || index % size === size - 1;
    const exits = [treasure];
    if (rulesVersion >= 8) {
      // Reserve the exits before distributing resources. The carved route
      // guarantees eligible interior cells if the far boundary is sparse.
      const eligible = cells.flatMap((_, index) =>
        index !== treasure && Number.isFinite(distances[index]) && distances[index] >= config.minExit
          ? [index] : []);
      const edge = eligible.filter(boundary);
      const fromExit = bfs(map, treasure);
      const candidates = edge.length ? edge : eligible;
      candidates.sort((a, b) => fromExit[b] - fromExit[a] || a - b);
      exits.push(candidates[0]);
      for (const exit of exits) cells[exit] = 'exit';
    }
    const open = cells.map((_, index) => index).filter(index =>
      !exits.includes(index) && distances[index] >= 3 && Number.isFinite(distances[index]));
    const place = (pool, kind, count) => {
      for (let number = 0; number < count; number++) {
        const index = Math.floor(random() * pool.length);
        cells[pool.splice(index, 1)[0]] = kind;
      }
    };
    if (config.cargoCost) {
      const fields = exits.map(exit => bfs(map, exit));
      const remote = open.filter(index => distances[index] >= config.minChest &&
        fields.every(field => field[index] >= config.chestFromExit));
      place(remote.length >= config.chests ? remote : open, 'chest', config.chests);
      // Put scarce water beyond the starting area, near the routes players actually take.
      const remaining = open.filter(index => cells[index] !== 'chest');
      const midfield = remaining.filter(index => distances[index] >= config.minChest - 2 &&
        fields.every(field => field[index] >= 3));
      place(midfield.length >= config.springs ? midfield : remaining, 'spring', config.springs);
    } else {
      place(open, 'spring', config.springs);
      place(open, 'chest', config.chests);
    }
    if (rulesVersion >= 4) {
      if (rulesVersion < 8) {
        // Keep exit placement for older saved runs and replays.
        cells[treasure] = 'exit';
        const edge = cells.flatMap((cell, index) => Number.isFinite(distances[index]) &&
          ['ground', 'forest', 'swamp'].includes(cell) && boundary(index) ? [index] : []);
        while (exits.length < 3 && edge.length) {
          const fields = exits.map(exit => bfs(map, exit));
          edge.sort((a, b) => Math.min(...fields.map(field => field[b])) - Math.min(...fields.map(field => field[a])) || a - b);
          const exit = edge.shift();
          exits.push(exit);
          cells[exit] = 'exit';
        }
      }
      const exitFields = exits.map(exit => bfs(map, exit));
      const shortest = Math.min(...cells.map((cell, index) => cell === 'chest'
        ? distances[index] + Math.min(...exitFields.map(field => field[index])) : Infinity));
      return { ...map, exits, shortest };
    }
    return { ...map, shortest: distances[map.treasure] };
  }

  function cost(map, position, carried = 0) {
    const difficulty = Rules.difficultyFor(map.difficulty, map.rulesVersion);
    const terrain = map.cells[position];
    return { stamina: (terrain === 'swamp' ? difficulty.swampCost : difficulty.groundCost) + carried * difficulty.cargoCost,
      courage: terrain === 'forest' ? difficulty.forestCost : 0 };
  }

  function stepCost(state, position, map = state.map) {
    const carried = state.cargo?.count || 0;
    const need = cost(map, position, carried);
    const ability = Rules.expeditionAbility(state.ticket);
    if (!ability?.terrain || ability.terrain !== map.cells[position] || (ability.emptyOnly && carried)) return need;

    const cargoCost = carried * Rules.difficultyFor(map.difficulty, map.rulesVersion).cargoCost;
    const load = ability.resource === 'stamina' ? cargoCost : 0;
    const base = need[ability.resource] - load;
    const saving = ability.saving ?? Math.min(base - 1, Math.ceil(base * ability.fraction));
    return { ...need, [ability.resource]: base - saving + load, ability: ability.name };
  }

  return { neighbors, bfs, dijkstra, generate, cost, stepCost };
})();
