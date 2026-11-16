import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const core = ['rules', 'maze', 'decision', 'adventure', 'store'].map(name => source(`core/${name}.js`)).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const globals = vm.runInNewContext(core + '\n({ Rules, Maze, Decision, Adventure, Store })');
const { Rules, Maze, Decision, Adventure, Store } = globals;
const legacyDifficulties = ['easy', 'normal', 'hard'];
const time = '2026-01-01T00:00:00.000Z';
const environment = () => ({ id: randomUUID(), time });

function ticket(options = {}) {
  const pet = Rules.hatch('栗子', 'test-pet', 'pet', time);
  // The original scenarios remain fixtures for version 3 replay compatibility.
  return { id: 'test-adventure', rulesVersion: 3, mapId: 'test-map', mapSeed: 'test-maze', difficulty: 'easy',
    decisionSeed: 'test-ai', eventSeed: 'test-event', bag: { tonic: 1, tea: 1 }, startedAt: time, pet, ...options };
}

function finish(state) {
  while (state.status === 'active') {
    if (state.encounter) {
      if (state.encounter.kind === 'exit') Adventure.resolveExit(state, 'cashout');
      else Adventure.resolveChest(state, 'safe');
      continue;
    }
    const pending = Adventure.prepare(state);
    if (pending.chosen) assert.ok(Adventure.options(state).some(option =>
      option.position === pending.chosen.position && !option.issue));
    Adventure.execute(state, pending);
  }
  return state;
}

function custom(rows, options = {}) {
  const cells = rows.flat();
  const size = rows.length;
  const state = Adventure.create(ticket(options));
  state.map = { cells, size, difficulty: 'easy', start: cells.indexOf('start'), treasure: cells.indexOf('treasure') };
  state.position = state.map.start;
  state.recent = [state.position];
  state.toTreasure = Maze.bfs(state.map, state.map.treasure);
  state.map.shortest = state.toTreasure[state.position];
  state.bestDistance = state.map.shortest;
  return state;
}

const small = [
  ['start', 'swamp', 'swamp', 'swamp', 'treasure'],
  ['ground', 'ground', 'ground', 'ground', 'ground'],
  ...Array.from({ length: 3 }, () => Array(5).fill('wall'))
];
const corridor = [['start', 'ground', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']];
const open = [
  ['start', 'ground', 'ground'],
  ['ground', 'ground', 'ground'],
  ['ground', 'ground', 'treasure']
];

function deliveryMap(rows, options = {}) {
  const state = custom(rows, { pet: { ...ticket().pet, personality: 'timid' }, rulesVersion: 4, ...options });
  state.map.exits = state.map.cells.flatMap((cell, position) => cell === 'exit' ? [position] : []);
  state.map.treasure = state.map.exits[0];
  state.toTreasure = Maze.bfs(state.map, state.map.treasure);
  const fromStart = Maze.bfs(state.map, state.position);
  const fields = state.map.exits.map(exit => Maze.bfs(state.map, exit));
  state.map.shortest = Math.min(...state.map.cells.map((cell, position) => cell === 'chest'
    ? fromStart[position] + Math.min(...fields.map(field => field[position])) : Infinity));
  return state;
}

const haulMap = [
  ['start', 'chest', 'exit'],
  ['wall', 'wall', 'ground'],
  ['exit', 'chest', 'ground']
];

test('v13 種族移動折扣會反映在預覽、引導與扣點，舊票券仍用原價', () => {
  const route = [
    ['start', 'forest', 'chest', 'exit'],
    ['wall', 'wall', 'wall', 'wall'],
    ['wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall']
  ];
  const pet = { ...ticket().pet, species: 'cat' };
  const current = deliveryMap(route, { rulesVersion:13, pet });
  const old = deliveryMap(route, { rulesVersion:12, pet });
  current.courage = old.courage = 2;
  assert.equal(Adventure.forecast(current).steps[0]?.position, 1);
  assert.equal(Adventure.prepare(old).chosen, null);
  assert.equal(Adventure.options(current)[0].issue, '');
  Adventure.intervene(current, 'right');
  assert.equal(current.courage, 1);

  const swamp = route.map(row => row.map(cell => cell === 'forest' ? 'swamp' : cell));
  const dragon = deliveryMap(swamp, {rulesVersion:13, pet:{...pet, species:'dragon'}});
  Object.assign(dragon.map, {difficulty:'hard', rulesVersion:10});
  dragon.cargo = { count:2, coins:0, items:{} };
  const stamina = dragon.stamina;
  Adventure.intervene(dragon, 'right');
  assert.equal(stamina - dragon.stamina, 5 + 4);

  const ground = route.map(row => row.map(cell => cell === 'forest' ? 'ground' : cell));
  const rabbit = deliveryMap(ground, {rulesVersion:13, pet:{...pet, species:'rabbit'}});
  const initial = rabbit.stamina;
  Adventure.execute(rabbit, Adventure.prepare(rabbit));
  assert.equal(initial - rabbit.stamina, .75);
  rabbit.cargo = { count:1, coins:0, items:{} };
  Adventure.intervene(rabbit, 'left');
  assert.equal(Maze.stepCost(rabbit, 1).stamina, 1);
});

test('狐狸會考慮用近處泉水補膽量，同一泉水只補一次且不超過上限', () => {
  const state = deliveryMap([
    ['start', 'chest', 'forest', 'exit'],
    ['spring', 'wall', 'wall', 'wall'],
    ['wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall']
  ], {rulesVersion:13, pet:{...ticket().pet, species:'fox', maxCourage:10}});
  state.courage = 2;
  assert.equal(Adventure.forecast(state).steps[0]?.position, 4);
  assert.equal(state.courage, 2);
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.courage, 6);
  Adventure.intervene(state, 'up');
  Adventure.intervene(state, 'down');
  assert.equal(state.courage, 6);

  const capped = deliveryMap([
    ['start','spring','chest'], ['wall','wall','exit'], ['exit','wall','wall']
  ], {rulesVersion:13, pet:{...ticket().pet, species:'fox', maxCourage:10}});
  capped.courage = 9;
  Adventure.intervene(capped, 'right');
  assert.equal(capped.courage, 10);
});

function reachExit(state) {
  while (state.status === 'active' && !state.encounter) Adventure.execute(state, Adventure.prepare(state));
  return state;
}

test('版本 4 每張地圖有三個連通出口，最短路程包含取得及送達寶箱', () => {
  for (const difficulty of legacyDifficulties) {
    for (let seed = 0; seed < 100; seed++) {
      const map = Maze.generate('exits-' + seed, difficulty, 4);
      assert.equal(new Set(map.exits).size, 3);
      const fromStart = Maze.bfs(map, map.start);
      const fields = map.exits.map(exit => Maze.bfs(map, exit));
      for (const exit of map.exits) {
        assert.equal(map.cells[exit], 'exit');
        assert.ok(Number.isFinite(fromStart[exit]));
      }
      assert.equal(map.shortest, Math.min(...map.cells.map((cell, position) => cell === 'chest'
        ? fromStart[position] + Math.min(...fields.map(field => field[position])) : Infinity)));
    }
  }
});

test('空手走到出口不算贏，搬起寶箱也不立即領獎，送達後才能收手', () => {
  const state = deliveryMap([['start', 'exit', 'chest'], ['wall', 'wall', 'wall'], ['exit', 'wall', 'wall']]);
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.status, 'active');
  assert.equal(state.encounter, null);
  Adventure.execute(state, Adventure.prepare(state));
  assert.ok(state.cargo);
  assert.equal(state.chestCoins, 0);
  assert.equal(state.status, 'active');
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.delivered, 1);
  assert.equal(state.cargo, null);
  assert.equal(state.encounter.kind, 'exit');
  assert.equal(Adventure.options(state).length, 0);
  assert.throws(() => Adventure.resolveChest(state, 'safe'));
  Adventure.resolveExit(state, 'cashout');
  assert.equal(state.status, 'success');
  assert.ok(Adventure.result(state, time).coins > 0);
  assert.throws(() => Adventure.resolveExit(state, 'cashout'));
});

test('繼續冒險不重置資源，可送到另一個出口，委託按送達箱數計算', () => {
  const state = reachExit(deliveryMap(haulMap, { mission: 'collector' }));
  const firstExit = state.position;
  const stamina = state.stamina;
  const full = Adventure.bank(state);
  assert.equal(Adventure.mission(state).complete, false);
  Adventure.resolveExit(state, 'continue');
  assert.equal(state.stamina, stamina);
  reachExit(state);
  assert.notEqual(state.position, firstExit);
  assert.equal(state.delivered, 2);
  assert.equal(Adventure.mission(state).complete, true);
  assert.ok(Adventure.bank(state).coins > full.coins + Rules.missions.collector.coins);
  assert.equal(Adventure.canContinue(state), false);
  assert.throws(() => Adventure.resolveExit(state, 'continue'));
  Adventure.resolveExit(state, 'cashout');
});

