'use strict';

(() => {
  const { byId, node, button } = UI;
  const target = byId('training-pet');
  let lastPurchase = null;
  let selectedItem = null;
  let targetId = '';

  function bagResult(message, kind = '') {
    const status = byId('bag-result');
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = !message;
    if (message) {
      status.scrollIntoView({block:'nearest'});
      if (byId('bag-use').hidden) status.focus({preventScroll:true});
    }
  }

  function selection() {
    return app.data?.pets.find(pet => pet.id === targetId && !pet.away);
  }

  function renderUse() {
    const data = app.data;
    const item = Rules.items[selectedItem];
    const panel = byId('bag-use');
    panel.hidden = !item || !data.inventory[selectedItem];
    if (panel.hidden) return;
    const available = data.pets.filter(pet => !pet.away);
    if (!available.some(pet => pet.id === targetId)) targetId = '';
    UI.options(target, [['', '請選擇一位夥伴'], ...available.map(pet => [pet.id, `${pet.name} · Lv. ${pet.level} ${Rules.species[pet.species].name}`])], targetId);
    target.disabled = app.busy || !available.length;
    byId('bag-use-title').textContent = `${item.icon} 使用${item.name}`;
    const pet = selection();
    const odds = pet && item.iv ? Rules.trainingOdds(pet, item) : null;
    const maxLevel = pet && selectedItem === 'treat' && pet.level >= Rules.maxLevel;
    const full = pet && ['adventure', 'recovery'].includes(item.type) &&
      Rules.condition(pet)[item.stat] >= pet[{stamina:'maxStamina',courage:'maxCourage',patience:'patience'}[item.stat]];
    byId('bag-use-info').textContent = !available.length ? '目前沒有在家的寵物可以使用。' :
      odds ? `${Rules.ivLabels[item.iv]}個體值 ${odds.current} / ${Rules.ivCap} · ${UI.trainingNote(odds)}` +
        (odds.chance && odds.chance !== 100 ? '（失敗會消耗道具，連續失敗 3 次後保底）' : '') :
      maxLevel ? '這隻寵物已達最高等級。' : full ? '這項狀態已恢復滿了。' : item.text;
    const confirm = byId('confirm-use');
    confirm.textContent = pet ? `給 ${pet.name} 使用` : '確認使用';
    confirm.disabled = app.busy || !pet || odds?.chance === 0 || maxLevel || full;
  }

  function render(data) {
    byId('shop-coins').textContent = '◉ ' + data.coins;
    const entries = Object.entries(Rules.items);
    byId('catalog').replaceChildren(...entries.filter(([, item]) => item.type !== 'souvenir').map(([id, item]) => {
      const buy = button(`◉ ${item.price} · 購買`, async () => {
        const now = performance.now();
        if (lastPurchase?.id === id && now - lastPurchase.time < 400) return;
        lastPurchase = { id, time: now };
        const result = await app.commit('buy', { itemId: id });
        if (result.ok) UI.message(`已購買${item.name} ×1。`);
      }, { disabled: app.busy || data.coins < item.price || data.inventory[id] >= Rules.maxItems });
      return node('article', 'item-card', node('span', 'item-icon ' + item.type, item.icon),
        node('span', 'pill', item.type === 'adventure' ? '探索補給' : '夥伴養成'), node('h3', '', item.name),
        node('p', 'muted', item.text), buy);
    }));
    const owned = entries.filter(([id]) => data.inventory[id] > 0);
    byId('inventory').replaceChildren(...(owned.length ? owned.map(([id, item]) => {
      const use = button('使用', () => {
        if (selectedItem !== id) bagResult('');
        selectedItem = id;
        targetId = '';
        renderUse();
        if (target.disabled) byId('cancel-use').focus(); else target.focus();
      }, { disabled: app.busy });
      use.setAttribute('aria-label', '使用' + item.name);
      return node('div', 'bag-row', node('span', 'bag-icon', item.icon),
        node('div', 'bag-name', node('strong', '', item.name), node('small', 'muted', item.text)),
        node('span', 'pill', '×' + data.inventory[id]), item.type === 'souvenir' ? null : use);
    }) : [node('p', 'empty', '背包目前是空的。')]));
    renderUse();
  }

  const app = UI.client(render);
  target.addEventListener('change', () => { targetId = target.value; renderUse(); });
  byId('cancel-use').addEventListener('click', () => {
    const item = Rules.items[selectedItem];
    selectedItem = null;
    renderUse();
    [...byId('inventory').querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '使用' + item?.name)?.focus();
  });
  byId('confirm-use').addEventListener('click', async () => {
    const pet = selection();
    if (!pet || !selectedItem) return;
    const id = selectedItem;
    const item = Rules.items[id];
    const result = await app.commit(item.type === 'training' ? 'train' : 'care', { petId: pet.id, itemId: id });
    if (!result.ok) {
      bagResult(byId('notice').textContent || '這次無法使用道具，請再試一次。', 'failure');
      return;
    }
    if (!item.iv) bagResult(`${pet.name} 使用了${item.name}。`, 'success');
    else if (result.value?.success) {
      const trained = app.data.pets.find(entry => entry.id === pet.id);
      const increase = trained[item.stat] - pet[item.stat];
      bagResult(`培養成功！${pet.name}的${Rules.ivLabels[item.iv]}個體值 +1，現在是 ${trained.iv[item.iv]}/${Rules.ivCap}。` +
        (increase > 0 ? `能力上限也增加 ${increase} 點。` : ''), 'success');
    }
    else {
      const odds = Rules.trainingOdds(selection() || app.data.pets.find(entry => entry.id === pet.id), item);
      bagResult(`培養沒成功。${pet.name}的個體值沒有變化，已消耗 1 個${item.name}。${odds.chance === 100 ?
        '下次培養這一項一定成功。' : `保底進度 ${odds.misses}/3。`}`, 'failure');
    }
  });
  app.load().catch(error => UI.message(error.message, true));
})();
