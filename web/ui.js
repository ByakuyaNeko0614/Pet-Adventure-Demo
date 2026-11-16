'use strict';

var UI = (() => {
  const byId = id => document.getElementById(id);

  function node(tag, className = '', ...children) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.append(...children.flat().filter(child => child !== null && child !== undefined));
    return element;
  }

  function button(label, handler, options = {}) {
    const element = node('button', options.className || '', label);
    element.type = 'button';
    element.disabled = Boolean(options.disabled);
    element.addEventListener('click', handler);
    return element;
  }

  function message(text, error = false) {
    const element = byId('notice');
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('error', error);
  }

  function header(data) {
    const brand = node('a', 'brand', node('span', 'brand-icon', '✦'), node('span', '', '寵物尋寶', node('small', '', 'PET TREASURE ADVENTURE')));
    const route = name => Repository.isSheets ? '?page=' + name : name + '.html';
    brand.href = route('hatch');
    const links = Object.entries({ hatch: '寵物窩', nursery: '孵化室', adventure: '迷宮探索', shop: '商店與背包' });
    const nav = node('nav', 'nav', links.map(([key, label]) => {
      const anchor = node('a', '', label);
      anchor.href = route(key);
      if (document.body.dataset.page === key) anchor.setAttribute('aria-current', 'page');
      return anchor;
    }));
    nav.setAttribute('aria-label', '主導覽');
    const status = node('div', 'header-status', node('span', 'mode', Repository.isSheets ? 'SHEETS MODE' : 'DEMO MODE'),
      node('span', 'pill wallet', '◉ ' + (data?.coins ?? '—')));
    if (Repository.isSheets && Account.player) {
      const signOut = button('登出', async () => {
        signOut.disabled = true;
        try { await Account.logout(); } catch (error) { message(error.message, true); }
        finally { signOut.disabled = false; }
      });
      status.append(node('span', 'account-name', Account.player.username), signOut);
    }
    byId('site-header').replaceChildren(node('div', 'shell topbar', brand, nav, status));
  }

  function meter(label, value, max, className) {
    const progress = node('progress', className);
    progress.max = max;
    progress.value = value;
    progress.setAttribute('aria-label', label);
    return node('div', 'meter', node('div', 'meter-label', node('span', '', label),
      node('span', '', `${value} / ${max}`)), progress);
  }

  function options(select, entries, value, fallback) {
    select.replaceChildren(...(entries.length ? entries : [['', fallback]])
      .map(([id, label]) => new Option(label, id)));
    if (entries.some(([id]) => id === value)) select.value = value;
  }

  function client(render) {
    let data = null;
    let busy = false;
    async function load() {
      const result = await Repository.read();
      data = result.data;
      header(data);
      render(data);
      return result;
    }
    async function commit(op, input, requestId) {
      if (!data || busy) return { ok: false };
      busy = true;
      message('');
      render(data);
      try {
        const result = await Repository.command(op, input, data.revision, requestId);
        data = result.data;
        header(data);
        return { ok: true, value: result.value };
      } catch (error) {
        try {
          await load();
        } catch {
          // The original operation error remains visible if reloading also fails.
        }
        message(error.message, true);
        return { ok: false };
      } finally {
        busy = false;
        render(data);
      }
    }
    header(null);
    return { load, commit, get data() { return data; }, get busy() { return busy; } };
  }

  const accuracy = (correct, attempts) => attempts ? Math.round(correct / attempts * 100) + '%' : '—';
  function trainingNote(odds) {
    if (odds.blocked === 'max') return '已達上限';
    if (odds.blocked === 'level') return `下一點需 Lv. ${odds.required}`;
    if (odds.chance === 100) return '保底：本次一定成功';
    return `成功率 ${odds.chance}% · 建議 Lv. ${odds.level}` + (odds.misses ? ` · 保底進度 ${odds.misses}/3` : '');
  }
  return { byId, node, button, message, meter, options, client, accuracy, trainingNote };
})();
