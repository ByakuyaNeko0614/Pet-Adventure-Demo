'use strict';

Repository.startPage(() => {
  const {byId, node} = UI;
  const form = byId('hatch-form');
  const field = byId('pet-name');
  const nest = byId('hatch-nest');
  const openEgg = byId('open-egg');
  const reveal = byId('new-pet');
  let opening = false;
  let namedId = null;
  let shownPet = '';

  function render(data) {
    const {egg} = data;
    const pending = data.pets.find(pet => pet.needsName);
    const pet = pending || data.pets.find(pet => pet.id === namedId);
    const starter = data.hatched === 0;
    const price = Rules.hatchPrice(data.hatched);
    const minutes = Rules.incubationSeconds(data.hatched) / 60;
    byId('hatch-offer').hidden = Boolean(egg || pet);
    byId('hatch-title').textContent = starter ? '你的第一位夥伴' : `第 ${data.hatched + 1} 顆蛋`;
    byId('egg-status').hidden = !egg;
    byId('hatch-button').disabled = app.busy || opening || data.pets.length >= Rules.maxPets || data.coins < price;
    byId('hatch-button').textContent = starter ? '孵化第一顆蛋' : '把蛋放進窩';
    byId('hatch-cost').textContent = data.pets.length >= Rules.maxPets ? '寵物欄位已滿。' :
      starter ? '免費 · 立即破殼' : `${price} 金幣 · 孵化 ${minutes} 分鐘${data.coins < price ? ' · 金幣不足' : ''}`;
    nest.hidden = Boolean(pet);
    reveal.hidden = !pet;
    form.hidden = !pending;
    byId('save-new-name').disabled = app.busy;
    byId('incubation-note').hidden = Boolean(pet) || (starter && !egg);
    byId('nursery-home').textContent = pet && !pending ? '帶夥伴回家' : '返回寵物窩';
    if (egg) byId('egg-name').textContent = egg.name ? egg.name + '的蛋' : '第 ' + (data.hatched + 1) + ' 顆蛋';
    if (pet && shownPet !== pet.id + pet.name + Boolean(pending)) {
      shownPet = pet.id + pet.name + Boolean(pending);
      const iv = pet.iv;
      byId('pet-reveal').replaceChildren(node('div', 'home-sprite nursery-pet sprite-' + pet.species),
        node('h2', '', pending ? `一隻${Rules.species[pet.species].name}破殼了！` : `${pet.name}，歡迎回家！`),
        node('p', '', Rules.personalities[pet.personality].name),
        node('p', 'fine-print', Object.entries(Rules.ivLabels).map(([key, label]) => `${label} ${iv[key]}`).join(' · ') +
          `（個體值共 ${Object.values(iv).reduce((sum, value) => sum + value, 0)}）`));
    }
    updateEgg();
  }

  function updateEgg() {
    const egg = app.data?.egg;
    if (!egg) { nest.dataset.taps = '0'; return; }
    const total = Date.parse(egg.readyAt) - Date.parse(egg.startedAt);
    const left = app.data.hatched === 0 ? 0 : Math.max(0, Date.parse(egg.readyAt) - Date.now());
    const ready = left === 0;
    const progress = ready ? 100 : Rules.clamp(100 * (1 - left / Math.max(1, total)), 0, 100);
    nest.dataset.taps = ready ? '3' : progress >= 85 ? '2' : '0';
    byId('hatch-stage').textContent = ready ? '蛋殼裂開了，牠準備好見你了！' :
      progress >= 85 ? '蛋殼開始出現裂紋。' : progress >= 50 ? '蛋裡傳來輕輕的敲擊。' : '蛋在窩裡慢慢暖起來。';
    byId('egg-progress').value = progress;
    const seconds = Math.ceil(left / 1000);
    byId('egg-time').textContent = ready ? '孵化完成' : `還需 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    openEgg.hidden = !ready;
    openEgg.disabled = opening || app.busy;
  }

  const app = UI.client(render);
  byId('nursery-home').href = Repository.isSheets ? '?page=hatch' : 'hatch.html';
  byId('hatch-button').addEventListener('click', async () => {
    const starter = app.data.hatched === 0;
    const result = await app.commit('incubate', {});
    if (starter && result.ok) await hatch(true);
  });
  openEgg.addEventListener('click', () => hatch());
  async function hatch(starter = false) {
    const egg = app.data?.egg;
    if (!egg || opening || (!starter && app.data.hatched > 0 && Date.now() < Date.parse(egg.readyAt))) return;
    opening = true;
    updateEgg();
    try {
      const crack = nest.querySelector('.egg-crack');
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches && crack.animate) {
        await crack.animate([{opacity:.25}, {opacity:1}, {opacity:.65}, {opacity:1}], {duration:350}).finished.catch(() => {});
      }
      const result = await app.commit('hatch', {id: egg.id});
      if (result.ok) field.focus();
    } finally {
      opening = false;
      render(app.data);
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const pet = app.data.pets.find(entry => entry.needsName);
    if (!pet) return;
    namedId = pet.id;
    const result = await app.commit('rename', {petId: pet.id, name: field.value});
    if (result.ok) byId('nursery-home').focus();
    else namedId = null;
  });
  setInterval(updateEgg, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !app.busy && !opening) app.load(true).catch(error => UI.message(error.message, true));
  });
  app.load().catch(error => UI.message(error.message, true));
});