test('送達後繼續失敗保留已送達獎勵一半，未送達寶箱不計入', () => {
  const state = reachExit(deliveryMap(haulMap, { mission: 'courier' }));
  const full = Adventure.bank(state);
  const reduced = Adventure.bank(state, true);
  Adventure.resolveExit(state, 'continue');
  while (!state.cargo) Adventure.execute(state, Adventure.prepare(state));
  state.stamina = 0;
  state.pending = null;
  Adventure.execute(state, Adventure.prepare(state));
  const result = Adventure.result(state, time);
  assert.equal(result.result, 'failure');
  assert.equal(result.coins, Math.floor(full.coins / 2));
  assert.equal(result.exp, Math.floor(full.exp / 2));
  assert.deepEqual(result.items, reduced.items);
  assert.equal(state.delivered, 1);
  assert.ok(state.cargo);
  const lost = deliveryMap(haulMap);
  Adventure.execute(lost, Adventure.prepare(lost));
  lost.stamina = 0;
  lost.pending = null;
  finish(lost);
  assert.equal(Adventure.result(lost, time).coins, 0);
});

test('v9 新冒險降低金幣，但 v8 同一地圖與操作沿用原價', () => {
  const original = ticket({rulesVersion: 8, mission: 'careful', pet: {...ticket().pet, maxStamina: 115, maxCourage: 55, patience: 48}});
  const current = {...original, rulesVersion: 9};
  const state = finish(Adventure.create(original));
  const old = Adventure.result(state, time);
  assert.equal(old.result, 'success');
  const now = Adventure.result(Adventure.replay(current, old.actions), time);
  assert.equal(now.steps, old.steps);
  assert.equal(now.exp, old.exp);
  assert.deepEqual(now.items, old.items);
  assert.ok(now.coins > 0 && now.coins <= old.coins * .55);
  assert.deepEqual(Adventure.result(Adventure.replay(original, old.actions), time), old);
});

test('低資源不在兩格間徘徊，會拒絕走不完的路，補給後可重新規劃', () => {
  const state = deliveryMap([
    ['start', 'ground', 'forest', 'chest'],
    ['ground', 'wall', 'wall', 'exit'],
    ['wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall']
  ]);
  state.courage = 2;
  const blocked = Adventure.prepare(state);
  assert.equal(blocked.chosen, null);
  assert.equal(Adventure.forecast(state).steps.length, 0);
  assert.equal(state.steps, 0);
  Adventure.useItem(state, 'tea');
  assert.ok(Adventure.prepare(state).chosen);
  finish(state);
  assert.equal(state.status, 'success');
  assert.equal(state.steps, 4);
});

test('v12 會走到真正需要膽量的格子前才停，預覽也會走完可行的幾步', () => {
  const state = deliveryMap([
    ['start', 'ground', 'ground', 'forest', 'chest'],
    ['wall', 'wall', 'wall', 'wall', 'exit'],
    ['exit', 'wall', 'wall', 'wall', 'wall'],
    ...Array.from({length:2}, () => Array(5).fill('wall'))
  ], {rulesVersion:12});
  state.courage = 2;
  const preview = Adventure.forecast(state);
  assert.deepEqual([...preview.steps.map(step => step.position)], [1,2]);
  for (const position of [1,2]) {
    const next = Adventure.prepare(state);
    assert.equal(next.returnRisk, true);
    assert.equal(next.shortage, '');
    Adventure.execute(state, next);
    assert.equal(state.position, position);
  }
  const blocked = Adventure.prepare(state);
  assert.equal(blocked.chosen, null);
  assert.equal(blocked.shortage, '膽量不足');
  assert.equal(state.status, 'active');
  assert.ok(Adventure.options(state).some(step => step.direction === 'left' && !step.issue));
  Adventure.useItem(state, 'tea');
  assert.equal(Adventure.prepare(state).chosen.position, 3);
  assert.equal(finish(state).status, 'success');
});

test('v12 撿箱前會提醒回程風險，搬運途中到體力不足時才要求補給', () => {
  const state = deliveryMap([
    ['start', 'chest', 'ground', 'ground', 'exit'],
    ['wall', 'wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall', 'wall'],
    ...Array.from({length:2}, () => Array(5).fill('wall'))
  ], {rulesVersion:12});
  Object.assign(state.map, {difficulty:'hard', rulesVersion:10});
  state.stamina = 9;
  const beforeChest = Adventure.prepare(state);
  assert.equal(beforeChest.returnRisk, true);
  assert.equal(beforeChest.chosen.position, 1);
  Adventure.execute(state, beforeChest);
  const afterChest = Adventure.prepare(state);
  assert.equal(afterChest.returnRisk, true);
  assert.equal(afterChest.chosen.position, 2);
  Adventure.execute(state, afterChest);
  assert.equal(state.stamina, 3);
  const blocked = Adventure.prepare(state);
  assert.equal(blocked.chosen, null);
  assert.equal(blocked.shortage, '體力不足');
  Adventure.useItem(state, 'tonic');
  assert.equal(Adventure.prepare(state).returnRisk, false);
  assert.equal(finish(state).status, 'success');
});

test('資源路徑保留較長但負擔得起的繞路；最後一點體力可送達', () => {
  const state = deliveryMap([
    ['start', 'forest', 'chest', 'exit'],
    ['ground', 'ground', 'ground', 'wall'],
    ['wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall']
  ]);
  state.courage = 2;
  state.stamina = 5;
  assert.equal(Adventure.prepare(state).chosen.direction, 'down');
  reachExit(state);
  assert.equal(state.stamina, 0);
  assert.equal(state.delivered, 1);
  assert.equal(Adventure.canContinue(state), false);
  Adventure.resolveExit(state, 'cashout');
  assert.equal(state.status, 'success');
});

test('搬運三步預覽不提前搬起或送達，與實際執行一致', () => {
  const state = deliveryMap(haulMap);
  const preview = Adventure.forecast(state);
  assert.equal(preview.steps.length, 2);
  assert.match(preview.ending, /出口送達/);
  assert.equal(state.cargo, null);
  assert.equal(state.delivered, 0);
  assert.equal(state.chestCoins, 0);
  assert.equal(state.claimed.size, 0);
  for (const step of preview.steps) {
    Adventure.execute(state, Adventure.prepare(state));
    assert.equal(state.position, step.position);
  }
  assert.equal(state.encounter.kind, 'exit');
});

test('版本 4 批次多趟探索不反覆兩格振盪，出口抉擇及失敗折扣可重播', () => {
  let easyWins = 0;
  let reducedRuns = 0;
  for (const difficulty of legacyDifficulties) {
    for (let index = 0; index < 26; index++) {
      const state = Adventure.create(ticket({ rulesVersion: 4, difficulty, mapSeed: 'delivery-' + index,
        pet: Rules.hatch('栗子', 'p', 'pet-' + index, time), mission: 'collector' }));
      let seenDelivery = false;
      while (state.status === 'active') {
        if (state.encounter) {
          assert.deepEqual(Adventure.replay(state.ticket, state.actions).encounter, state.encounter);
          if (difficulty === 'easy' && !seenDelivery) easyWins++;
          seenDelivery = true;
          Adventure.resolveExit(state, Adventure.canContinue(state) ? 'continue' : 'cashout');
        } else Adventure.execute(state, Adventure.prepare(state));
        const recent = state.recent;
        if (recent.length >= 6) {
          const tail = recent.slice(-6);
          assert.ok(!(tail[0] === tail[2] && tail[2] === tail[4] && tail[1] === tail[3] && tail[3] === tail[5]), `ping-pong ${difficulty}/${index}`);
        }
      }
      if (state.status === 'failure' && state.delivered) reducedRuns++;
      assert.deepEqual(Adventure.result(state, time), Adventure.result(Adventure.replay(state.ticket, state.actions), time));
      assert.ok(state.steps <= Rules.difficulties[difficulty].limit);
    }
  }
  assert.ok(easyWins >= 20, `Easy 送達 ${easyWins} / 26`);
  assert.ok(reducedRuns > 0);
});

const multipleChests = [
  ['wall', 'wall', 'exit', 'wall', 'wall'],
  ['start', 'chest', 'ground', 'chest', 'exit'],
  ['wall', 'ground', 'ground', 'ground', 'wall'],
  ...Array.from({ length: 2 }, () => Array(5).fill('wall'))
];

