'use strict';

var PetHome = (() => {
  const { byId, node, button, meter } = UI;
  const actors = new Map();
  const sound = new GameSound({theme:'home'});
  const world = byId('home-world');
  const yarn = byId('home-yarn');
  const balls = Object.fromEntries(Object.keys(Rules.rooms).map(id => [id, HomeLife.createBall(id)]));
  let lastHitCount = 0;
  world.style.setProperty('--pet-width', HomeLife.spriteWidth + '%');
  world.style.setProperty('--pet-foot', -HomeLife.spriteFoot * 100 + '%');
  let data, commit, selected, lastSelected, stamp = performance.now(), lastPaint = 0;
  let room, roomKey = '', moveKey = '', roomBusy = false;
  const roomStorageKey = Repository.playerKey('pet-home-room');
  const lifeStorageKey = Repository.playerKey('pet-home-life-v1');
  let widths = {};
  try { const saved = localStorage.getItem(roomStorageKey); if (Rules.own(Rules.rooms, saved)) room = saved; } catch {}
  let remembered = {};
  try { remembered = JSON.parse(localStorage.getItem(lifeStorageKey) || '{}') || {}; } catch {}
  function drawing(species) {
    return `<span class="home-sprite sprite-${species}" aria-hidden="true"></span>`;
  }
  function condition(pet) { return Rules.condition(pet, new Date().toISOString(), pet.away); }
  function feedback(text) { byId('home-feedback').textContent = text; }
  function activityLabel(life) {
    if (life.moving && life.state === 'eat') return '正走向飯碗。';
    if (life.moving && life.state === 'sleep') return '正走回窩裡。';
    if (life.ballTap > 0) return '把球拍走了！';
    if (life.moving && life.state === 'play') return '追著球跑！';
    return HomeLife.labels[life.state];
  }
  function add(pet) {
    const life = HomeLife.create(pet, remembered[pet.id]);
    const el = button('', () => {
      selected = pet.id;
      const action = HomeLife.touch(life, actors.get(pet.id).pet);
      feedback(`${pet.name}：${activityLabel(life)}`);
      if (action === 'love') sound.play('pet');
      if (action === 'flee') sound.play('shy');
      paintStatus();
    }, { className: 'home-pet' });
    el.innerHTML = `<span class="pet-bubble"></span><span class="puppet">${drawing(pet.species)}</span><span class="pet-name"></span>`;
    el.querySelector('.pet-name').textContent = pet.name;
    byId('home-pets').append(el);
    const actor = { life, el, pet }; actors.set(pet.id, actor); return actor;
  }

  function selectResident(preferred = selected) {
    const residents = data.pets.filter(pet => pet.room === room);
    selected = residents.find(pet => pet.id === preferred)?.id || residents.find(pet => !pet.away)?.id || residents[0]?.id;
  }

  function showRoom(id, preferred) {
    room = id;
    lastHitCount = balls[id].hits;
    selectResident(preferred);
    if (data.rooms.includes(room)) try { localStorage.setItem(roomStorageKey, room); } catch {}
    renderRoom();
    paintStatus();
  }

  function renderRoom() {
    const unlocked = data.rooms.includes(room);
    const residents = data.pets.filter(pet => pet.room === room);
    const key = JSON.stringify([room, data.coins, data.rooms, data.pets.map(pet => [pet.room, pet.away]), roomBusy]);
    if (key !== roomKey) {
      roomKey = key;
      byId('home-rooms').replaceChildren(...Object.entries(Rules.rooms).map(([id, info]) => {
        const owned = data.rooms.includes(id);
        const count = data.pets.filter(pet => pet.room === id).length;
        const tab = button(`${info.icon} ${info.name} · ${owned ? count + ' 隻' : info.price + ' 金幣'}`, () => {
          showRoom(id);
          byId('home-rooms').querySelector('[aria-pressed="true"]')?.focus();
        }, {className:'home-room-tab', disabled:roomBusy});
        tab.setAttribute('aria-pressed', String(id === room));
        return tab;
      }));
    }
    const info = Rules.rooms[room];
    const unlock = byId('home-room-unlock');
    unlock.hidden = unlocked;
    unlock.disabled = roomBusy || data.coins < info.price;
    unlock.textContent = `解鎖${info.name} · ${info.price} 金幣`;
    byId('home-room-note').textContent = info.text + (unlocked ? '' :
      data.coins < info.price ? ` 再存 ${info.price - data.coins} 金幣就能解鎖。` : ' 解鎖後就能讓夥伴住進來。');
    world.dataset.room = room;
    world.dataset.preview = String(!unlocked);
    sound.setRoom(room);
    const scene = HomeLife.layout(room);
    for (const [label, point] of [['bed', scene.sleep], ['food', scene.bowl], ['toy', scene.toy]]) {
      world.style.setProperty(`--${label}-x`, point[0] + '%');
      world.style.setProperty(`--${label}-y`, point[1] + '%');
    }
    world.style.setProperty('--pet-width', widths[room] + '%');
    for (const actor of actors.values()) actor.el.hidden = actor.pet.room !== room;
    yarn.hidden = !unlocked;
    paintBall();
    const empty = byId('home-empty');
    empty.hidden = !unlocked || residents.some(pet => !pet.away);
    empty.textContent = residents.length ? '這間房的夥伴正在探險。' :
      data.pets.length ? '這間房還沒有住客。到有寵物的房間選一隻夥伴，就能幫牠搬過來。' : '小屋還空著。先孵化第一位夥伴吧！';
    byId('home-firefly-lamp').hidden = room !== 'cottage' || !data.inventory.fireflyLamp;
  }

  function paintBall() {
    const ball = balls[room];
    yarn.style.left = ball.x + '%'; yarn.style.top = ball.y + '%';
    yarn.style.zIndex = String(Math.round(ball.y) + 1);
    yarn.style.setProperty('--ball-spin', ball.spin + 'deg');
  }

  function leaveBall(actor) {
    const ball = balls[actor.pet.room];
    if (ball.playerId === actor.pet.id) { ball.playerId = null; ball.to = null; }
  }

  byId('home-room-unlock').addEventListener('click', async () => {
    const id = room;
    roomBusy = true;
    renderRoom();
    const result = await commit('unlockRoom', {roomId:id});
    roomBusy = false;
    showRoom(id);
    if (result.ok) feedback(`已解鎖${Rules.rooms[id].name}！可以把夥伴搬進來了。`);
  });

  function renderMove(actor) {
    const panel = byId('home-move');
    const pet = actor?.pet;
    const destinations = data.rooms.filter(id => id !== room);
    const key = JSON.stringify([pet?.id, pet?.name, pet?.away, destinations, roomBusy]);
    panel.hidden = !pet || !destinations.length;
    if (key === moveKey) return;
    moveKey = key;
    if (panel.hidden) return;
    const options = node('select');
    options.id = 'pet-destination';
    UI.options(options, [['', '選擇房間'], ...destinations.map(id => [id, Rules.rooms[id].name])], '');
    options.disabled = pet.away || roomBusy;
    const move = button('搬房間', async () => {
      const destination = options.value;
      roomBusy = true;
      renderMove(actor);
      const result = await commit('movePet', {petId:pet.id, roomId:destination});
      roomBusy = false;
      if (result.ok) {
        showRoom(destination, pet.id);
        feedback(`${pet.name} 搬進${Rules.rooms[destination].name}了。`);
      } else {
        renderRoom();
        paintStatus();
      }
    }, {disabled:true});
    options.addEventListener('change', () => { move.disabled = !options.value; });
    const label = node('label', 'fine-print', `幫 ${pet.name} 搬家`);
    label.htmlFor = options.id;
    panel.replaceChildren(label, node('div', 'inline', options, move));
  }

  function sync(next, handler) {
    data = next; commit = handler;
    const focus = data.pets.find(pet => pet.id === data.selected);
    if (!room || (lastSelected !== undefined && data.selected !== lastSelected && focus)) {
      room = focus?.room || 'cottage';
      selected = focus?.id;
      lastHitCount = balls[room].hits;
    }
    lastSelected = data.selected;
    selectResident(selected || focus?.id);
    widths = Object.fromEntries(Object.keys(Rules.rooms).map(id => [id, HomeLife.widthFor(data.pets.filter(pet => pet.room === id).length)]));
    for (const [id,actor] of actors) if (!data.pets.some(p=>p.id===id)) { leaveBall(actor); actor.el.remove(); actors.delete(id); }
    for (const pet of data.pets) {
      const actor = actors.get(pet.id) || add(pet);
      if (actor.pet.room !== pet.room) {
        leaveBall(actor);
        Object.assign(actor.life, HomeLife.create(pet, actor.life), {ball:null, ballTap:0, invite:null});
      }
      actor.pet = pet;
      actor.el.querySelector('.pet-name').textContent = pet.name;
    }
    const lamp = byId('home-firefly-lamp');
    const origin = data.history.find(entry => entry.items?.fireflyLamp);
    lamp.dataset.story = origin ? `${origin.petName} 帶回的螢火燈 · ${new Date(origin.finishedAt).toLocaleDateString('zh-TW')}`
      : '從螢火遺跡帶回的紀念品。';
    byId('home-adventure').href = Repository.isSheets ? '?page=adventure' : 'adventure.html';
    renderRoom();
    paintStatus();
  }
  function paintStatus() {
    const actor = actors.get(selected), panel = byId('home-status');
    byId('home-invitations').hidden = !actor || actor.pet.away;
    byId('home-tree-details').hidden = !actor;
    byId('home-adventure').hidden = !actor;
    renderMove(actor);
    if (!actor) {
      panel.replaceChildren(node('h2','',Rules.rooms[room].name), node('p','muted',
        data.rooms.includes(room) ? '這間房還沒有住客。' : '房間預覽'));
      byId('home-care').replaceChildren();
      byId('home-care').dataset.key = '';
      return;
    }
    const {pet,life} = actor, c = condition(pet);
    panel.replaceChildren(node('h2','',pet.name), node('p','home-thought',pet.away ? HomeLife.labels.away : activityLabel(life)),
      node('div','home-resources',meter('體力',Math.floor(c.stamina),pet.maxStamina,'stamina'),meter('膽量',Math.floor(c.courage),pet.maxCourage,'courage'),meter('耐心',Math.floor(c.patience),pet.patience,'patience')),
      node('p','fine-print',`肚子 ${life.hunger>68?'餓了':life.hunger<20?'飽飽的':'還好'} · 精神 ${life.energy<24?'想睡':life.energy>75?'很有精神':'放鬆中'}`));
    byId('home-tree').replaceChildren(...[['sleep','累了 → 去窩裡睡覺'],['eat','餓了 → 走去吃飯'],['rest','膽量或耐心低 → 安靜休息'],['play','收到玩球邀請 → 玩一會兒'],['wander','沒有急事 → 自己探索小屋']].map(([key,text])=>node('li',life.state===key?'branch-active':'',text)));
    // Do not rebuild focused controls every animation frame.
    const careKey = pet.id + JSON.stringify(data.inventory) + pet.away;
    if (byId('home-care').dataset.key !== careKey) {
      byId('home-care').dataset.key = careKey;
      byId('home-care').replaceChildren(...Object.entries(Rules.items).filter(([id,item])=>data.inventory[id] && ['adventure','recovery'].includes(item.type)).map(([id,item])=>button(`${item.icon} ${item.name} ×${data.inventory[id]}`,async()=>{
        const result = await commit('care',{petId:pet.id,itemId:id});
        if(result.ok) { feedback(`${pet.name}使用了${item.name}。`); sound.play('item'); }
      },{disabled:pet.away})));
    }
  }
  for(const [id,state,text] of [['home-bed','sleep','窩已經準備好了，想睡就來吧。'],['home-food','eat','新鮮的飯飯準備好了。'],['home-toy','play','球球滾過來了，來玩吧！']]) byId(id).addEventListener('click',()=>{
    const actor=actors.get(selected); if(!actor || actor.pet.away) { feedback('先選一位在家的夥伴。'); return; }
    const {life} = actor;
    if (state === 'play') {
      const ball = balls[room];
      const other = actors.get(ball.playerId);
      if (other && other !== actor) {
        if (other.life.state === 'play') other.life.held = 0;
        if (other.life.invite === 'play') other.life.invite = null;
      }
      ball.playerId = actor.pet.id;
    }
    if (life.state !== state) {
      life.invite = state;
      if (life.state !== 'sleep' && life.state !== 'eat') life.held = 0;
    }
    feedback(state === 'play' && ['sleep', 'eat', 'rest'].includes(life.state)
      ? '球準備好了，等牠忙完再一起玩。' : text);
    if (state === 'eat') sound.play('food');
    if (state === 'play') sound.play('ball');
  });
  yarn.addEventListener('click', () => byId('home-toy').click());
  document.querySelectorAll('[data-invite]').forEach(el => el.addEventListener('click', () => byId(el.dataset.invite).click()));
  byId('home-firefly-lamp').addEventListener('click', event => {
    feedback(event.currentTarget.dataset.story);
    sound.play('spring');
  });
  byId('home-adventure').addEventListener('click',async event=>{
    if(!selected || data.selected===selected) return;
    event.preventDefault();const result=await commit('select',{petId:selected});if(result.ok) location.href=byId('home-adventure').href;
  });
  function soundStatus() {
    byId('home-sound').textContent = sound.waiting ? '♫ 播放小屋音樂' : sound.enabled ? '♫ 小屋靜音' : '♫ 開啟小屋聲音';
    byId('home-sound').setAttribute('aria-pressed', String(sound.enabled && !sound.waiting));
    byId('home-audio-status').textContent = !sound.enabled ? '目前靜音 · 點一下開關，讓小屋響起音樂與生活聲。' :
      sound.volume === 0 ? '音量目前為 0，拉高音量就聽得見。' :
      `${sound.waiting ? '點一下畫面即可播放音樂' : sound.music ?
        (sound.track.error ? '目前無法載入音樂' : '播放中：' + sound.trackName) : '背景音樂已關閉'} · ${sound.effects ? '互動音效開啟' : '互動音效關閉'}`;
  }
  byId('home-music').checked = sound.music;
  byId('home-effects').checked = sound.effects;
  byId('home-volume').value = Math.round(sound.volume*100);
  for (const id of ['home-music','home-effects','home-volume']) byId(id).addEventListener('input',()=>{
    sound.configure(byId('home-music').checked,byId('home-effects').checked,Number(byId('home-volume').value)/100); soundStatus();
  });
  byId('home-sound').addEventListener('click',async()=>{try {
    if(sound.enabled && !sound.waiting) sound.disable(); else { await sound.enable(); sound.play('pet'); }
    soundStatus();
  } catch {feedback('目前無法播放聲音，仍然可以和夥伴互動。');} });
  sound.start(soundStatus, byId('home-sound'));
  let lastAmbient = 0, previousState = '';
  function save() { try {localStorage.setItem(lifeStorageKey,JSON.stringify(Object.fromEntries([...actors].map(([id,a])=>[id,{hunger:a.life.hunger,energy:a.life.energy,social:a.life.social}]))));} catch {} }
  setInterval(save,5000); window.addEventListener('pagehide',save);
  document.addEventListener('visibilitychange',()=>{stamp=performance.now();if(document.hidden)save();});
  function frame(now) {
    const dt=(now-stamp)/1000;stamp=now;
    if(!document.hidden && data) {
      for(const actor of actors.values()) {
        const {life,pet,el} = actor;
        HomeLife.tick(life,pet,condition(pet),dt,Math.random,widths[pet.room],balls[pet.room]);
        if (pet.room !== room) continue;
        if (pet.id === selected && !pet.away) {
          const activity = life.moving ? 'moving' : life.state;
          if (activity !== previousState) {
            if (activity === 'sleep') sound.play('sleep');
            if (activity === 'eat') sound.play('nibble');
            previousState = activity;
          }
          if (now - lastAmbient > (life.moving ? 950 : 2800)) {
            if (life.moving) sound.play('paw'); else if (life.state === 'eat') sound.play('nibble');
            lastAmbient = now;
          }
        }
        el.style.left=life.x+'%';el.style.top=life.y+'%';el.style.zIndex=String(Math.round(life.y));
        el.dataset.state=pet.away?'away':life.state;el.classList.toggle('walking',life.moving);el.classList.toggle('selected',selected===pet.id);
        el.classList.toggle('ball-tapping', life.ballTap > 0);
        el.style.setProperty('--facing',life.facing);
        el.setAttribute('aria-label', `${pet.name}，${activityLabel(life)} 點一下摸摸`);
        let bubble = '';
        if (life.state === 'love') bubble = '♥ ♥';
        if (life.state === 'flee') bubble = '等一下～';
        if (!life.moving && life.state === 'sleep') bubble = 'z Z';
        if (!life.moving && life.state === 'eat') bubble = '飯飯！';
        el.querySelector('.pet-bubble').textContent = bubble;
      }
      paintBall();
      if (balls[room].hits > lastHitCount) sound.play('ball');
      lastHitCount = balls[room].hits;
      if(now-lastPaint>1000) {paintStatus();lastPaint=now;}
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {sync};
})();
