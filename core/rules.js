'use strict';

var Rules = (() => {
  const size = 15;
  const wideSize = 18;
  const startingCoins = 24;
  const hatchPrice = hatched => hatched === 0 ? 0 : 36 + (hatched - 1) * 18;
  const incubationSeconds = hatched => hatched === 0 ? 0 : hatched === 1 ? 120 : (hatched - 1) * 300;
  const maxLevel = 12;
  const maxPets = 24;
  const maxItems = 99;
  const maxInterventions = 3;
  const version = 13;
  const rewardCoins = (amount, rulesVersion) => rulesVersion >= 9 ? Math.floor(amount * .55) : amount;
  const exitCount = 2;
  const minExitDistance = 12;
  const guidance = { total: 5, step: 1, goal: 3 };
  const missions = {
    courier: { name: '限步快遞', text: '在 BFS 最少步數 +8 步內抵達終點', coins: 12, exp: 8 },
    collector: { name: '寶箱獵人', text: '打開至少 2 個寶箱，並抵達終點', coins: 20, exp: 8 },
    careful: { name: '平安回家', text: '抵達終點時保留至少 40% 體力與 50% 膽量', coins: 14, exp: 8 },
    lantern: { name: '帶螢火燈回家', text: '將遺跡的螢火燈送到任一出口', coins: 10, exp: 8 }
  };

  const species = {
    cat: { name: '貓', icon: '🐱', color: 'peach', base: [58, 17, 18],
      ability: { name: '夜視', terrain: 'forest', resource: 'courage', fraction: 1 / 3, text: '進入森林時，少扣三分之一膽量（減免量向上取整，至少扣 1）。' } },
    fox: { name: '狐狸', icon: '🦊', color: 'peach', base: [56, 22, 15],
      ability: { name: '靈敏嗅覺', springCourage: 4, text: '第一次使用每座泉水時，除了恢復體力，還能恢復最多 4 點膽量。' } },
    rabbit: { name: '兔子', icon: '🐰', color: 'mint', base: [65, 14, 22],
      ability: { name: '輕快跳步', terrain: 'ground', resource: 'stamina', saving: .25, emptyOnly: true, text: '空手踏入平地時，少扣 0.25 體力。' } },
    dragon: { name: '小龍', icon: '🐲', color: 'lilac', base: [52, 28, 13],
      ability: { name: '低空滑翔', terrain: 'swamp', resource: 'stamina', fraction: 1 / 3, text: '飛越沼澤時，少扣三分之一的地形體力（減免量向上取整）。' } }
  };
  const expeditionAbility = ticket => ticket.rulesVersion >= 13 ? species[ticket.pet.species]?.ability : undefined;
  const rooms = {
    cottage: {name:'暖陽小屋', icon:'☀', price:0, text:'有陽光、木地板和大家熟悉的軟墊。'},
    conservatory: {name:'玻璃花房', icon:'🌿', price:110, text:'陽光透過玻璃，綠葉包圍著寵物的小窩。'},
    loft: {name:'月光閣樓', icon:'☾', price:200, text:'藍紫色的屋頂下，能看到月亮和暖暖的燈。'}
  };
  const personalities = {
    impatient: { name: '急躁型', text: '重視捷徑，願意多消耗體力。', weights: [2.7, .48, .36], jitter: .10, epsilon: .15, curiosity: .17, threat: .10 },
    steady: { name: '穩重型', text: '願意繞路以保存體力與膽量。', weights: [1.0, 1.25, 1.10], jitter: .05, epsilon: .03, curiosity: .12, threat: .32 },
    timid: { name: '膽小型', text: '重視安全，探索時會避開危險地形。', weights: [.9, 1.05, 2.35], jitter: .07, epsilon: .05, curiosity: .09, threat: .70 },
    adventurous: { name: '冒險型', text: '容易被寶箱吸引，願意嘗試合理的岔路。', weights: [1.65, .69, .65], jitter: .12, epsilon: .20, curiosity: .66, threat: .13 }
  };
  const moods = {
    normal: { name: '正常', weights: [1, 1, 1], epsilon: 1, curiosity: 0 },
    curious: { name: '好奇', weights: [1, .90, .89], epsilon: 1.25, curiosity: .23 },
    nervous: { name: '緊張', weights: [.95, 1.15, 1.48], epsilon: .60, curiosity: -.16 },
    impulsive: { name: '衝動', weights: [1.22, .86, .86], epsilon: 1.32, curiosity: 0 },
    tired: { name: '疲憊', weights: [.91, 1.55, 1.14], epsilon: .58, curiosity: -.21 }
  };
  const difficulties = {
    easy: { name: '簡單', walls: .15, swamp: .10, forest: .12, springs: 4, chests: 5, swampCost: 3, forestCost: 2, limit: 100, coins: 26, exp: 26, prize: 'tonic' },
    normal: { name: '普通', walls: .25, swamp: .17, forest: .18, springs: 3, chests: 4, swampCost: 4, forestCost: 3, limit: 115, coins: 42, exp: 39, prize: 'treat' },
    hard: { name: '困難', walls: .33, swamp: .22, forest: .24, springs: 3, chests: 3, swampCost: 5, forestCost: 4, limit: 125, coins: 66, exp: 56, prize: 'badge' },
    expert: { name: '極限', walls: .33, swamp: .26, forest: .28, springs: 1, chests: 3, swampCost: 10, forestCost: 9, limit: 125, coins: 100, exp: 78, prize: 'badge' }
  };
  const expeditionChanges = {
    normal: {swamp: .20, forest: .20, swampCost: 6, forestCost: 5, springs: 2,
      groundCost: 1, cargoCost: 1, springHeal: 12, minExit: 14, minChest: 7, chestFromExit: 3},
    hard: {swamp: .24, forest: .26, swampCost: 8, forestCost: 7, springs: 1,
      groundCost: 2, cargoCost: 2, springHeal: 8, minExit: 16, minChest: 9, chestFromExit: 4},
    expert: {groundCost: 2, cargoCost: 3, springHeal: 5, minExit: 17, minChest: 10, chestFromExit: 4, supplyLimit: 1}
  };
  const defaults = {groundCost: 1, cargoCost: 0, springHeal: 20, minExit: minExitDistance, minChest: 3, chestFromExit: 0};
  const legacyDifficulties = Object.fromEntries(Object.entries(difficulties).map(([key, values]) => [key, {...defaults, ...values}]));
  const expeditionDifficulties = Object.fromEntries(Object.entries(legacyDifficulties).map(([key, values]) =>
    [key, {...values, ...expeditionChanges[key]}]));
  const difficultyFor = (key, rulesVersion) => (rulesVersion >= 10 ? expeditionDifficulties : legacyDifficulties)[key];
  const mapVersion = (key, rulesVersion) => key === 'expert' ? 11 : rulesVersion >= 10 && key !== 'easy' ? 10 : undefined;
  const items = {
    fireflyLamp: { name: '螢火燈', icon: '🏮', type: 'souvenir', text: '在小屋展示的探險紀念。' },
    cushion: { name: '安心餅乾', icon: '🍘', price: 18, type: 'recovery', stat: 'patience', amount: 12, text: '在家恢復 12 點耐心。' },
    staminaSeed: { name: '活力果', icon: '🍎', price: 48, type: 'capacity', stat: 'maxStamina', iv: 'stamina', amount: 4, text: '培養體力；成功時個體值 +1、體力上限最多 +4。' },
    courageSeed: { name: '勇氣果', icon: '🫐', price: 48, type: 'capacity', stat: 'maxCourage', iv: 'courage', amount: 2, text: '培養膽量；成功時個體值 +1、膽量上限最多 +2。' },
    tonic: { name: '活力露', icon: '🧪', price: 20, type: 'adventure', stat: 'stamina', amount: 16, text: '在家或探索中恢復 16 點體力。' },
    tea: { name: '勇氣茶', icon: '🍵', price: 18, type: 'adventure', stat: 'courage', amount: 9, text: '在家或探索中恢復 9 點膽量。' },
    treat: { name: '星屑餅乾', icon: '🍪', price: 27, type: 'training', amount: 18, text: '給寵物 18 點經驗。' },
    badge: { name: '橡果徽章', icon: '🌰', price: 44, type: 'training', stat: 'patience', iv: 'patience', amount: 2, text: '培養耐心；成功時個體值 +1、耐心上限最多 +2。' }
  };
  const birthIvCap = 40;
  const ivCap = 50;
  const ivLabels = { stamina: '體力', courage: '膽量', patience: '耐心' };
  const patiencePerStep = .25;
  const extraChestRange = (pet, patience) =>
    5 + Math.floor(patience / 3) + Math.round(pet.traits.curiosity * 3) + (pet.personality === 'adventurous' ? 4 : 0);
  const statCaps = { maxStamina: 115, maxCourage: 55, patience: 48 };
  const directions = { up: '↑ 上', right: '→ 右', down: '↓ 下', left: '← 左' };
  const terrain = {
    exit: { name: '撤離出口', icon: '🚪' },
    start: { name: '起點', icon: '⚑' }, treasure: { name: '終點寶藏', icon: '👑' },
    ground: { name: '平地', icon: '' }, wall: { name: '岩牆', icon: '' },
    swamp: { name: '沼澤', icon: '≈' }, forest: { name: '森林', icon: '🌲' },
    spring: { name: '恢復泉', icon: '💧' }, chest: { name: '神秘寶箱', icon: '🎁' }
  };
  const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function seeded(...parts) {
    let state = 2166136261;
    for (const character of JSON.stringify(parts)) {
      state = Math.imul(state ^ character.codePointAt(0), 16777619);
    }
    return () => {
      state = (state + 0x6D2B79F5) | 0;
      let value = Math.imul(state ^ (state >>> 15), state | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(list, random) {
    return list[Math.floor(random() * list.length)];
  }

  function petName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error('請輸入 1–20 個字的寵物名稱。');
    }
    return name;
  }

  function birthIv(seed) {
    const random = seeded('birth-iv', seed);
    const total = 80 + Math.floor(random() * 21);
    let left = total;
    const keys = Object.keys(ivLabels);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const values = {};
    keys.forEach((key, index) => {
      const remaining = 2 - index;
      const lo = Math.max(10, left - remaining * birthIvCap);
      const hi = Math.min(birthIvCap, left - remaining * 10);
      const value = lo + Math.floor(random() * (hi - lo + 1));
      left -= value;
      values[key] = value;
    });
    return values;
  }

  const individualValues = pet => pet.iv || birthIv(pet.hatchSeed || pet.id);
  const capacityFor = (pet, stat) => {
    const key = {maxStamina:'stamina', maxCourage:'courage', patience:'patience'}[stat];
    return statCaps[stat] + Math.max(0, individualValues(pet)[key] - birthIvCap);
  };

  function trainingOdds(pet, item) {
    const current = individualValues(pet)[item.iv];
    const required = current >= 46 ? 11 : current >= 43 ? 8 : current >= 40 ? 5 : 1;
    const level = clamp(1 + Math.floor((current - 22) / 2), required, maxLevel);
    const misses = clamp(pet.trainingMisses?.[item.iv] || 0, 0, 3);
    const blocked = current >= ivCap ? 'max' : pet.level < required ? 'level' : '';
    const base = 94 - (Math.min(current, birthIvCap) - 10) * 2 - Math.max(0, current - birthIvCap) * 1.2;
    const chance = blocked ? 0 : misses >= 3 ? 100 : clamp(Math.round(base + (pet.level - level) * 3 + misses * 12), 8, 95);
    return { current, level, required, misses, chance, blocked };
  }

  function hatch(name, id, seed, time, options = {}) {
    const random = seeded('hatch', seed);
    const type = pick(Object.keys(species), random);
    const personality = pick(Object.keys(personalities), random);
    const original = species[type].base.map(base => base + Math.floor(random() * 7) - 3);
    const iv = birthIv(seed);
    const [maxStamina, maxCourage, patience] = options.newborn
      ? species[type].base.map((base, index) => base + Math.round((iv[Object.keys(ivLabels)[index]] - 30) / 3)) : original;
    const traits = Object.fromEntries(['curiosity', 'riskTolerance', 'stubbornness'].map(key =>
      [key, Math.round((.25 + random() * .50) * 100) / 100]));
    return { id, name: petName(name || '小' + species[type].name.replace(/^小/u, '')), species: type, personality, traits, maxStamina, maxCourage, patience,
      iv, ...(options.newborn ? { needsName: true } : {}),
      level: 1, exp: 0, mood: 'normal', createdAt: time, updatedAt: time, hatchSeed: seed };
  }

  function expNeeded(level) {
    return 24 + level * 10;
  }

  function gainExp(pet, amount) {
    if (pet.level >= maxLevel) return;
    pet.exp += amount;
    while (pet.level < maxLevel && pet.exp >= expNeeded(pet.level)) {
      pet.exp -= expNeeded(pet.level);
      pet.level++;
      pet.maxStamina = Math.min(capacityFor(pet, 'maxStamina'), pet.maxStamina + 4);
      pet.maxCourage = Math.min(capacityFor(pet, 'maxCourage'), pet.maxCourage + 2);
      pet.patience = Math.min(capacityFor(pet, 'patience'), pet.patience + 1);
    }
    if (pet.level === maxLevel) pet.exp = 0;
  }

  // Current resources are independent of permanent capacities. Legacy pets start full.
  function condition(pet, time = new Date().toISOString(), away = false) {
    const prior = pet.condition || { stamina: pet.maxStamina, courage: pet.maxCourage, patience: pet.patience, at: time };
    const minutes = away ? 0 : Math.max(0, (Date.parse(time) - Date.parse(prior.at)) / 60000) || 0;
    return { stamina: clamp(prior.stamina + minutes * 2, 0, pet.maxStamina),
      courage: clamp(prior.courage + minutes, 0, pet.maxCourage),
      patience: clamp(prior.patience + minutes, 0, pet.patience), at: time };
  }

  return { condition, size, wideSize, version, exitCount, minExitDistance, missions, guidance, startingCoins, hatchPrice, incubationSeconds, rewardCoins, maxLevel, maxPets, maxItems, maxInterventions, species, personalities,
    birthIvCap, ivCap, ivLabels, capacityFor, individualValues, trainingOdds, rooms, patiencePerStep, extraChestRange,
    moods, difficulties, difficultyFor, mapVersion, expeditionAbility, items, directions, terrain, own, clamp, seeded, pick, petName, hatch, expNeeded, gainExp };
})();