test('行為樹依性格自行決定再找下一箱或撤離，撿箱不暫停也不要求玩家選擇', () => {
  const timid = deliveryMap(multipleChests);
  const adventurous = deliveryMap(multipleChests, { pet: { ...ticket().pet, personality: 'adventurous' } });
  for (const state of [timid, adventurous]) {
    Adventure.execute(state, Adventure.prepare(state));
    assert.equal(state.cargo.count, 1);
    assert.equal(state.encounter, null);
  }
  assert.equal(Adventure.prepare(timid).target.kind, 'exit');
  assert.equal(Adventure.prepare(adventurous).target.kind, 'chest');
  assert.match(Adventure.prepare(adventurous).thought, /下一箱.*回出口/);
  const before = plain(adventurous.cargo);
  const preview = Adventure.forecast(adventurous);
  assert.deepEqual(plain(adventurous.cargo), before);
  assert.equal(adventurous.chests, 1);
  assert.equal(preview.steps.length, 3);
  Adventure.execute(adventurous, Adventure.prepare(adventurous));
  Adventure.execute(adventurous, Adventure.prepare(adventurous));
  assert.equal(adventurous.cargo.count, 2);
  assert.equal(adventurous.delivered, 0);
  assert.equal(adventurous.encounter, null);
  reachExit(adventurous);
  assert.equal(adventurous.delivered, 2);
  Adventure.resolveExit(adventurous, 'cashout');
});

test('玩家可以持續強制搜寶、改去出口、恢復自主，不消耗方向干涉次數', () => {
  const state = deliveryMap(multipleChests);
  assert.throws(() => Adventure.chooseRoute(state, 'exit'));
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(Adventure.prepare(state).target.kind, 'exit');
  Adventure.chooseRoute(state, 'collect');
  assert.equal(Adventure.prepare(state).target.kind, 'chest');
  assert.match(Adventure.prepare(state).thought, /你要求我繼續搜寶/);
  Adventure.chooseRoute(state, 'exit');
  assert.equal(Adventure.prepare(state).target.kind, 'exit');
  Adventure.chooseRoute(state, 'auto');
  assert.equal(state.intent, 'auto');
  assert.equal(Adventure.prepare(state).target.kind, 'exit');
  Adventure.chooseRoute(state, 'collect');
  Adventure.execute(state, Adventure.prepare(state));
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.cargo.count, 2);
  assert.equal(state.intent, 'collect');
  assert.equal(state.interventions, 0);
  assert.equal(state.delivered, 0);
  state.stamina = 0;
  state.pending = null;
  finish(state);
  assert.equal(Adventure.result(state, time).coins, 0);
});

test('冒險型低資源時也會撤離；目標指令與多箱攜帶可刷新重播', () => {
  const low = deliveryMap(multipleChests, { pet: { ...ticket().pet, personality: 'adventurous' } });
  Adventure.execute(low, Adventure.prepare(low));
  low.stamina = 6;
  low.pending = null;
  assert.equal(Adventure.prepare(low).target.kind, 'exit');
  assert.match(Adventure.prepare(low).thought, /偏低/);
  const state = Adventure.create(ticket({ rulesVersion: 4, mapSeed: 'delivery-0' }));
  while (state.status === 'active' && !state.cargo) Adventure.execute(state, Adventure.prepare(state));
  assert.ok(state.cargo);
  Adventure.chooseRoute(state, 'collect');
  Adventure.execute(state, Adventure.prepare(state));
  const restored = Adventure.replay(state.ticket, state.actions);
  assert.deepEqual(restored.cargo, state.cargo);
  assert.equal(restored.intent, 'collect');
  Adventure.chooseRoute(state, 'exit');
  finish(state);
  assert.deepEqual(Adventure.result(state, time), Adventure.result(Adventure.replay(state.ticket, state.actions), time));
});

function command(data, op, input, extra = {}, env = environment()) {
  return Store.mutate(data, { op, input, revision: data.revision, requestId: randomUUID(), ...extra }, env);
}

function hatchPet(data, name) {
  const startedAt = new Date(Date.parse(time) - Rules.incubationSeconds(data.hatched) * 1000).toISOString();
  const egg = Store.mutate(data, {op: 'incubate', input: {}, revision: data.revision, requestId: randomUUID()},
    {...environment(), time: startedAt}).value;
  const result = command(data, 'hatch', {id: egg.id});
  command(data, 'rename', {petId: result.value, name});
  return result;
}

function testDate(readClock) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [readClock()])); }
    static now() { return readClock(); }
  };
}

test('15×15 地圖在三種難度與多個 Seed 保持連通', () => {
  for (const difficulty of legacyDifficulties) {
    for (let index = 0; index < 100; index++) {
      const map = Maze.generate('world-' + index, difficulty, 3);
      assert.equal(map.size, 15);
      assert.equal(map.cells.length, 225);
      assert.equal(map.cells[map.start], 'start');
      assert.equal(map.cells[map.treasure], 'treasure');
      assert.ok(Number.isFinite(Maze.bfs(map, map.start)[map.treasure]));
      assert.equal(map.cells.filter(cell => cell === 'spring').length, Rules.difficulties[difficulty].springs);
    }
  }
});

test('相同地圖種子完全重現，不同種子改變地圖', () => {
  assert.deepEqual(Maze.generate('fixed', 'normal'), Maze.generate('fixed', 'normal'));
  assert.notDeepEqual(Maze.generate('fixed', 'normal').cells, Maze.generate('another', 'normal').cells);
  assert.throws(() => Maze.generate('fixed', ['normal']), /難度/);
});

test('版本 7 的橫向地圖有三個連通出口，版本 6 仍為 15×15', () => {
  assert.equal(Maze.generate('wide', 'easy', 6).cells.length, 225);
  for (const difficulty of legacyDifficulties) {
    for (let seed = 0; seed < 20; seed++) {
      const map = Maze.generate('wide-' + seed, difficulty, 7);
      assert.equal(map.size, 18);
      assert.equal(map.cells.length, 144);
      assert.equal(map.exits.length, 3);
      const distances = Maze.bfs(map, map.start);
      assert.ok(map.exits.every(exit => Number.isFinite(distances[exit])));
      for (let col = 0; col < 18; col++) {
        assert.ok(!Maze.neighbors(map, 126 + col).some(step => step.direction === 'down'));
      }
    }
  }
});

test('新版地圖的出口和寶箱保有各難度要求的距離，泉水數量正確', () => {
  for (const difficulty of Object.keys(Rules.difficulties)) {
    const config = Rules.difficultyFor(difficulty, Rules.version);
    for (let seed = 0; seed < 100; seed++) {
      const map = Maze.generate('far-exit-' + seed, difficulty);
      const distances = Maze.bfs(map, map.start);
      assert.equal(new Set(map.exits).size, 2);
      assert.equal(map.cells.filter(cell => cell === 'exit').length, 2);
      assert.ok(map.exits.every(exit => Number.isFinite(distances[exit]) && distances[exit] >= config.minExit));
      assert.equal(map.cells.filter(cell => cell === 'chest').length, config.chests);
      assert.equal(map.cells.filter(cell => cell === 'spring').length, config.springs);
      const fromExits = map.exits.map(exit => Maze.bfs(map, exit));
      map.cells.forEach((cell, i) => {
        if (cell === 'chest') assert.ok(distances[i] >= config.minChest && fromExits.every(field => field[i] >= config.chestFromExit));
      });
    }
  }
});

test('困難搬貨的費用同時反映在引導、預覽和實際移動，泉水只恢復 8 點', () => {
  const state = custom([
    ['start', 'spring', 'chest', 'exit'],
    ['wall', 'wall', 'wall', 'wall'],
    ['wall', 'wall', 'wall', 'wall'],
    ['exit', 'wall', 'wall', 'wall']
  ], {rulesVersion:10});
  Object.assign(state.map, {rulesVersion:10, difficulty:'hard', exits:[3,12], shortest:3});
  state.stamina = 15;
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.position, 1);
  assert.equal(state.stamina, 21);
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.position, 2);
  assert.equal(state.stamina, 19);
  assert.equal(Adventure.forecast(state).steps[0].position, 3);
  assert.equal(state.stamina, 19);
  state.stamina = 3;
  assert.equal(Adventure.options(state).find(option => option.position === 3).issue, '體力不足');
  state.stamina = 4;
  assert.equal(Adventure.options(state).find(option => option.position === 3).issue, '');
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.stamina, 0);
  assert.equal(state.delivered, 1);
});

