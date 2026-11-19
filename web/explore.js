'use strict';

Repository.startPage(() => {
  const { byId, node, button, meter } = UI;
  const board = byId('board');
  const playArea = board.closest('main');
  const petSelect = byId('pet-select');
  const setup = byId('setup-details');
  const difficulty = byId('difficulty');
  const missionSelect = byId('mission');
  const missionKey = Repository.playerKey('pet-treasure-mission-demo');
  try {
    const remembered = localStorage.getItem(missionKey);
    if (Rules.own(Rules.missions, remembered)) missionSelect.value = remembered;
  } catch {}
  missionSelect.addEventListener('change', () => {
    if (!Rules.own(Rules.missions, missionSelect.value)) return;
    try { localStorage.setItem(missionKey, missionSelect.value); } catch {}
  });
  function updateDifficultyNote() {
    const config = Rules.difficultyFor(difficulty.value, Rules.version);
    const costs = `平地 ${config.groundCost} 體力、沼澤 ${config.swampCost} 體力、森林另扣 ${config.forestCost} 膽量。`;
    const supplies = `${config.springs} 座恢復泉，每座最多補 ${config.springHeal} 體力。`;
    const load = config.cargoCost ? `每箱每步多耗 ${config.cargoCost} 體力。` : '搬寶箱沒有額外消耗。';
    const restriction = config.supplyLimit ? `活力露和勇氣茶各限帶 ${config.supplyLimit} 份；建議高等級夥伴挑戰。` : '';
    byId('difficulty-note').textContent = costs + supplies + load + `每走一步消耗 ${Rules.patiencePerStep} 耐心。` + restriction;
  }
  difficulty.addEventListener('change', updateDifficultyNote);
  updateDifficultyNote();
  const mapSeed = byId('map-seed');
  const decisionSeed = byId('decision-seed');
  const mapSelect = byId('map-select');
  const checkpointKey = Repository.playerKey('pet-treasure-run-demo');
  let state = null;
  let tiles = [];
  let marker = null;
  let markerPosition = null;
  let movement = null;
  let drawnMap = null;
  let mapPreview = null;
  let playback = null;
  let saved = null;
  let saving = false;
  let historyBusy = false;
  let controlsKey = '';
  let journalKey = '';
  let departureKey = '';
  let pendingProgress = null;
  let progressTimer = null;
  let syncingProgress = false;

  const clock = new StepClock(tick);
  document.addEventListener('account-locked', () => clock.pause(), { once: true });
  const sound = new GameSound();
  function feedback(message, kind) {
    const panel = byId('game-feedback');
    panel.textContent = message; panel.dataset.kind = kind;
    sound.play(kind);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) panel.animate([{opacity:.35,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}], {duration:250});
  }
  const directions = Object.entries(Rules.directions);
  const remaining = node('span', 'pill');
  const interventionNote = node('p', 'muted fine-print');
  function keyButton(key, label, action, options) {
    const control = button(`${key} · ${label}`, action, options);
    control.dataset.shortcut = key.toLowerCase();
    return control;
  }
  const directionButtons = directions.map(([direction, label]) =>
    button(label, () => manual(direction), { disabled: true }));
  byId('direction-panel').replaceChildren(remaining, interventionNote, node('div', 'direction-grid', directionButtons));
  const legend = Object.entries(Rules.terrain).filter(([key]) => key !== 'treasure').map(([key, terrain]) =>
    node('span', 'legend-item', node('i', 'swatch ' + key, terrain.icon), terrain.name));
  byId('legend').replaceChildren(...legend);

  function draft() {
    return { difficulty: difficulty.value, mapSeed: mapSeed.value.trim(), decisionSeed: decisionSeed.value.trim(), mission: missionSelect.value };
  }

  function statusMeters(pet, condition) {
    return [['體力', 'stamina', pet.maxStamina], ['膽量', 'courage', pet.maxCourage], ['耐心', 'patience', pet.patience]]
      .map(([label, kind, max]) => [label, Number(Rules.clamp(condition[kind], 0, max).toFixed(kind === 'patience' ? 2 : 1)), max, kind]);
  }

  function renderDeparture() {
    if (!setup.open) return;
    const pet = app.data?.pets.find(pet => pet.id === petSelect.value);
    byId('departure-status').hidden = !pet;
    if (!pet) return;
    const live = !playback && state?.status === 'active' && state.ticket.pet.id === pet.id;
    const condition = live ? state : Rules.condition(pet, new Date().toISOString(), pet.away);
    const rows = statusMeters(pet, condition);
    const range = Rules.extraChestRange(pet, condition.patience);
    const key = JSON.stringify([pet.id, rows, range]);
    if (departureKey === key) return;
    departureKey = key;
    byId('departure-resources').replaceChildren(...rows.map(values => meter(...values)));
    const ability = Rules.species[pet.species].ability;
    byId('departure-ability').replaceChildren(node('strong', '', ability.name), ' · ' + ability.text);
    byId('departure-patience').textContent =
      `耐心越高，越願意為下一箱多走幾步。若決定繼續搜寶，目前最多考慮 ${range} 步內的下一箱；耐心歸零仍可移動和撤離。`;
  }

  function checkpoint(actions = state?.actions) {
    try {
      if (actions) sessionStorage.setItem(checkpointKey, JSON.stringify({ id: state.ticket.id, actions }));
      else sessionStorage.removeItem(checkpointKey);
    } catch {
      // Some embedded browsers block session storage. The active ticket is still saved.
    }
  }

  // 分頁暫存必須和雲端已確認的動作相符，才能用它接續同一場探索。
  function savedActions(ticket) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(checkpointKey));
      const confirmed = ticket.progress || [];
      if (stored?.id === ticket.id && Array.isArray(stored.actions) &&
          JSON.stringify(stored.actions.slice(0, confirmed.length)) === JSON.stringify(confirmed)) return stored.actions;
    } catch {
      // An unreadable checkpoint can safely fall back to the start of the run.
    }
    return ticket.progress || [];
  }

  function setRun(run, replayLog = null) {
    clock.pause();
    clearPendingProgress();
    state = run;
    document.body.classList.toggle('exploring', Boolean(run));
    playback = replayLog && { log: replayLog, index: 0 };
    saved = null;
    controlsKey = '';
    byId('mission-label').textContent = state ? '下場委託' : '本場委託';
    if (state) {
      setup.open = false;
      difficulty.value = state.ticket.difficulty;
      updateDifficultyNote();
      mapSeed.value = state.ticket.mapSeed;
      decisionSeed.value = state.ticket.decisionSeed;
      petSelect.value = state.ticket.pet.id;
    }
    const seedNote = byId('current-seeds');
    seedNote.hidden = !state;
    seedNote.textContent = state
      ? `目前這場｜地圖 ${state.ticket.mapSeed} · 決策 ${state.ticket.decisionSeed}` : '';
    renderGame();
  }

  function drawMap(previewSteps) {
    if (!state) {
      if (drawnMap) board.replaceChildren(node('div', 'board-placeholder', node('span', '', '⛰'),
        node('strong', '', '探索即將開始'), node('span', '', '選擇夥伴和難度，展開霧谷地圖。')));
      drawnMap = null;
      board.style.removeProperty('--columns');
      board.style.removeProperty('--rows');
      playArea.style.removeProperty('--board-ratio');
      movement?.cancel();
      return;
    }
    if (drawnMap !== state.map) {
      drawnMap = state.map;
      const columns = state.map.size;
      const rows = state.map.cells.length / columns;
      board.style.setProperty('--columns', columns);
      board.style.setProperty('--rows', rows);
      playArea.style.setProperty('--board-ratio', columns / rows);
      board.setAttribute('aria-label', `${columns} 欄 × ${rows} 列迷宮地圖`);
      tiles = state.map.cells.map((cell, index) => {
        const badge = node('span', 'route-number');
        badge.hidden = true;
        badge.setAttribute('aria-hidden', 'true');
        const tile = node('div', 'tile ' + cell, badge);
        tile.dataset.position = index;
        tile.title = `${Rules.terrain[cell].name} · ${index % state.map.size + 1}, ${Math.floor(index / state.map.size) + 1}`;
        return tile;
      });
      movement?.cancel();
      markerPosition = null;
      const sprite = node('span', 'home-sprite trail-sprite sprite-' + state.ticket.pet.species);
      marker = node('div', 'marker', node('span', 'trail-shadow'), node('span', 'trail-pet', sprite));
      marker.setAttribute('aria-hidden', 'true');
      board.replaceChildren(node('div', 'tiles', tiles), marker);
    }
    const legal = state.status === 'active' && !playback && !app.busy && Adventure.guidanceLeft(state) > 0
      ? Adventure.options(state).filter(next => !next.issue).map(next => next.position) : [];
    const stepsByTile = new Map();
    previewSteps.forEach(({position}, index) => {
      const steps = stepsByTile.get(position) || [];
      steps.push(index + 1);
      stepsByTile.set(position, steps);
    });
    tiles.forEach((tile, index) => {
      tile.classList.toggle('visited', state.visited.has(index));
      tile.classList.toggle('claimed', state.claimed.has(index));
      tile.classList.toggle('target-cell', legal.includes(index));
      tile.tabIndex = legal.includes(index) ? 0 : -1;
      tile.setAttribute('role', legal.includes(index) ? 'button' : 'img');
      const blocked = state.blocked?.position === index && state.steps < state.blocked.until;
      tile.classList.toggle('blocked-cell', blocked);
      const shrine = index === state.lampSite?.position && !state.claimed.has(index);
      const crossing = index === state.lampSite?.bridge;
      tile.classList.toggle('lantern-site', shrine);
      tile.classList.toggle('bridge-site', crossing);
      tile.title = blocked ? `路障，剩 ${state.blocked.until - state.steps} 步` :
        `${Rules.terrain[state.map.cells[index]].name} · ${index % state.map.size + 1}, ${Math.floor(index / state.map.size) + 1}`;
      if (shrine) tile.title = '螢火遺跡 · ' + tile.title;
      if (crossing) tile.title = (state.map.cells[index] === 'ground' ? '便橋已架好' : '可架便橋') + ' · ' + tile.title;
      if ((state.map.rulesVersion || state.ticket.rulesVersion >= 13) && !blocked && state.map.cells[index] !== 'wall') {
        const {stamina, courage, ability} = Maze.stepCost(state, index);
        tile.title += ` · ${stamina} 體力${courage ? `／${courage} 膽量` : ''}`;
        if (ability) tile.title += ` · ${ability}`;
        const talent = Rules.expeditionAbility(state.ticket);
        if (state.map.cells[index] === 'spring' && talent?.springCourage && !state.claimed.has(index)) {
          tile.title += ` · ${talent.name}可恢復最多 ${talent.springCourage} 膽量`;
        }
      }
      const steps = stepsByTile.get(index);
      const badge = tile.firstElementChild;
      tile.classList.toggle('route-cell', Boolean(steps));
      badge.hidden = !steps;
      badge.textContent = steps ? steps.join('·') : '';
      const preview = steps ? ` · 預計第 ${steps.join('、')} 步` : '';
      tile.setAttribute('aria-label', (legal.includes(index) ? '引導至 ' : '') + tile.title + preview);
    });
    moveMarker();
    marker.classList.toggle('carrying', Boolean(state.cargo));
  }

  function moveMarker() {
    const position = state.position;
    if (markerPosition === position) return;
    const size = state.map.size;
    const x = position % size;
    const y = Math.floor(position / size);
    const previous = markerPosition;
    markerPosition = position;
    marker.style.setProperty('--x', x);
    marker.style.setProperty('--y', y);
    marker.classList.toggle('trail-top-row', y === 0);
    if (previous === null) return;

    const dx = previous % size - x;
    const dy = Math.floor(previous / size) - y;
    if (dx) marker.style.setProperty('--trail-facing', dx > 0 ? -1 : 1);
    const terrain = state.map.cells[position];
    const glides = terrain === 'swamp' && state.ticket.pet.species === 'dragon' && Rules.expeditionAbility(state.ticket);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    movement?.cancel();
    if (reducedMotion) {
      marker.classList.remove('stepping');
      sound.footstep(glides ? 'ground' : terrain);
      return;
    }
    marker.classList.add('stepping');
    const rise = glides ? 32 : terrain === 'swamp' ? 4 : 15;
    const duration = Math.min(clock.delay * .75, terrain === 'swamp' ? 490 : 380);
    const animation = marker.animate([
      { transform: `translate(${dx * 100}%, ${dy * 100}%)` },
      { transform: `translate(${dx * 92}%, ${dy * 92 + 4}%)`, offset: .17 },
      { transform: `translate(${dx * 37}%, ${dy * 37 - rise}%)`, offset: .64 },
      { transform: 'translate(0, 0)' }
    ], { duration, easing: 'ease-in-out' });
    movement = animation;
    animation.onfinish = () => {
      if (movement !== animation || !marker.isConnected) return;
      marker.classList.remove('stepping');
      sound.footstep(glides ? 'ground' : terrain);
      const landing = node('span', 'trail-landing ' + (terrain === 'swamp' && !glides ? 'trail-splash' : 'trail-dust'));
      tiles[position].append(landing);
      landing.animate([
        { transform: 'translate(-50%,-50%) scale(.35)', opacity: .8 },
        { transform: 'translate(-50%,-50%) scale(1.35)', opacity: 0 }
      ], { duration: 360 }).onfinish = () => landing.remove();
    };
  }

  function renderControls() {
    const active = state?.status === 'active';
    const running = clock.running;
    byId('toggle').textContent = running ? '暫停' : '繼續';
    byId('toggle').disabled = !active || Boolean(state?.encounter && !playback);
    byId('step').disabled = !active || running || Boolean(state?.encounter && !playback);
    byId('step-count').textContent = `${state?.steps || 0} 步`;
    byId('run-status').textContent = playback ? '紀錄重播' : !state ? '待出發' :
      active ? (state.encounter ? state.encounter.kind === 'exit' ? '出口抉擇' : '等待選擇' : running ? '探索中' : '已暫停') : state.status === 'success' ? '安全撤離' : '探索結束';
    byId('run-status').classList.toggle('live', Boolean(active && running));
    const key = [state?.ticket.id, state?.version, state?.status, running, Boolean(playback), app.busy].join('|');
    if (controlsKey === key) return;
    controlsKey = key;
    const panel = byId('direction-panel');
    const items = byId('run-items');
    panel.hidden = !active || Boolean(playback);
    items.replaceChildren();
    if (!active || playback) return;
    const count = Adventure.guidanceLeft(state);
    const choices = Adventure.options(state);
    const usesPoints = state.ticket.rulesVersion >= 7;
    remaining.textContent = usesPoints ? `引導點 ${count} / ${Rules.guidance.total}` : `剩 ${count} 次`;
    interventionNote.textContent = usesPoints ? '指路一步花 1 點，走完會暫停。引導點整場共用。' : count
      ? state.ticket.rulesVersion >= 2
        ? '引導一步後會暫停，並在原位設置 4 步路障。若封路會困住夥伴，會保留出口。'
        : '這場沿用舊版引導規則。開始新一場可使用路障。'
      : '本場干涉次數已用完，夥伴仍可自主探索。';
    directions.forEach(([direction, label], index) => {
      const choice = choices.find(candidate => candidate.direction === direction);
      const issue = !choice ? '岩牆或邊界' : choice.issue;
      const control = directionButtons[index];
      control.disabled = app.busy || count === 0 || Boolean(issue);
      control.replaceChildren(label, ...(issue ? [node('small', '', issue)] : []));
    });

    if (!running) {
      for (const [id, quantity] of Object.entries(state.bag)) {
        const item = Rules.items[id];
        const maximum = item.stat === 'stamina' ? state.ticket.pet.maxStamina : state.ticket.pet.maxCourage;
        const key = id === 'tonic' ? 'Q' : 'E';
        if (quantity > 0) items.append(keyButton(key, `${item.icon} ${item.name} ×${quantity}`,
          () => perform(() => Adventure.useItem(state, id)), { disabled: state[item.stat] === maximum }));
      }
      items.append(button('放棄本場', abandon, { className: 'text-button danger' }));
    }
  }

  function renderPet() {
    const panel = byId('run-pet');
    if (!state) {
      panel.replaceChildren(node('h2', '', '出戰夥伴'), node('p', 'muted', '出發後可查看目前的體力、膽量與情緒。'));
      return;
    }
    const pet = state.ticket.pet;
    const type = Rules.species[pet.species];
    const personality = Rules.personalities[pet.personality];
    panel.replaceChildren(
      node('div', 'pet-profile', node('div', 'avatar pet-art ' + pet.species),
        node('div', 'profile-name', node('h2', '', pet.name), node('p', 'muted', `${personality.name} · Lv. ${pet.level}`)),
        node('span', 'pill mood', Rules.moods[state.mood.key].name)),
      meter('體力', state.stamina, pet.maxStamina, 'stamina'),
      meter('膽量', state.courage, pet.maxCourage, 'courage'),
      node('div', 'traits', node('span', 'pill', `耐心 ${Number(state.patience.toFixed(1))} / ${pet.patience}`),
        node('span', 'pill', `${state.ticket.rulesVersion >= 4 ? '最短搬運' : 'BFS 最少'} ${state.map.shortest} 步`)));
  }

  function renderEncounter() {
    const body = byId('plan-body');
    body.hidden = state?.status !== 'active' || !state.encounter || Boolean(playback);
    if (body.hidden) { body.replaceChildren(); return; }
    if (state?.status === 'active' && state.encounter?.kind === 'exit' && !playback) {
      const full = Adventure.bank(state);
      const reduced = Adventure.bank(state, true);
      const itemText = items => Object.entries(items).map(([id, count]) => `${Rules.items[id].name} ×${count}`).join('、') || '無道具';
      body.replaceChildren(node('div', 'chest-choice',
        node('h3', '', `🚪 成功送達！已帶回 ${state.delivered} 個寶箱`),
        node('p', '', `現在收手 · ${full.coins} 金幣 · ${full.exp} EXP · ${itemText(full.items)}`),
        node('div', 'chest-options',
          keyButton('1', '帶走獎勵，結束冒險', () => perform(() => Adventure.resolveExit(state, 'cashout')), { className: 'button' }),
          keyButton('2', '繼續冒險，再找寶箱', () => perform(() => Adventure.resolveExit(state, 'continue')), { disabled: !Adventure.canContinue(state) })),
        node('p', 'fine-print', `若繼續後失敗，帶回 ${reduced.coins} 金幣 · ${reduced.exp} EXP · ${itemText(reduced.items)}。未送達寶箱會失去。`),
        node('p', 'muted fine-print', Adventure.canContinue(state) ? '繼續後可先補給，再按空白鍵出發。' : '剩餘資源不足或寶箱已全數送達。')));
      return;
    }
    if (state?.status === 'active' && state.encounter?.kind === 'lantern' && !playback) {
      body.replaceChildren(node('div', 'chest-choice',
        node('h3', '', '🏮 螢火遺跡'),
        node('p', '', '石台上有一盞螢火燈和一袋錢。只能帶走一件，送到出口才算到手。'),
        node('div', 'chest-options',
          keyButton('1', '解下螢火燈 · 3 體力', () => perform(() => Adventure.resolveLantern(state, 'lamp')),
            {className: 'button', disabled: app.busy || state.stamina <= 3}),
          keyButton('2', `帶走錢袋 · ${Rules.rewardCoins(28, state.ticket.rulesVersion)} 金幣`, () => perform(() => Adventure.resolveLantern(state, 'coins')), {disabled: app.busy}))));
      return;
    }
    if (state?.status === 'active' && state.encounter && !playback) {
      body.replaceChildren(node('div', 'chest-choice',
        node('h3', '', '🎁 寶箱裡還有一層暗格！'),
        node('p', '', '外層比較安全，要不要試著破解暗格？'),
        node('div', 'chest-options',
          keyButton('1', '穩拿獎勵｜8 金幣', () => perform(() => Adventure.resolveChest(state, 'safe')), { className: 'button' }),
          keyButton('2', '冒險破解｜60% 大獎', () => perform(() => Adventure.resolveChest(state, 'risk')), { disabled: state.stamina <= 6 })),
        node('p', 'fine-print', '破解成功得 18 金幣與 1 個道具；失敗損失 6 體力，沒有寶箱獎勵。至少需要 7 體力。'),
        node('p', 'muted fine-print', '開箱不消耗干涉次數。做完選擇後，按「繼續」出發。')));
      return;
    }
  }

  function renderTrailHud(next) {
    byId('trail-hud').hidden = !state;
    const cargo = byId('trail-cargo');
    cargo.hidden = !state || state.ticket.rulesVersion < 4;
    if (!state) return;
    const {pet} = state.ticket;
    const thought = byId('trail-thought');
    thought.hidden = !next;
    if (next) {
      const shortThought = !next.chosen ? (state.ticket.rulesVersion < 12 ? '走不動了，幫我補給再出發。' :
        next.shortage ? `${next.returnRisk ? '可能回不去……' : ''}下一格${next.shortage}，需要補給。` :
          '沒有可以前往的目標了。') :
        next.returnRisk ? (next.target.kind === 'spring' ? '可能回不去……先去泉水。' : '可能回不去……我還能往前走。') :
        next.explored ? '換條沒走過的路，目標不變！'
        : next.target.kind === 'spring' ? (Rules.expeditionAbility(state.ticket)?.springCourage && state.courage < pet.maxCourage
          ? '去泉水邊也能補點膽量。' : '先喝點泉水，補好體力再走。')
        : next.target.kind === 'exit' ? state.intent === 'exit' ? '聽你的，把寶箱帶回去。' : '先把身上的寶箱安全帶回去。'
        : next.target.kind === 'lantern' ? '我會去看看那盞螢火燈。'
          : state.intent === 'collect' ? '聽你的，繼續找下一箱！' : state.cargo ? '還有餘裕，再找一箱！' : '出發，找第一個寶箱！';
      thought.replaceChildren(node('span', 'thought-portrait pet-art ' + pet.species), node('span', '', shortThought));
    }
    const meters = statusMeters(pet, state).map(values => meter(...values));
    if (state.ticket.rulesVersion >= 6) {
      meters[2].title = `每步消耗 ${Rules.patiencePerStep} 耐心。若決定繼續搜寶，最多考慮 ${Rules.extraChestRange(pet, state.patience)} 步內的下一箱。`;
    }
    byId('trail-resources').replaceChildren(...meters);
    if (!cargo.hidden) {
      const count = state.cargo?.count || 0;
      const load = count * Rules.difficultyFor(state.map.difficulty, state.map.rulesVersion).cargoCost;
      const parts = [`攜帶 ${count} 箱${load ? `（每步 +${load} 體力）` : ''}`, `送達 ${state.delivered} 箱`];
      if (state.ticket.rulesVersion >= 7) parts.unshift(`引導點 ${Adventure.guidanceLeft(state)} / ${Rules.guidance.total}`);
      if (state.cargo?.items.fireflyLamp) parts.push('🏮 螢火燈');
      cargo.textContent = parts.join(' · ');
    }
  }

  function renderDecision(next) {
    const panel = byId('decision');
    panel.hidden = !next;
    if (!next) return;
    const cost = value => value === null ? '—' : value.toFixed(2);
    const weights = next.weights.actual.map(value => value.toFixed(2)).join(' / ');
    const base = next.weights.base.map(value => value.toFixed(2)).join(' / ');
    const type = Rules.personalities[state.ticket.pet.personality];
    const mood = Rules.moods[next.mood.key];
    const table = node('ul', 'candidate-list', directions.map(([direction, label]) => {
      const entry = next.candidates.find(candidate => candidate.direction === direction);
      const note = !entry ? '岩牆或邊界' : entry.issue || (entry === next.chosen ? '預計走這格'
        : entry === next.best ? '成本最低' : entry.cost > next.best.cost ? '成本較高' : '同成本，依順序排序');
      return node('li', '', node('span', '', label), node('span', '', entry ? cost(entry.cost) : '—'), node('span', '', note));
    }));
    const detail = node('details', 'cost-detail', node('summary', '', '下一步的權重與候選方向'),
      node('p', 'decision-reason', next.reason),
      node('p', 'muted fine-print', `距離 / 體力 / 膽量｜原權重 ${base}，本步 ${weights}。`),
      node('p', 'muted fine-print', state.ticket.rulesVersion >= 12
        ? `${type.name} · 優先走得完的路；回程可能走不完時先提醒，下一格走不動才會停。`
        : state.ticket.rulesVersion >= 4 ? `${type.name} · 搬運使用穩定的性格偏好，先確認整段路的資源足夠，再持續前往目標。`
        : `${type.name} · ${type.text} ${mood.name}情緒倍率 ${mood.weights.join(' / ')}。`),
      node('p', 'muted fine-print', `候選合理且通過冷卻等條件時，改道機率 ${Math.round(next.epsilon * 100)}%。`),
      table);
    detail.open = Boolean(panel.querySelector('.cost-detail')?.open);
    panel.replaceChildren(detail);
  }

  function resultCard(log, showRetry = false) {
    const inventory = Object.entries(log.items).map(([id, quantity]) => `${Rules.items[id].name} ×${quantity}`).join('、') || '—';
    const stats = [
      ['移動 / BFS 最少', `${log.steps} / ${log.shortest} 步`], ['體力 / 膽量消耗', `${log.spentStamina} / ${log.spentCourage}`],
      ['指路', `${log.interventions} 次`],
      ...(log.attempts ? [['歷史猜測正確率', `${log.correct} / ${log.attempts} · ${UI.accuracy(log.correct, log.attempts)}`]] : []),
      ['隨機改道', `${log.explorations} 次`], ['獎勵', `◉ ${log.coins} 金幣 · ${log.exp} EXP`], ['取得道具', inventory]
    ];
    return [
      node('div', 'section-kicker', playback ? 'REPLAY' : saved ? 'EXPEDITION COMPLETE / 已存檔' : 'EXPEDITION COMPLETE / 待存檔'),
      node('h2', '', log.result === 'success' ? log.ticket?.rulesVersion >= 4 ? '✦ 寶箱送達，安全撤離！' : '✦ 找到寶藏！' : '探索結束'),
      node('p', 'muted', `${log.petName} · ${Rules.personalities[log.personality].name} · ${Rules.difficulties[log.difficulty].name}`),
      log.failure ? node('p', 'failure-reason', log.failure) : null,
      node('p', '', log.summary),
      node('dl', 'result-grid', stats.map(([label, value]) => node('div', '', node('dt', '', label), node('dd', '', value)))),
      showRetry ? button(saving ? '存檔中…' : '重試結算', settle, { className: 'button', disabled: saving }) : null
    ].filter(Boolean);
  }

  function renderGame() {
    renderDeparture();
    const next = state && !playback ? Adventure.prepare(state) : null;
    if (!next) mapPreview = null;
    else if (mapPreview?.next !== next) mapPreview = Adventure.forecast(state);
    drawMap(mapPreview?.steps || []);
    renderControls();
    renderPet();
    renderEncounter();
    renderTrailHud(next);
    const behavior = byId('behavior-controls');
    behavior.hidden = !state || state.ticket.rulesVersion < 4 || state.status !== 'active' || Boolean(playback) || Boolean(state.encounter);
    if (!behavior.hidden) {
      const usesPoints = state.ticket.rulesVersion >= 7;
      const labels = { auto: '自主判斷', collect: '繼續搜寶', exit: '前往出口' };
      const keys = { auto: '0', collect: '1', exit: '2', lantern: '3' };
      if (state.lampSite && !state.claimed.has(state.lampSite.position)) labels.lantern = '前往螢火遺跡';
      behavior.replaceChildren(node('div', 'actions', node('strong', '', `目前：${labels[state.intent]}`),
        ...Object.entries(labels).map(([intent, label]) => keyButton(keys[intent], intent === 'auto' ? '恢復自主' : usesPoints ? `${label} · 3 點` : label, () => {
          clock.pause();
          perform(() => Adventure.chooseRoute(state, intent));
        }, { className: state.intent === intent ? 'intent-selected' : '', disabled: app.busy || state.intent === intent || (intent === 'exit' && !state.cargo) ||
          (usesPoints && intent !== 'auto' && Adventure.guidanceLeft(state) < Rules.guidance.goal) ||
          (intent === 'lantern' && !next?.lanternReachable) ||
          (intent === 'collect' && !Adventure.canContinue(state)) }))),
        node('p', 'muted fine-print', usesPoints ? '恢復自主免費，已花的點數不退回。' : '目標指令持續生效。'));
    }
    const contract = state && Adventure.mission(state);
    const missionPanel = byId('mission-progress');
    missionPanel.hidden = !contract;
    if (contract) {
      const mission = Rules.missions[contract.id];
      const complete = state.ticket.rulesVersion >= 4 ? Boolean(state.deliveryBonus) : state.status === 'success' && contract.complete;
      missionPanel.textContent = `${complete ? '✦ 委託完成' : mission.name} · ${contract.progress}`;
    }
    renderLanternTrail();
    renderDecision(next);
    const events = state?.events.slice(-16).reverse() || [];
    byId('event-log').replaceChildren(...(events.length ? events.map(event => node('li', '',
      node('span', 'event-step', `第 ${event.step} 步`), node('span', '', event.message))) : [node('li', 'muted', '目前還沒有事件。')]));
    const result = byId('result');
    result.hidden = !state || state.status === 'active';
    if (!result.hidden) result.replaceChildren(...resultCard(saved || playback?.log || Adventure.result(state, ''), !saved && !playback));
    byId('start').disabled = app.busy || !app.data?.pets.length || saving || historyBusy;
  }

  function renderLanternTrail() {
    const panel = byId('lantern-trail');
    panel.hidden = !state?.lampSite || Boolean(playback) || state.status !== 'active';
    if (panel.hidden) return;
    const {position, bridge, stepsSaved} = state.lampSite;
    const fromHere = Maze.bfs(Decision.navigationMap(state), state.position)[position];
    const fromShrine = Maze.bfs(state.map, position);
    const toExit = Math.min(...state.map.exits.map(exit => fromShrine[exit]));
    const distance = state.claimed.has(position) ? '' : `遺跡至少 ${Number.isFinite(fromHere) ? fromHere + ' 步' : '暫時無法抵達'} · 遺跡到最近出口 ${toExit} 步`;
    panel.replaceChildren();
    if (distance) panel.append(node('p', '', distance));
    if (bridge !== undefined && state.position === position && state.map.cells[bridge] !== 'ground') {
      panel.append(keyButton('B', '架便橋 · 1 引導點', () => {
        clock.pause();
        perform(() => Adventure.repairBridge(state));
      }, {disabled: app.busy || !Adventure.canRepairBridge(state)}),
      node('p', 'fine-print', stepsSaved ? `到最近出口的最短路程少 ${stepsSaved} 步。` :
        '跨過沼澤改按平地消耗計算。'));
    }
    panel.hidden = !panel.childElementCount;
  }

  function renderData(data) {
    UI.options(petSelect, data.pets.map(pet => [pet.id, `${Rules.species[pet.species].icon} ${pet.name} · Lv. ${pet.level}`]),
      petSelect.value || data.selected, '請先孵化寵物');
    UI.options(mapSelect, [['', '選擇地圖'], ...data.maps.slice().reverse().map(map =>
      [map.id, `${map.seed} · ${Rules.difficulties[map.difficulty].name}`])], mapSelect.value, '');
    updateMapButtons();
    const key = [data.revision, app.busy, historyBusy].join('|');
    if (journalKey !== key) {
      journalKey = key;
      const history = byId('history');
      history.replaceChildren(...(data.history.length ? data.history.map(log => {
        const label = `${log.result === 'success' ? '✦ 通關' : '撤回'} · ${log.petName} · ${Rules.difficulties[log.difficulty].name}`;
        const locked = app.busy || historyBusy || Boolean(data.active);
        return node('article', 'journal-entry', node('strong', '', label),
          node('p', 'muted fine-print', `${new Date(log.finishedAt).toLocaleString('zh-TW')} · ${log.steps} 步 · ◉ ${log.coins}`),
          node('p', 'fine-print', log.summary),
          node('div', 'actions',
            button('重播', () => openHistory(log.id, true), { disabled: locked }),
            button('匯出 JSON', () => openHistory(log.id, false), { disabled: app.busy || historyBusy }),
            button('刪除紀錄', () => {
              if (confirm('要刪除這筆冒險紀錄嗎？')) app.commit('deleteLog', { id: log.id });
            }, { className: 'text-button danger', disabled: app.busy || historyBusy })));
      }) : [node('p', 'empty', '完成一場探索後，紀錄會出現在這裡。')]));
    }
    renderGame();
  }

  function updateMapButtons() {
    byId('save-map').disabled = !app.data || app.busy;
    byId('update-map').disabled = !mapSelect.value || app.busy;
    byId('delete-map').disabled = !mapSelect.value || app.busy;
  }

  function tick() {
    if (playback) {
      perform(() => {
        Adventure.applyAction(state, playback.log.actions[playback.index]);
        playback.index++;
      });
    } else perform(() => Adventure.execute(state, Adventure.prepare(state)));
  }

  function clearPendingProgress() {
    clearTimeout(progressTimer);
    progressTimer = null;
    pendingProgress = null;
  }

  /*
   * 第一個未同步動作啟動計時，其後的動作用最新快照合併。
   * 前一批仍在傳送時保留下一批，避免移動速度被雲端往返時間綁住。
   */
  function scheduleProgress() {
    if (progressTimer !== null || syncingProgress || !pendingProgress) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      void syncProgress();
    }, 1800);
  }

  async function syncProgress() {
    if (syncingProgress || !pendingProgress) return;
    if (app.busy) { scheduleProgress(); return; }
    clearTimeout(progressTimer);
    progressTimer = null;
    // 取出本批後立刻清空欄位，傳送期間的新動作便能另存成下一批。
    const snapshot = pendingProgress;
    pendingProgress = null;
    syncingProgress = true;
    try {
      if (!await app.progress(snapshot)) pendingProgress ??= snapshot;
    } catch (error) {
      // 輸入和探索不等待雲端。完整步驟另存於此分頁，供下次同步驗證。
      UI.message('探索進度暫存在此分頁，雲端尚未同步：' + error.message, true);
    } finally {
      syncingProgress = false;
      scheduleProgress();
    }
  }

  function perform(action) {
    if (app.busy || saving) return;
    if (state?.status !== 'active') return;
    try {
      const before = { chests:state.chests, springs:state.springs, courage:state.courage, delivered:state.delivered, actions:state.actions.length };
      action();
      const lastAction = state.actions.at(-1)?.[0];
      if (state.status === 'success') feedback('安全撤離！獎勵正在存入背包。', 'success');
      else if (state.status === 'failure') feedback(state.delivered ? '冒險結束，已送達獎勵保留 50%。' : '這次沒能帶回寶箱，下次再試！', 'failure');
      else if (state.delivered > before.delivered) feedback(`送達成功！累計 ${state.delivered} 箱。決定收手或繼續冒險。`, 'delivery');
      else if (lastAction === 'chest' && state.actions.length > before.actions) feedback(state.chestOutcome, 'chest');
      else if (state.chests > before.chests) feedback(`找到寶箱！目前攜帶 ${state.cargo?.count || state.chests} 箱。`, 'chest');
      else if (state.springs > before.springs) {
        const courage = Number((state.courage - before.courage).toFixed(2));
        feedback(courage > 0 ? `喝到泉水！靈敏嗅覺也讓膽量 +${courage}。` : '喝到泉水，體力恢復了！', 'spring');
      }
      else if (state.actions.length > before.actions && lastAction === 'item') feedback('補給已使用，路線已重新計算。', 'item');
      else if (state.actions.length > before.actions && ['manual','route'].includes(lastAction)) feedback('已收到你的指令。確認路線後按「繼續」。', 'guide');
      if (state.encounter && !playback) clock.pause();
      pauseIfStuck();
      if (!playback && state.actions.length !== before.actions) {
        checkpoint();
        // 先重繪畫面，快速連續按鍵會合併到同一筆背景存檔。
        if (state.status === 'active') {
          pendingProgress = { id: state.ticket.id, actions: state.actions.slice() };
          scheduleProgress();
        }
      }
      if (state.status !== 'active') {
        clock.pause();
        if (!playback) void settle();
      }
      renderGame();
    } catch (error) {
      clock.pause();
      UI.message(error.message, true);
      renderGame();
    }
  }

  // 結算會送出完整動作，取消尚未傳送的批次，避免結算後又寫入舊進度。
  async function settle() {
    if (saving || playback || saved || app.busy || !state || state.status === 'active') return;
    saving = true;
    clearPendingProgress();
    renderGame();
    const result = await app.commit('settle', { id: state.ticket.id, actions: state.actions });
    if (result.ok) {
      saved = result.value;
      checkpoint(null);
    }
    saving = false;
    renderGame();
  }

  let abandonArmedUntil = 0;
  async function abandon(event) {
    clock.pause();
    if (Date.now() > abandonArmedUntil) {
      abandonArmedUntil = Date.now() + 8000;
      feedback('放棄會失去本場獎勵，已消耗的狀態與道具仍會保留。8 秒內再按一次確認放棄。', 'pause');
      if (event?.currentTarget) event.currentTarget.textContent = '再按一次確認放棄';
      return;
    }
    abandonArmedUntil = 0;
    clearPendingProgress();
    const result = await app.commit('abandon', { id: state.ticket.id, actions: state.actions });
    if (result.ok) {
      checkpoint(null);
      setRun(null);
      UI.message('已放棄本場探索。');
    }
  }

  async function openHistory(id, replay) {
    if (historyBusy) return;
    historyBusy = true;
    renderData(app.data);
    try {
      const log = await Repository.history(id);
      if (replay) {
        setRun(Adventure.create(log.ticket), log);
        board.scrollIntoView({ behavior: 'smooth', block: 'center' });
        UI.message('已載入重播。按「繼續」或「單步」播放當時的操作。');
      } else {
        const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
        const anchor = node('a');
        anchor.href = url;
        anchor.download = `adventure-${log.id}.json`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      UI.message(error.message, true);
    } finally {
      historyBusy = false;
      renderData(app.data);
    }
  }

  function manual(direction) {
    if (state?.status !== 'active' || playback || app.busy || Adventure.guidanceLeft(state) < Rules.guidance.step) return;
    const option = Adventure.options(state).find(next => next.direction === direction);
    if (!option || option.issue) return;
    clock.pause();
    perform(() => Adventure.intervene(state, direction));
  }

  const app = UI.client(renderData);
  petSelect.addEventListener('change', renderDeparture);
  setup.addEventListener('toggle', renderDeparture);
  setInterval(() => { if (!document.hidden) renderDeparture(); }, 5000);
  byId('adventure-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || historyBusy || app.busy) return;
    if (app.data.active) { UI.message('請先完成或放棄目前的探索。', true); return; }
    clock.pause();
    const input = { ...draft(), petId: petSelect.value };
    if (!byId('fixed-seed').checked) { input.mapSeed = ''; input.decisionSeed = ''; }
    const result = await app.commit('begin', input);
    if (!result.ok) return;
    setRun(Adventure.create(result.value));
    // Empty inputs keep generating new seeds on subsequent starts.
    mapSeed.value = input.mapSeed;
    decisionSeed.value = input.decisionSeed;
    checkpoint();
    clock.resume();
    pauseIfStuck();
    renderGame();
    board.focus({ preventScroll: true });
    window.scrollTo({top: 0});
  });
  function pauseIfStuck() {
    if (playback || state.ticket.rulesVersion < 4 || state.status !== 'active' || state.encounter) return;
    const next = Adventure.prepare(state);
    if (next?.chosen) return;
    clock.pause();
    const reason = state.ticket.rulesVersion < 12 ? '資源不足，已暫停。使用補給，或按「繼續」結束本場。' :
      next?.shortage ? `下一格${next.shortage}，已暫停。先補給，或按空白鍵結束本場。` :
        '沒有可前往的目標。按空白鍵結束本場。';
    feedback(reason, 'pause');
  }
  byId('toggle').addEventListener('click', () => {
    if (clock.running) clock.pause();
    else clock.resume();
    renderGame();
    feedback(clock.running ? '繼續探索中，隨時可以暫停。' : '已暫停，可以補給或改變目標。', 'pause');
  });
  byId('music-enabled').checked = sound.music;
  for (const option of missionSelect.options) {
    option.textContent += ` · +${Rules.rewardCoins(Rules.missions[option.value].coins, Rules.version)} 金幣`;
  }
  byId('effects-enabled').checked = sound.effects;
  byId('sound-volume').value = Math.round(sound.volume * 100);
  function soundStatus() {
    byId('sound-toggle').textContent = sound.waiting ? '播放音樂' : sound.enabled ? '靜音' : '開啟聲音';
    byId('sound-toggle').setAttribute('aria-pressed', String(sound.enabled && !sound.waiting));
  }
  for (const id of ['music-enabled','effects-enabled','sound-volume']) byId(id).addEventListener('input', () => {
    sound.configure(byId('music-enabled').checked, byId('effects-enabled').checked, Number(byId('sound-volume').value) / 100);
    soundStatus();
  });
  byId('sound-toggle').addEventListener('click', async () => {
    try {
      if (sound.enabled && !sound.waiting) sound.disable(); else await sound.enable();
      soundStatus();
      sound.play('guide');
    } catch (error) { UI.message(error.message, true); }
  });
  sound.start(soundStatus, byId('sound-toggle'));
  document.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input,select,textarea,[contenteditable]')) return;
    const key = event.key.toLowerCase();
    let control = /^[0-3beq]$/.test(key) ? document.querySelector(`[data-shortcut="${key}"]:not(:disabled)`) : null;
    if (control?.closest('[hidden]')) control = null;
    if (key === 'n') control = byId('step');
    if (event.code === 'Space' && !event.target.closest('button,summary')) control = byId('toggle');
    if (control && !control.disabled) {
      event.preventDefault();
      control.click();
      return;
    }
    const direction = {ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left'}[event.key];
    if (direction && state?.status === 'active' && !playback && !state.encounter) { event.preventDefault(); manual(direction); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clock.pause();
      void syncProgress();
    }
    renderGame();
  });
  byId('step').addEventListener('click', tick);
  byId('speed').addEventListener('change', event => {
    clock.setDelay(Number(event.target.value));
  });
  board.addEventListener('click', event => {
    const tile = event.target.closest('.target-cell');
    if (!tile || !state) return;
    const target = Adventure.options(state).find(next => next.position === Number(tile.dataset.position));
    if (target) manual(target.direction);
  });
  board.addEventListener('keydown', event => {
    if (!['Enter',' '].includes(event.key) || !event.target.classList.contains('target-cell')) return;
    event.preventDefault(); event.stopPropagation(); event.target.click();
  });
  mapSelect.addEventListener('change', () => {
    const selected = app.data.maps.find(map => map.id === mapSelect.value);
    if (selected) {
      difficulty.value = selected.difficulty;
      mapSeed.value = selected.seed;
      updateDifficultyNote();
    }
    updateMapButtons();
  });
  byId('save-map').addEventListener('click', async () => {
    const result = await app.commit('createMap', draft());
    if (result.ok) {
      mapSelect.value = result.value;
      mapSelect.dispatchEvent(new Event('change'));
      UI.message('已儲存地圖。');
    }
  });
  byId('update-map').addEventListener('click', async () => {
    const result = await app.commit('updateMap', { ...draft(), id: mapSelect.value });
    if (result.ok) UI.message('已用目前的難度與地圖 Seed 更新地圖。');
  });
  byId('delete-map').addEventListener('click', () => {
    if (confirm('要刪除這張已儲存的地圖嗎？冒險紀錄仍可重播。')) app.commit('deleteMap', { id: mapSelect.value });
  });
  renderGame();
  app.load().then(result => {
    if (!result.active) return;
    setRun(Adventure.replay(result.active, savedActions(result.active)));
    if (state.status === 'active' && state.actions.length > (result.active.progress || []).length) {
      pendingProgress = { id: state.ticket.id, actions: state.actions.slice() };
      scheduleProgress();
    }
    if (state.status !== 'active') void settle();
    else {
      feedback(state.ticket.rulesVersion < Rules.version
        ? '已載入舊版探索。按空白鍵繼續。'
        : '已載入探索進度，按空白鍵繼續。', 'pause');
      if (state.ticket.rulesVersion >= 12) pauseIfStuck();
    }
  }).catch(error => UI.message(error.message, true));
});
