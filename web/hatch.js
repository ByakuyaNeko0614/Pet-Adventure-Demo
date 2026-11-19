'use strict';

Repository.startPage(() => {
  const { byId, node, button, meter } = UI;
  const personalityTips = {
    impatient: '偏好步數少的路，即使要多花體力或膽量；通常帶兩箱就想撤離。',
    steady: '願意多走幾步來節省體力和膽量；通常帶兩箱就想撤離。',
    timid: '特別在意膽量消耗，會避開森林等危險路線；通常帶一箱就想撤離。',
    adventurous: '有餘力時願意多找一箱，也比較常試岔路；通常最多帶三箱再撤離。'
  };
  const ivItems = {stamina:'staminaSeed', courage:'courageSeed', patience:'badge'};
  let profileKey = '';
  function routeSummary(pet, personality) {
    const risk = pet.traits.riskTolerance;
    if (pet.personality === 'impatient' && risk <= .40) {
      return '牠偏好少走幾步；但兩條路只差一點時，比其他急躁型更願意選省體力或膽量的路。';
    }
    if (risk <= .40) return personality.text + ' 遇到消耗相差較大的路，牠會更在意能省下多少體力與膽量。';
    if (risk >= .59) return personality.text + ' 如果另一條路能省下不少步數，牠也比較能接受多花一些體力或膽量。';
    return personality.text;
  }

  function currentStats(pet) {
    return [['體力', Math.floor(pet.condition.stamina), pet.maxStamina, 'stamina'],
      ['膽量', Math.floor(pet.condition.courage), pet.maxCourage, 'courage'],
      ['耐心', Math.floor(pet.condition.patience), pet.patience, 'patience'],
      ...(pet.level === Rules.maxLevel ? [] : [['經驗', pet.exp, Rules.expNeeded(pet.level), 'xp']])];
  }

  function individualStats(pet, training) {
    return node('details', 'individual-values', node('summary', '', '個體值：牠的長期天賦'),
      node('p', 'fine-print', '上面的「體力 ', node('span', 'iv-example', `${Math.floor(pet.condition.stamina)} / ${pet.maxStamina}`),
        '」是目前剩餘的體力。下面的個體值是長期天賦，探索不會扣掉它。出生三項合計 80～100，每項最多 40；培養可以練到 50。'),
      node('div', 'individual-stat-cards', Object.entries(Rules.ivLabels).map(([key, label]) => {
        const item = Rules.items[ivItems[key]];
        const odds = Rules.trainingOdds(pet, item);
        return node('div', 'individual-stat', node('strong', '', `${label}天賦 ${odds.current} / ${Rules.ivCap}`),
          node('small', 'muted', `${item.name} · ${UI.trainingNote(odds)}`));
      })),
      node('p', 'fine-print', '41～43 需要 Lv. 5，44～46 需要 Lv. 8，47～50 需要 Lv. 11。每次成功天賦 +1；超過 40 後，對應的能力上限每點也多 1。'),
      node('p', 'fine-print', '失敗會消耗道具，但同一項連續失敗 3 次後，下次一定成功。 ', training));
  }

  function explain(label, description, key, badge = false) {
    const id = 'pet-tip-' + key;
    const trigger = button(label, event => event.currentTarget.focus(), {className: 'pet-tip-label' + (badge ? ' pill' : '')});
    trigger.setAttribute('aria-describedby', id);
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); trigger.blur(); }
    });
    const tip = node('span', 'pet-tip-copy', description);
    tip.id = id;
    tip.setAttribute('role', 'tooltip');
    return node('span', 'pet-tip', trigger, tip);
  }

  function render(data) {
    PetHome.sync(data, (op, input) => app.commit(op, input));
    const nursery = byId('go-to-hatch');
    nursery.href = Repository.isSheets ? '?page=nursery' : 'nursery.html';
    nursery.textContent = data.pets.some(pet => pet.needsName) ? '幫剛破殼的夥伴取名' :
      data.egg ? '查看孵化中的蛋' : data.hatched === 0 ? '免費孵化第一位夥伴' : '前往孵化室';
    byId('pet-count').textContent = `${data.pets.length} / ${Rules.maxPets}`;
    byId('pet-list').replaceChildren(...data.pets.map(pet => {
      const type = Rules.species[pet.species];
      const select = button('', () => app.commit('select', { petId: pet.id }), {
        className: 'pet-tab ' + type.color, disabled: app.busy
      });
      select.append(node('span', 'avatar small pet-art ' + pet.species), node('span', '', pet.name));
      select.setAttribute('aria-pressed', String(pet.id === data.selected));
      return select;
    }));
    const pet = data.pets.find(candidate => candidate.id === data.selected);
    const details = byId('pet-detail');
    if (!pet) {
      profileKey = '';
      details.replaceChildren(node('div', 'empty', node('span', 'empty-icon', '✧'), '還沒有夥伴。先孵化一顆蛋吧！'));
      return;
    }
    const stats = currentStats(pet);
    const key = JSON.stringify([data.revision, pet.id, app.busy]);
    if (profileKey === key) {
      details.querySelectorAll('.pet-current-stats .meter').forEach((entry, index) => {
        const [, value, max] = stats[index];
        entry.querySelector('progress').value = value;
        entry.querySelector('.meter-label span:last-child').textContent = `${value} / ${max}`;
      });
      details.querySelector('.iv-example').textContent = `${stats[0][1]} / ${stats[0][2]}`;
      return;
    }
    profileKey = key;
    const previousOpen = new Set([...details.querySelectorAll('details[open]')].map(entry => entry.className));

    const type = Rules.species[pet.species];
    const personality = Rules.personalities[pet.personality];
    const trait = (key, high, medium, low) => {
      const value = pet.traits[key];
      return explain(...(value >= .59 ? high : value <= .40 ? low : medium), key, true);
    };
    const traits = [
      trait('curiosity',
        ['喜歡探索', '有餘力時，會考慮離自己更遠的下一個寶箱。'],
        ['偶爾好奇', '資源夠的時候，會考慮附近的下一箱；太遠就先撤離。'],
        ['很少分心', '通常只會考慮離自己較近的下一箱。']),
      trait('riskTolerance',
        ['勇於冒險', '選路時比較能接受體力和膽量的消耗。'],
        ['適度冒險', '會在捷徑與消耗之間取捨，資源不足的路仍不會走。'],
        ['對風險謹慎', '選路時更重視節省體力與膽量，可能為此繞路。']),
      trait('stubbornness',
        ['堅持路線', '就算有可行的岔路，也比較少離開原定路線。'],
        ['偶爾改道', '有成本相近、走得起的岔路時，偶爾會換一條走。'],
        ['隨機應變', '有成本相近、走得起的岔路時，比較願意改道。'])
    ];
    const edit = node('input');
    edit.value = pet.name;
    edit.maxLength = 40;
    edit.setAttribute('aria-label', '新的寵物名稱');
    const saveName = button('儲存名字', () => app.commit('rename', { petId: pet.id, name: edit.value }), { disabled: app.busy });
    const remove = button('放生夥伴', () => {
      if (confirm(`要放生「${pet.name}」嗎？牠會離開家園，已完成的冒險紀錄會保留。`)) app.commit('deletePet', { petId: pet.id });
    }, { className: 'text-button danger', disabled: app.busy || data.pets.length <= 1 || pet.away });
    const target = node('a', 'button', '前往迷宮 ↗');
    target.href = Repository.isSheets ? '?page=adventure' : 'adventure.html';
    const training = node('a', '', '到背包培養');
    training.href = Repository.isSheets ? '?page=shop' : 'shop.html';
    details.replaceChildren(
      node('div', 'pet-profile', node('div', 'avatar pet-art ' + pet.species),
        node('div', 'profile-name', node('h3', '', pet.name),
          node('p', 'muted', type.name + ' · ', explain(personality.name, personalityTips[pet.personality], 'personality'),
            ` · Lv. ${pet.level}`)),
        node('span', 'pill', '出戰中')),
      node('p', 'personality-note', routeSummary(pet, personality)),
      node('p', 'fine-print', node('strong', '', '種族能力 · ' + type.ability.name), '　' + type.ability.text),
      node('div', 'traits', traits),
      node('div', 'stat-grid pet-current-stats', stats.map(values => meter(...values)),
        pet.level === Rules.maxLevel ? node('p', '', '已達最高等級') : null),
      individualStats(pet, training),
      node('div', 'actions', target),
      node('details', 'edit-pet', node('summary', '', '名稱與寵物管理'), node('div', 'inline', edit, saveName), remove,
        data.pets.length <= 1 ? node('p', 'fine-print muted', '家園至少要留一隻夥伴。') : null));
    for (const disclosure of details.querySelectorAll('details')) disclosure.open = previousOpen.has(disclosure.className);
  }

  const app = UI.client(render);
  setInterval(() => { if (!document.hidden && !app.busy) app.load(true).catch(() => {}); }, Repository.isSheets ? 30000 : 15000);
  app.load().catch(error => UI.message(error.message, true));
});