test('五點引導額度由指定目標與指路共用，取消指令不退點', () => {
  const state = Adventure.create(ticket({rulesVersion: 7}));
  Adventure.chooseRoute(state, 'collect');
  assert.equal(Adventure.guidanceLeft(state), 2);
  Adventure.chooseRoute(state, 'auto');
  assert.equal(Adventure.guidanceLeft(state), 2);
  assert.throws(() => Adventure.chooseRoute(state, 'collect'), /3 點引導點/);
  for (let i = 0; i < 2; i++) {
    const option = Adventure.options(state).find(step => !step.issue);
    Adventure.intervene(state, option.direction);
  }
  assert.equal(Adventure.guidanceLeft(state), 0);
  assert.equal(state.blocked, null);
  assert.throws(() => Adventure.intervene(state, 'down'), /額度不足/);
  assert.equal(Adventure.guidanceLeft(Adventure.replay(state.ticket, state.actions)), 0);
});

test('螢火遺跡、便橋與紀念品送達都可重播', () => {
  const data = Store.fresh();
  hatchPet(data, '糖果');
  const run = command(data, 'begin', {petId: data.selected, mission:'lantern', mapSeed:'test-maze', difficulty:'easy'}).value;
  const state = Adventure.create(run);
  Adventure.chooseRoute(state, 'lantern');
  while (state.status === 'active' && !state.encounter) Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.encounter?.kind, 'lantern');
  if (Adventure.canRepairBridge(state)) {
    Adventure.repairBridge(state);
    assert.equal(state.map.cells[state.lampSite.bridge], 'ground');
    assert.equal(Adventure.guidanceLeft(state), 1);
    assert.throws(() => Adventure.repairBridge(state), /必須在遺跡旁/);
  }
  Adventure.resolveLantern(state, 'lamp');
  assert.equal(state.cargo.items.fireflyLamp, 1);
  assert.equal(Adventure.bank(state).items.fireflyLamp, undefined);
  while (state.status === 'active' && !state.encounter) Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.encounter?.kind, 'exit');
  assert.equal(Adventure.bank(state, true).items.fireflyLamp, 1);
  Adventure.resolveExit(state, 'cashout');
  const settled = command(data, 'settle', {id: run.id, actions: state.actions}).value;
  assert.equal(settled.items.fireflyLamp, 1);
  assert.equal(data.inventory.fireflyLamp, 1);
  assert.throws(() => command(data, 'buy', {itemId: 'fireflyLamp'}), /紀念品只能/);
});

test('BFS 求最少步數，無法穿牆或跨越邊界', () => {
  const { map } = custom(corridor);
  assert.equal(Maze.bfs(map, 0)[2], 2);
  assert.equal(Maze.bfs(map, 0)[3], Infinity);
  assert.deepEqual(plain(Maze.neighbors(map, 0)), [{ direction: 'right', position: 1 }]);
});

test('Dijkstra 選擇較長、成本較低的路線', () => {
  const { map } = custom(small);
  const field = Maze.dijkstra(map, 4, position => Maze.cost(map, position).stamina, 0);
  assert.equal(field[5] + 1, 6);
  assert.equal(field[1] + 3, 8); // The swamp branch can still turn down into the lower corridor.
});

test('孵化種子可重現，四物種、四性格與個體特質皆會出現', () => {
  const pets = Array.from({ length: 90 }, (_, index) => Rules.hatch('栗子', 'p', 'hatch-' + index, time));
  assert.equal(new Set(pets.map(pet => pet.species)).size, 4);
  assert.equal(new Set(pets.map(pet => pet.personality)).size, 4);
  assert.deepEqual(pets[0], Rules.hatch('栗子', 'p', 'hatch-0', time));
  assert.ok(pets.every(pet => Object.values(pet.traits).every(value => value >= .25 && value <= .75)));
  for (const pet of pets) {
    const iv = Object.values(pet.iv);
    assert.ok(iv.every(value => Number.isInteger(value) && value >= 10 && value <= 40));
    const sum = iv.reduce((total, value) => total + value, 0);
    assert.ok(sum >= 80 && sum <= 100);
  }
});

test('性格權重實際改變同一個岔路的路線', () => {
  const pet = ticket().pet;
  const impatient = custom(small, { pet: { ...pet, personality: 'impatient' } });
  const steady = custom(small, { pet: { ...pet, personality: 'steady' } });
  assert.equal(Adventure.prepare(impatient).best.direction, 'right');
  assert.equal(Adventure.prepare(steady).best.direction, 'down');
});

test('權重只在指定範圍內浮動，所有候選使用同一組權重', () => {
  for (const [personality, config] of Object.entries(Rules.personalities)) {
    const state = custom(open, { pet: { ...ticket().pet, personality } });
    const snapshot = Adventure.prepare(state);
    snapshot.weights.actual.forEach((value, index) => {
      const ratio = value / snapshot.weights.base[index];
      assert.ok(ratio >= 1 - config.jitter && ratio <= 1 + config.jitter && value >= 0);
    });
    const [distance, stamina] = snapshot.weights.actual;
    for (const candidate of snapshot.candidates) assert.ok(Math.abs(candidate.cost - 4 * (distance + stamina)) < 1e-9);
  }
});

test('只有一個合法可達方向時不會觸發改道', () => {
  const state = custom(corridor);
  const snapshot = Adventure.prepare(state);
  assert.equal(snapshot.chosen.direction, 'right');
  assert.equal(snapshot.explored, false);
});

test('同一狀態與決策 Seed 可重現，換 Seed 會產生合理差異', () => {
  const decisions = new Set();
  let explored = 0;
  for (let index = 0; index < 60; index++) {
    const inputs = { decisionSeed: 'route-' + index, pet: { ...ticket().pet, personality: 'adventurous' } };
    const state = custom(open, inputs);
    const snapshot = Adventure.prepare(state);
    assert.deepEqual(snapshot, Adventure.prepare(custom(open, inputs)));
    assert.ok(Adventure.options(state).some(option => !option.issue && option.position === snapshot.chosen.position));
    if (snapshot.explored) explored++;
    decisions.add(snapshot.chosen.direction);
  }
  assert.equal(decisions.size, 2);
  assert.ok(explored > 0);
});

test('情緒與個體特質實際調整權重及目標，查詢不消耗情緒', () => {
  const state = custom(small);
  const normal = Decision.weights(state, () => .5).actual;
  state.mood = { key: 'nervous', remaining: 4 };
  const snapshot = Adventure.prepare(state);
  assert.equal(snapshot.target.kind, 'safe');
  assert.ok(snapshot.weights.base[2] > normal[2]);
  assert.equal(Adventure.prepare(state), snapshot);
  assert.equal(state.mood.remaining, 4);
  Adventure.execute(state, snapshot);
  assert.equal(state.mood.remaining, 3);
  const patient = custom(small, { pet: { ...ticket().pet, patience: 40 } });
  const impatient = custom(small, { pet: { ...ticket().pet, patience: 10 } });
  assert.ok(Decision.weights(patient, () => .5).base[0] < Decision.weights(impatient, () => .5).base[0]);
});

test('低體力時 Behaviour Tree 優先選擇能到達的恢復泉', () => {
  const state = custom([['start', 'spring', 'ground'], ['ground', 'ground', 'ground'],
    ['ground', 'ground', 'treasure']]);
  state.stamina = 8;
  const snapshot = Adventure.prepare(state);
  assert.equal(snapshot.target.kind, 'spring');
  assert.equal(snapshot.chosen.direction, 'right');
  Adventure.execute(state, snapshot);
  assert.equal(state.springs, 1);
  assert.equal(state.stamina, 27);
});

test('預測快照固定，取消可重用，揭曉只執行一次', () => {
  const state = Adventure.create(ticket());
  const prepared = Adventure.prepare(state);
  for (let index = 0; index < 20; index++) assert.equal(Adventure.prepare(state), prepared);
  assert.equal(state.steps, 0);
  const guess = prepared.chosen.direction;
  Adventure.execute(state, prepared, guess);
  assert.equal(state.last.chosen.direction, guess);
  assert.equal(state.position, prepared.chosen.position);
  assert.equal(state.attempts, 1);
  assert.equal(state.correct, 1);
  assert.equal(state.interventions, 0);
  assert.throws(() => Adventure.execute(state, prepared, guess), /失效/);
  assert.equal(state.steps, 1);
});

test('三步預覽與實際路線一致，推算中的泉水和寶箱不會提前結算', () => {
  const state = custom([
    ['start', 'spring', 'chest', 'forest', 'treasure'],
    ...Array.from({ length: 4 }, () => Array(5).fill('wall'))
  ], { rulesVersion: 2 });
  state.stamina = 3;
  const plan = Adventure.forecast(state);
  assert.deepEqual(plain(plan.steps.map(step => step.position)), [1, 2, 3]);
  assert.equal(plan.next.target.kind, 'spring');
  assert.equal(Adventure.prepare(state), plan.next);
  assert.deepEqual(Adventure.forecast(state), plan);
  assert.equal(state.version, 0);
  assert.equal(state.stamina, 3);
  assert.equal(state.claimed.size, 0);
  assert.equal(state.attempted.size, 0);
  assert.equal(state.chestCoins, 0);
  assert.equal(Object.keys(state.chestItems).length, 0);
  assert.equal(state.events.length + state.trace.length + state.actions.length, 0);
  for (const step of plan.steps) {
    Adventure.execute(state, Adventure.prepare(state));
    assert.equal(state.position, step.position);
  }
  assert.equal(state.springs, 1);
  assert.equal(state.chests, 1);
});

test('三步預覽在終點或無法繼續時提早停止', () => {
  const near = Adventure.forecast(custom(corridor));
  assert.equal(near.steps.length, 2);
  assert.match(near.ending, /抵達終點/);
  const exhausted = custom(corridor);
  exhausted.stamina = 1;
  const blocked = Adventure.forecast(exhausted);
  assert.equal(blocked.steps.length, 0);
  assert.match(blocked.ending, /體力耗盡/);
  assert.equal(exhausted.status, 'active');
});

test('新版寶箱會阻止移動與提前領獎，選擇只能執行一次', () => {
  const state = custom([['start', 'chest', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  const preview = Adventure.forecast(state);
  assert.equal(preview.steps.length, 1);
  assert.match(preview.ending, /由你決定/);
  assert.equal(state.encounter, null);
  Adventure.execute(state, Adventure.prepare(state));
  assert.equal(state.chestCoins, 0);
  assert.equal(state.chests, 0);
  assert.equal(Adventure.prepare(state), null);
  assert.equal(Adventure.options(state).length, 0);
  assert.throws(() => Adventure.intervene(state, 'right'));
  Adventure.resolveChest(state, 'safe');
  assert.equal(state.chestCoins, 8);
  assert.equal(state.chests, 1);
  assert.equal(state.steps, 1);
  assert.equal(state.interventions, 0);
  assert.throws(() => Adventure.resolveChest(state, 'safe'));
  assert.equal(Adventure.prepare(state).chosen.position, 2);
});

test('冒險開箱的兩種結果可重現，低體力時拒絕冒險', () => {
  const outcomes = new Set();
  for (let index = 0; index < 20; index++) {
    const run = () => {
      const state = custom([['start', 'chest', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']],
        { eventSeed: 'chest-' + index });
      Adventure.execute(state, Adventure.prepare(state));
      Adventure.resolveChest(state, 'risk');
      return state;
    };
    const state = run();
    assert.equal(state.chestOutcome, run().chestOutcome);
    outcomes.add(state.chestCoins);
    assert.equal(state.stamina, state.ticket.pet.maxStamina - 1 - (state.chestCoins ? 0 : 6));
    assert.equal(Object.values(state.chestItems).reduce((sum, count) => sum + count, 0), state.chestCoins ? 1 : 0);
  }
  assert.deepEqual([...outcomes].sort((a, b) => a - b), [0, 18]);
  const low = custom([['start', 'chest', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  Adventure.execute(low, Adventure.prepare(low));
  low.stamina = 6;
  assert.throws(() => Adventure.resolveChest(low, 'risk'), /至少需要 7/);
  assert.ok(low.encounter);
  Adventure.resolveChest(low, 'safe');
  assert.equal(low.stamina, 6);
});

test('冒險開箱與刷新重播保持相同結果及資源', () => {
  let opened = 0;
  for (let index = 0; index < 12 && !opened; index++) {
    const state = Adventure.create(ticket({ mapSeed: 'box-replay-' + index, mission: 'collector' }));
    while (state.status === 'active') {
      if (state.encounter) {
        const reloaded = Adventure.replay(state.ticket, state.actions);
        assert.deepEqual(reloaded.encounter, state.encounter);
        Adventure.resolveChest(state, state.stamina > 6 ? 'risk' : 'safe');
        opened++;
      } else Adventure.execute(state, Adventure.prepare(state));
    }
    assert.deepEqual(Adventure.result(state, time), Adventure.result(Adventure.replay(state.ticket, state.actions), time));
  }
  assert.ok(opened > 0);
});

test('干涉後的三步預覽從新位置重新計算', () => {
  const state = custom(open);
  const before = Adventure.forecast(state);
  const alternative = Adventure.options(state).find(option => option.direction !== before.next.chosen.direction);
  Adventure.intervene(state, alternative.direction);
  const after = Adventure.forecast(state);
  assert.equal(after.next.position, alternative.position);
  assert.equal(after.next.version, before.next.version + 1);
  assert.notEqual(after.steps[0].position, before.steps[0].position);
  assert.equal(state.interventions, 1);
  assert.equal(state.steps, 1);
});

test('無效干涉不扣次數，有效干涉最多三次並清除舊快照', () => {
  const state = custom(open);
  const old = Adventure.prepare(state);
  assert.throws(() => Adventure.intervene(state, 'up'), /岩牆/);
  assert.equal(state.interventions, 0);
  assert.equal(Adventure.prepare(state), old);
  Adventure.intervene(state, 'right');
  assert.notEqual(Adventure.prepare(state), old);
  assert.throws(() => Adventure.execute(state, old), /失效/);
  Adventure.intervene(state, 'down');
  Adventure.intervene(state, 'left');
  assert.equal(state.interventions, 3);
  assert.throws(() => Adventure.intervene(state, 'left'), /無法再/);
});

test('沼澤與森林分別消耗體力和膽量，耗盡時回報具體原因', () => {
  const rows = [['start', 'swamp', 'forest'], ['wall', 'wall', 'treasure'], ['wall', 'wall', 'wall']];
  const state = custom(rows);
  Adventure.intervene(state, 'right');
  assert.equal(state.spentStamina, 3);
  Adventure.intervene(state, 'right');
  assert.equal(state.spentCourage, 2);
  assert.equal(state.spentStamina, 4);
  const stamina = custom(rows);
  stamina.stamina = 1;
  assert.match(finish(stamina).failure, /體力耗盡/);
  const courage = custom([['start', 'forest', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  courage.courage = 2;
  assert.match(finish(courage).failure, /膽量耗盡/);
});

test('無路與探索上限有各自的失敗原因', () => {
  const blocked = custom([['start', 'wall', 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  assert.match(finish(blocked).failure, /沒有資源可負擔的通往終點路線/);
  const capped = custom(open);
  capped.steps = Rules.difficulties.easy.limit - 1;
  assert.match(finish(capped).failure, /步數上限/);
});

test('無法通往終點的死路不會掩蓋膽量不足的原因', () => {
  const state = custom([['start', 'forest', 'treasure'], ['ground', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  state.courage = 2;
  assert.match(finish(state).failure, /膽量耗盡/);
});

test('同一場的寶箱或泉水各只能領取一次，事件結果可重現', () => {
  for (const terrain of ['spring', 'chest']) {
    const run = () => {
      const state = custom([['start', terrain, 'treasure'], ['wall', 'wall', 'wall'], ['wall', 'wall', 'wall']], { rulesVersion: 1 });
      state.stamina -= 22;
      Adventure.intervene(state, 'right');
      Adventure.intervene(state, 'left');
      Adventure.intervene(state, 'right');
      return state;
    };
    const state = run();
    assert.equal(state.claimed.size, 1);
    assert.equal(state.chests + state.springs, 1);
    assert.equal(state.chestCoins, run().chestCoins);
    assert.equal(state.stamina, state.ticket.pet.maxStamina - 25 + (terrain === 'spring' ? 20 : 0));
  }
});

test('探索補給遵守持有量與能力上限，使準備中的決策失效', () => {
  const state = Adventure.create(ticket());
  assert.throws(() => Adventure.useItem(state, 'tonic'), /能力已滿/);
  Adventure.execute(state, Adventure.prepare(state));
  const old = Adventure.prepare(state);
  Adventure.useItem(state, 'tonic');
  assert.equal(state.stamina, state.ticket.pet.maxStamina);
  assert.equal(state.bag.tonic, 0);
  assert.throws(() => Adventure.execute(state, old), /失效/);
  assert.throws(() => Adventure.useItem(state, 'tonic'), /沒有可在/);
});

test('干涉路障阻擋原位四步，預覽與重播都遵守路障', () => {
  const state = custom(open);
  Adventure.intervene(state, 'right');
  assert.equal(state.blocked.position, 0);
  assert.equal(state.blocked.until - state.steps, 4);
  assert.ok(!Adventure.options(state).some(option => option.position === 0));
  assert.ok(Adventure.forecast(state).steps.every(step => step.position !== 0));
  assert.match(Adventure.prepare(state).thought, /記得你的引導/);
  state.steps = state.blocked.until;
  assert.ok(Adventure.options(state).some(option => option.position === 0));
  const live = Adventure.create(ticket());
  Adventure.intervene(live, Adventure.options(live).find(option => !option.issue).direction);
  finish(live);
  assert.deepEqual(Adventure.result(live, time), Adventure.result(Adventure.replay(live.ticket, live.actions), time));
});

test('干涉到死路保留出口並解釋回頭原因', () => {
  const state = custom([['start', 'ground', 'treasure'], ['ground', 'wall', 'wall'], ['wall', 'wall', 'wall']]);
  Adventure.intervene(state, 'down');
  assert.equal(state.blocked, null);
  assert.match(state.last.reason, /保留回頭路/);
  assert.match(Adventure.prepare(state).thought, /只有回頭/);
  assert.equal(Adventure.prepare(state).chosen.direction, 'up');
});

test('委託獎勵根據實際條件與通關結果計算', () => {
  const run = mission => finish(custom(corridor, { mission }));
  const success = run('courier');
  const base = run(undefined);
  assert.equal(Adventure.result(success, time).coins - Adventure.result(base, time).coins, 12);
  const collector = run('collector');
  assert.equal(Adventure.mission(collector).complete, false);
  assert.equal(Adventure.result(collector, time).coins, Adventure.result(base, time).coins);
  const failed = custom(corridor, { mission: 'courier' });
  failed.stamina = 1;
  assert.equal(Adventure.result(finish(failed), time).coins, 0);
});

test('新版隨機改道只走未訪問且接近目標的方向，機率降為三成', () => {
  const pet = { ...ticket().pet, personality: 'adventurous' };
  for (let index = 0; index < 60; index++) {
    const state = custom(open, { pet, decisionSeed: String(index) });
    const modern = Adventure.prepare(state);
    const legacy = Adventure.prepare(custom(open, { pet, decisionSeed: String(index), rulesVersion: 1 }));
    assert.ok(Math.abs(modern.epsilon - legacy.epsilon * .3) < 1e-9);
    if (modern.explored) {
      assert.ok(!state.visited.has(modern.chosen.position));
      assert.ok(state.toTreasure[modern.chosen.position] < state.toTreasure[state.position]);
    }
  }
});

test('停滯後優先回到終點，不連續觸發隨機改道', () => {
  const state = custom(open);
  state.stalled = 7;
  const direct = Adventure.prepare(state);
  assert.equal(direct.target.kind, 'direct');
  assert.equal(direct.explored, false);
  assert.ok(state.toTreasure[direct.chosen.position] < state.toTreasure[state.position]);
  state.stalled = 0;
  state.pending = null;
  state.cooldown = 2;
  assert.equal(Adventure.prepare(state).explored, false);
});

test('跨難度批次探索皆終止，Easy 新手可合理通關', () => {
  let easyWins = 0;
  for (const difficulty of legacyDifficulties) {
    for (let index = 0; index < 26; index++) {
      const inputs = ticket({ difficulty, mapSeed: 'simulation-' + index, decisionSeed: 'ai-' + index,
        pet: Rules.hatch('栗子', 'p', 'demo-' + index, time) });
      const state = finish(Adventure.create(inputs));
      assert.ok(state.steps <= Rules.difficulties[difficulty].limit);
      assert.notEqual(state.status, 'active');
      if (difficulty === 'easy' && state.status === 'success') easyWins++;
    }
  }
  assert.ok(easyWins >= 20, `Easy 通關數 ${easyWins} / 26`);
});

test('操作紀錄重播相同位置、決策、資源與統計', () => {
  const initial = ticket();
  const state = Adventure.create(initial);
  const first = Adventure.prepare(state);
  Adventure.execute(state, first, first.chosen.direction);
  Adventure.useItem(state, 'tonic');
  Adventure.intervene(state, Adventure.options(state).find(next => !next.issue).direction);
  const live = Adventure.result(finish(state), time);
  const replay = Adventure.result(Adventure.replay(initial, live.actions), time);
  assert.deepEqual(live, replay);
  assert.throws(() => Adventure.replay(initial, [...live.actions, ['ai']]), /無效/);
});

test('第一顆免費、放生後仍維持付費，而且至少保留最後一隻', () => {
  const data = Store.fresh();
  const egg = command(data, 'incubate', {}).value;
  assert.equal(egg.readyAt, egg.startedAt);
  const starter = command(data, 'hatch', {id: egg.id}).value;
  assert.equal(data.pets[0].needsName, true);
  assert.throws(() => command(data, 'incubate', {}), /取名/);
  assert.equal(data.coins, 24);
  command(data, 'rename', { petId: starter, name: '=Luna' });
  assert.equal(data.pets[0].needsName, undefined);
  assert.equal(data.pets[0].name, '=Luna');
  assert.throws(() => command(data, 'deletePet', { petId: data.selected }), /最後一隻/);
  assert.throws(() => command(data, 'incubate', {}), /金幣不足/);
  data.coins = 60;
  hatchPet(data, '小莓');
  command(data, 'deletePet', {petId:starter});
  assert.throws(() => command(data, 'deletePet', {petId:data.selected}), /最後一隻/);
  assert.equal(data.coins, 24);
  assert.throws(() => hatchPet(data, '下一隻'), /金幣不足/);
  assert.deepEqual([0,1,2,3].map(Rules.hatchPrice), [0,36,54,72]);
  assert.deepEqual([0,1,2,3].map(Rules.incubationSeconds), [0,120,300,600]);
  assert.equal(data.pets.length, 1);
});

test('商店拒絕超額付款，重送交易不會再次扣款', () => {
  const data = Store.fresh();
  data.coins = 100;
  const requestId = randomUUID();
  command(data, 'buy', { itemId: 'badge', coins: 9999 }, { requestId, revision: 0 });
  command(data, 'buy', { itemId: 'badge' }, { requestId, revision: 0 });
  assert.equal(data.coins, 56);
  assert.equal(data.inventory.badge, 1);
  assert.throws(() => command(data, 'buy', { itemId: 'badge' }, { revision: 0 }), /新變更/);
  command(data, 'buy', { itemId: 'badge' });
  assert.throws(() => command(data, 'buy', { itemId: 'badge' }), /金幣不足/);
  assert.equal(data.coins, 12);
});

test('培養消耗背包道具，能力及等級有上限', () => {
  const data = Store.fresh();
  hatchPet(data, '栗子');
  const pet = data.pets[0];
  data.coins = 100;
  hatchPet(data, '小莓');
  const target = data.pets[1];
  target.iv.patience = 39;
  target.patience = 47;
  const item = Rules.items.badge;
  const odds = Rules.trainingOdds(target, item);
  assert.ok(Rules.trainingOdds({...target, level: odds.level + 1}, item).chance >
    Rules.trainingOdds({...target, level: odds.level - 1}, item).chance);
  assert.ok(Rules.trainingOdds({...target, iv: {...target.iv, patience: 37}}, item).chance > odds.chance);
  function roll(success) {
    for (let i = 0; ; i++) {
      const id = 'training-test-' + i;
      if ((Rules.seeded('training', id, target.id, 'badge')() * 100 < odds.chance) === success) {
        return command(data, 'train', {petId: target.id, itemId: 'badge'}, {}, {id,time}).value;
      }
    }
  }
  data.inventory.badge = 3;
  pet.patience = 47;
  assert.equal(roll(false).success, false);
  assert.equal(target.iv.patience, 39);
  assert.equal(target.patience, 47);
  assert.equal(data.inventory.badge, 2);
  assert.equal(roll(true).success, true);
  assert.equal(target.patience, 48);
  assert.equal(pet.patience, 47);
  assert.equal(target.iv.patience, 40);
  assert.throws(() => command(data, 'train', { petId: target.id, itemId: 'badge' }), /Lv. 5/);
  target.iv.patience = Rules.ivCap;
  assert.throws(() => command(data, 'train', { petId: target.id, itemId: 'badge' }), /上限/);
  assert.equal(data.inventory.badge, 1);
  assert.throws(() => command(data, 'train', { petId: pet.id, itemId: 'treat' }), /背包道具不足/);
  assert.throws(() => command(data, 'train', { petId: pet.id, itemId: 'tonic' }), /探索中/);
  Rules.gainExp(pet, 20000);
  assert.equal(pet.level, Rules.maxLevel);
  assert.equal(pet.exp, 0);
  assert.ok(pet.maxStamina <= 115 && pet.maxCourage <= 55);
});

test('進階天賦有等級門檻，連續失敗三次後保底，成功提升能力上限', () => {
  const data = Store.fresh();
  hatchPet(data, '栗子');
  const pet = data.pets[0];
  Object.assign(pet, {level:10, maxStamina:124, iv:{...pet.iv, stamina:49}});
  const input = {petId:pet.id, itemId:'staminaSeed'};
  const item = Rules.items.staminaSeed;
  data.inventory.staminaSeed = 4;
  assert.throws(() => command(data,'care',input), /Lv. 11/);
  assert.equal(data.inventory.staminaSeed,4);
  pet.level = 11;
  for (let miss = 0; miss < 3; miss++) {
    const odds = Rules.trainingOdds(pet,item);
    let roll = 0;
    while (Rules.seeded('training','forced-'+roll,pet.id,input.itemId)() * 100 < odds.chance) roll++;
    assert.equal(command(data,'care',input,{}, {time,id:'forced-'+roll}).value.success,false);
    assert.equal(pet.trainingMisses.stamina,miss+1);
    assert.equal(pet.iv.stamina,49);
  }
  assert.equal(Rules.trainingOdds(plain(pet),item).chance,100);
  assert.equal(command(data,'care',input).value.success,true);
  assert.equal(pet.trainingMisses.stamina,0);
  assert.equal(pet.iv.stamina,50);
  assert.equal(pet.maxStamina,125);
  assert.equal(data.inventory.staminaSeed,undefined);
});

test('極限只限新規則、每類補給各帶一份，困難舊地圖不變', () => {
  assert.throws(() => Maze.generate('test','expert',10), /難度/);
  assert.deepEqual(Maze.generate('test','hard',10),Maze.generate('test','hard',11));
  const data = Store.fresh();
  hatchPet(data, '栗子');
  Object.assign(data.pets[0], {maxStamina:125,maxCourage:65,patience:58});
  Object.assign(data.inventory,{tonic:8,tea:3});
  const active = command(data,'begin',{petId:data.selected,difficulty:'expert',mapSeed:'expert-route'}).value;
  assert.deepEqual(plain(active.bag),{tonic:1,tea:1});
  assert.equal(data.inventory.tonic,8);
  const live = finish(Adventure.create(active));
  assert.deepEqual(Adventure.result(Adventure.replay(active,live.actions),time),Adventure.result(live,time));
});

test('結算用重播結果，無法重複領取或用未完成的行程領取', () => {
  const data = Store.fresh();
  hatchPet(data, '栗子');
  const active = command(data, 'begin', { petId: data.selected, difficulty: 'easy' }).value;
  const state = Adventure.create(active);
  Adventure.execute(state, Adventure.prepare(state));
  Adventure.useItem(state, 'tonic');
  assert.throws(() => command(data, 'settle', { id: active.id, actions: state.actions }), /仍在進行/);
  finish(state);
  const submitted = { id: active.id, actions: state.actions, coins: 99999, exp: 99999 };
  const log = command(data, 'settle', submitted).value;
  assert.equal(data.active, null);
  assert.equal(data.coins, Rules.startingCoins + log.coins);
  assert.equal(data.inventory.tonic || 0, log.items.tonic || 0);
  assert.equal(command(data, 'settle', submitted).changed, false);
  assert.equal(data.coins, Rules.startingCoins + log.coins);
  data.pets.push(Rules.hatch('小莓', 'spare-pet', 'spare', time));
  command(data, 'deletePet', { petId: log.petId });
  command(data, 'deleteMap', { id: log.mapId });
  assert.equal(Adventure.replay(log.ticket, log.actions).status, log.result);
  command(data, 'deleteLog', { id: log.id });
  assert.throws(() => command(data, 'settle', submitted), /已失效/);
});

test('地圖 CRUD 會重新生成有效的地形，檢查 Seed 與難度', () => {
  const data = Store.fresh();
  const id = command(data, 'createMap', { mapSeed: '森谷-1', difficulty: 'easy' }).value;
  assert.equal(Store.view(data).maps[0].id, id);
  assert.throws(() => command(data, 'updateMap', { id, mapSeed: '=x', difficulty: 'easy' }), /Seed/);
  command(data, 'updateMap', { id, mapSeed: '森谷-2', difficulty: 'hard' });
  assert.deepEqual(data.maps[0].cells, Maze.generate('森谷-2', 'hard').cells);
  command(data, 'deleteMap', { id });
  assert.equal(data.maps.length, 0);
});

test('單一計時器支援暫停、重複繼續與變速', () => {
  const StepClock = vm.runInNewContext(source('web/clock.js') + '\nStepClock');
  const queue = new Map();
  let id = 0;
  let ticks = 0;
  const timers = { setTimeout(fn, delay) { queue.set(++id, { fn, delay }); return id; },
    clearTimeout(key) { queue.delete(key); } };
  const clock = new StepClock(() => ticks++, timers);
  clock.resume();
  clock.resume();
  assert.equal(queue.size, 1);
  assert.equal(queue.get(id).delay, 1200);
  const stale = queue.get(id).fn;
  clock.pause();
  stale();
  assert.equal(ticks, 0);
  assert.equal(queue.size, 0);
  clock.resume();
  clock.setDelay(100);
  assert.equal(queue.size, 1);
  const current = queue.get(id);
  assert.equal(current.delay, 100);
  queue.delete(id);
  current.fn();
  assert.equal(ticks, 1);
  assert.equal(queue.size, 1);
  clock.pause();
  assert.equal(queue.size, 0);
});

test('Demo Repository 跨頁重載保留寵物、金幣及背包', async () => {
  const storage = new Map();
  let clock = Date.parse(time);
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const freshPage = () => vm.runInNewContext(core + '\n' + source('web/repository.js') + '\nRepository', {
    document: { documentElement: { dataset: { mode: 'demo' } } }, localStorage, Date: testDate(() => clock),
    navigator: { locks: { request: async (key, callback) => callback() } }, crypto: { randomUUID }
  });
  const first = freshPage();
  const egg = (await first.command('incubate', {}, 0)).value;
  assert.equal(Date.parse(egg.readyAt) - clock, 0);
  const restored = (await freshPage().read()).data;
  assert.equal(restored.egg.id, egg.id);
  assert.equal(restored.pets.length, 0);
  await assert.rejects(first.command('incubate', {}, 1), /已經有一顆蛋/);
  const hatched = await freshPage().command('hatch', {id: egg.id}, 1);
  await assert.rejects(first.command('hatch', {id: egg.id}, 2), /找不到要孵化的蛋/);
  assert.equal((await freshPage().read()).data.pets[0].needsName, true);
  await first.command('rename', {petId: hatched.value, name: '栗子'}, 2);
  await first.command('buy', {itemId: 'cushion'}, 3);
  const reloaded = (await freshPage().read()).data;
  assert.equal(reloaded.pets[0].name, '栗子');
  assert.equal(reloaded.coins, 6);
  assert.equal(reloaded.inventory.cushion, 1);
  assert.equal(reloaded.pets[0].needsName, undefined);
});

test('付費蛋只扣款一次、跨存檔計時且無法提早破殼', () => {
  const data = Store.fresh();
  hatchPet(data, '栗子');
  data.coins = 60;
  const requestId = randomUUID();
  const revision = data.revision;
  const egg = command(data, 'incubate', {}, {requestId}).value;
  assert.equal(Date.parse(egg.readyAt) - Date.parse(time), 120000);
  assert.equal(data.coins, 24);
  assert.equal(command(data, 'incubate', {}, {requestId, revision}).changed, false);
  const restored = plain(data);
  assert.throws(() => command(restored, 'hatch', {id: egg.id}), /還需要一點時間/);
  command(restored, 'hatch', {id: egg.id}, {}, {...environment(), time: egg.readyAt});
  assert.equal(restored.hatched, 2);
  assert.equal(restored.coins, 24);
  assert.equal(restored.pets[1].needsName, true);
});

test('Sheets 以測試替身驗證登入、玩家隔離、舊存檔及原子結算', () => {
  const tables = ['Players', 'Pets', 'Maps', 'Inventory', 'AdventureLogs'];
  const rows = Object.fromEntries(tables.map(name => [name, []]));
  const accounts = [];
  const cache = new Map();
  let locked = false;
  let owner = 'owner@example.test';
  let clock = Date.parse(time);
  const sheets = {
    Values: {
      batchGet: (_id, { ranges }) => ({ valueRanges: ranges.map(name => ({ values: plain(rows[name]) })) }),
      get: () => ({ values: plain(accounts) }),
      append: ({ values }, _id, range, options) => {
        assert.equal(locked, true);
        assert.equal(range, 'Accounts!A:G');
        assert.equal(options.valueInputOption, 'RAW');
        accounts.push(plain(values[0]));
      },
      update: ({ values }, _id, range, options) => {
        assert.equal(locked, true);
        assert.equal(options.valueInputOption, 'RAW');
        accounts[Number(/^Accounts!A(\d+):/.exec(range)[1]) - 1] = plain(values[0]);
      }
    },
    get: () => ({ sheets: tables.map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000 } } })) }),
    batchUpdate: ({ requests }) => {
      assert.equal(locked, true);
      for (const { updateCells } of requests) {
        const name = tables[updateCells.range.sheetId];
        rows[name] = [rows[name][0], ...updateCells.rows.map(row => row.values.map(({ userEnteredValue: value }) => {
          assert.equal(value.formulaValue, undefined);
          return value.numberValue ?? value.stringValue;
        }))];
      }
    }
  };
  const context = vm.createContext({
    Sheets: { Spreadsheets: sheets }, Utilities: { getUuid: randomUUID }, Date: testDate(() => clock),
    Session: { getActiveUser: () => ({ getEmail: () => owner }) },
    AccountCrypto: {
      digest: value => createHash('sha256').update(value).digest('hex'),
      passwordHash: (password, salt, iterations) => pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')
    },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({
      OWNER_EMAIL: 'owner@example.test', SPREADSHEET_ID: 'sheet', LEGACY_TARGET_USERNAME: '阿栗玩家'
    })[key] }) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      releaseLock() { locked = false; }
    }) }
  });
  const api = vm.runInContext(core + '\n' + ['SheetsStore', 'Accounts', 'Code'].map(name => source(`gas/${name}.gs`)).join('\n') +
    '\n({ gameApi, accountApi, migrateLegacySave, TABLES, ACCOUNT_FIELDS })', context);
  for (const table of tables) rows[table].push(plain(api.TABLES[table]));
  accounts.push(plain(api.ACCOUNT_FIELDS));
  const password = 'mock account long password';
  assert.throws(() => api.gameApi('read', {}), /重新登入/);
  const first = api.accountApi('register', { username: '阿栗玩家', password });
  const second = api.accountApi('register', { username: '第二位玩家', password });
  assert.throws(() => api.accountApi('register', { username: ' 阿栗玩家 ', password }), /有人使用/);
  assert.throws(() => api.accountApi('login', { username: '阿栗玩家', password: 'incorrect long password' }), /帳號或密碼錯誤/);
  assert.equal(JSON.stringify(accounts).includes(password), false);
  assert.equal(JSON.stringify(accounts).includes(first.token), false);
  assert.notEqual(accounts[1][4], accounts[2][4]);
  const read = (token = first.token) => api.gameApi('read', {}, token);
  function send(op, input, token = first.token) {
    const { revision } = read(token).data;
    return api.gameApi('command', { op, input, revision, requestId: randomUUID(), playerId: first.playerId }, token);
  }
  rows.Players.push(['owner', 0, '', Rules.startingCoins, 0, '', '']);
  rows.Maps.push(['legacy-map', 'legacy-seed', 'easy', 15, '[]', 0, 1, 12, time]);
  assert.equal(read().data.maps.length, 0);
  assert.match(api.migrateLegacySave(), /已轉移/);
  assert.equal(read().data.maps[0].id, 'legacy-map');
  assert.equal(read(second.token).data.maps.length, 0);
  assert.match(api.migrateLegacySave(), /沒有待轉移/);
  const egg = send('incubate', {}).value;
  assert.equal(read().data.egg.name, undefined);
  assert.equal(read(second.token).data.egg, null);
  const hatch = send('hatch', {id: egg.id}).data;
  assert.equal(hatch.pets[0].needsName, true);
  assert.ok(JSON.parse(rows.Pets[1][11]).iv);
  send('rename', { petId: hatch.selected, name: '=SUM(1,2)' });
  assert.equal(rows.Pets[1][2], '=SUM(1,2)');
  send('rename', { petId: hatch.selected, name: '栗子' });
  const id = send('createMap', { mapSeed: 'seed-a', difficulty: 'easy' }).value;
  const otherId = send('createMap', { mapSeed: 'seed-other', difficulty: 'easy' }, second.token).value;
  assert.throws(() => send('deleteMap', {id}, second.token), /找不到/);
  assert.throws(() => send('rename', { petId: hatch.selected, name: '其他' }, second.token), /找不到/);
  assert.equal(read(second.token).data.pets.length, 0);
  assert.equal(read(second.token).data.maps[0].id, otherId);
  send('updateMap', { id, mapSeed: 'seed-b', difficulty: 'easy' });
  send('buy', { itemId: 'cushion' });
  assert.ok(rows.Inventory.some(row => row[1] === 'cushion'));
  rows.Players[1][3] = Rules.rooms.conservatory.price + 20;
  send('unlockRoom', {roomId:'conservatory'});
  send('movePet', {petId:hatch.selected,roomId:'conservatory'});
  assert.ok(read().data.rooms.includes('conservatory'));
  assert.equal(read().data.pets[0].room,'conservatory');
  const active = send('begin', { petId: hatch.selected, mapSeed: 'seed-b', difficulty: 'easy' }).value;
  const state = finish(Adventure.create(active));
  const result = send('settle', { id: active.id, actions: state.actions });
  assert.equal(result.data.history.length, 1);
  assert.equal(result.data.active, null);
  assert.equal(result.value.mapId, id);
  assert.equal(api.gameApi('history', { id: active.id }, first.token).trace.length, state.trace.length);
  assert.throws(() => api.gameApi('history', { id: active.id }, second.token), /找不到/);
  assert.equal(send('settle', { id: active.id, actions: state.actions }).data.coins, result.data.coins);
  assert.throws(() => send('deletePet', { petId: hatch.selected }), /最後一隻/);
  send('deleteMap', { id });
  assert.equal(read().data.history[0].petName, '栗子');
  assert.equal(read(second.token).data.inventory.cushion, undefined);
  assert.equal(read(second.token).data.maps[0].id, otherId);
  send('deleteLog', { id: active.id });
  assert.equal(rows.AdventureLogs.length, 1);
  owner = 'other@example.test';
  assert.throws(() => api.migrateLegacySave(), /擁有者/);
  api.accountApi('logout', { token: first.token });
  assert.throws(() => read(), /重新登入/);
  const signedIn = api.accountApi('login', { username: '阿栗玩家', password });
  assert.equal(read(signedIn.token).data.pets[0].name, '栗子');
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.throws(() => read(signedIn.token), /重新登入/);
});

test('版本 5 有可重現的隨機改道，仍接近目標且不來回振盪', () => {
  let detours = 0;
  for (let index = 0; index < 20; index++) {
    const state = Adventure.create(ticket({ rulesVersion: 5, mapSeed: 'variety-' + index, decisionSeed: 'wander-' + index }));
    while (state.status === 'active') {
      if (state.encounter) { Adventure.resolveExit(state, 'cashout'); continue; }
      const next = Adventure.prepare(state);
      if (next.explored) {
        detours++;
        assert.ok(!state.visited.has(next.chosen.position));
        const field = Maze.bfs(Decision.navigationMap(state), next.target.position);
        assert.ok(field[next.chosen.position] < field[state.position]);
      }
      const preview = Adventure.forecast(state);
      Adventure.execute(state, next);
      if (preview.steps.length) assert.equal(state.position, preview.steps[0].position);
    }
    assert.deepEqual(Adventure.result(state, time), Adventure.result(Adventure.replay(state.ticket, state.actions), time));
  }
  assert.ok(detours >= 5, `改道次數 ${detours}`);
});

test('未指定種子時每次出發產生新地圖，指定種子仍可重玩', () => {
  const data = Store.fresh();
  hatchPet(data, '栗子');
  const input = { petId: data.selected, difficulty: 'easy', mapSeed: '', decisionSeed: '' };
  const first = command(data, 'begin', input).value;
  command(data, 'abandon', { id: first.id });
  const second = command(data, 'begin', input).value;
  assert.notEqual(first.mapSeed, second.mapSeed);
  assert.notDeepEqual(Adventure.create(first).map.cells, Adventure.create(second).map.cells);
  command(data, 'abandon', { id: second.id });
  const repeat = command(data, 'begin', { ...input, mapSeed: first.mapSeed }).value;
  assert.deepEqual(Adventure.create(first).map.cells, Adventure.create(repeat).map.cells);
});
