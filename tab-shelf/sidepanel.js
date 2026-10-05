import {
  STORAGE_KEY, COLORS, load, update, addItem, addCategory, findCategory, findItem, isSavableUrl, faviconUrl,
} from './storage.js';

const SETTINGS_KEY = 'settings';
const $ = (sel) => document.querySelector(sel);

const listEl = $('#list');
const searchEl = $('#search');
const menuEl = $('#menu');

let data = await load();
let settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? { openInNewTab: false };
let query = '';
let dragging = null; // { type: 'item' | 'cat', id }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY]) {
    data = changes[STORAGE_KEY].newValue ?? data;
    render();
  }
  if (changes[SETTINGS_KEY]) settings = changes[SETTINGS_KEY].newValue ?? settings;
});

// ---------- helpers ----------

const ICONS = {
  plus: '<path d="M11.25 4.5h1.5v6.75h6.75v1.5h-6.75v6.75h-1.5v-6.75H4.5v-1.5h6.75z"/>',
  open: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7v1.5h-7a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7H20v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM15 3.5h5.5V9H19V6.06l-6.47 6.47-1.06-1.06L17.94 5H15z"/>',
  edit: '<path d="M15.6 3.9a2 2 0 0 1 2.83 0l1.67 1.67a2 2 0 0 1 0 2.83L8.6 19.9 3.5 20.5l.6-5.1zm1.77 1.06a.5.5 0 0 0-.7 0l-1.32 1.32 2.37 2.37 1.32-1.32a.5.5 0 0 0 0-.7zM16.66 9.71l-2.37-2.37-8.77 8.77-.3 2.67 2.67-.3z"/>',
  close: '<path d="m6.53 5.47 5.47 5.47 5.47-5.47 1.06 1.06L13.06 12l5.47 5.47-1.06 1.06L12 13.06l-5.47 5.47-1.06-1.06L10.94 12 5.47 6.53z"/>',
  more: '<path d="M12 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>',
  chevron: '<path d="m9.53 5.47 6 6a.75.75 0 0 1 0 1.06l-6 6-1.06-1.06L13.94 12 8.47 6.53z"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function iconButton(name, title, onclick) {
  return el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick }, icon(name));
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const linksLabel = (n) => `${n} ${plural(n, 'посилання', 'посилання', 'посилань')}`;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------- rendering ----------

function render() {
  const q = query.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  let shown = 0;

  for (const cat of data.categories) {
    const nameMatch = q && cat.name.toLowerCase().includes(q);
    const items = q && !nameMatch
      ? cat.items.filter((i) => `${i.title} ${i.url}`.toLowerCase().includes(q))
      : cat.items;
    if (q && !items.length && !nameMatch) continue;
    fragment.append(renderCategory(cat, items, Boolean(q)));
    shown++;
  }

  if (!shown) {
    fragment.append(el('div', { class: 'empty' },
      q ? 'Нічого не знайдено.' : 'Тут поки порожньо. Збережіть вкладку або створіть категорію.'));
  }

  listEl.replaceChildren(fragment);

  const total = data.categories.reduce((sum, c) => sum + c.items.length, 0);
  $('#stats').textContent = `${data.categories.length} ${plural(data.categories.length, 'категорія', 'категорії', 'категорій')} · ${linksLabel(total)}`;
}

function renderCategory(cat, items, searching) {
  const collapsed = cat.collapsed && !searching;
  const color = COLORS[cat.color] ?? COLORS.grey;

  const header = el('div', {
    class: 'cat-header',
    draggable: 'true',
    title: 'Клік — згорнути/розгорнути, перетягніть для зміни порядку',
    onclick: (e) => { if (!e.target.closest('button')) toggleCategory(cat.id); },
    ondblclick: (e) => { if (!e.target.closest('button')) editCategory(cat.id); },
    ondragstart: (e) => {
      dragging = { type: 'cat', id: cat.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cat.name);
      section.classList.add('dragging');
    },
    ondragend: endDrag,
  },
  el('span', { class: 'caret' }, icon('chevron')),
  el('span', { class: 'dot', style: `background:${color}` }),
  el('span', { class: 'cat-name' }, cat.name),
  el('span', { class: 'count' }, String(cat.items.length)),
  el('span', { class: 'cat-actions' },
    iconButton('plus', 'Зберегти поточну вкладку сюди', () => saveActiveTab(cat.id)),
    iconButton('open', 'Відкрити всі як групу вкладок', () => openCategory(cat.id)),
    iconButton('edit', 'Перейменувати / змінити колір', () => editCategory(cat.id)),
  ));

  const list = el('ul', { class: 'items' }, items.map((item) => renderItem(item)));
  if (!items.length) list.append(el('li', { class: 'items-empty' }, 'Перетягніть сюди посилання або натисніть +'));

  const section = el('section', {
    class: `category${collapsed ? ' collapsed' : ''}`,
    style: `--cat-color:${color}`,
    dataset: { id: cat.id },
    ondragover: (e) => onDragOver(e, cat.id, section),
    ondragleave: (e) => { if (!section.contains(e.relatedTarget)) clearDropMarks(); },
    ondrop: (e) => onDrop(e, cat.id, section),
  }, header, list);

  return section;
}

function renderItem(item) {
  let host = '';
  try { host = new URL(item.url).hostname; } catch { /* keep empty */ }

  const link = el('a', {
    class: 'item-link',
    href: item.url,
    title: `${item.title}\n${item.url}`,
    draggable: 'true',
    onclick: (e) => { e.preventDefault(); openUrl(item.url, e); },
    onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); openUrl(item.url, { ctrlKey: true }); } },
    ondragstart: (e) => {
      dragging = { type: 'item', id: item.id };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/uri-list', item.url);
      e.dataTransfer.setData('text/plain', item.url);
      li.classList.add('dragging');
    },
    ondragend: endDrag,
  },
  el('img', { class: 'favicon', src: faviconUrl(item.url), alt: '', loading: 'lazy' }),
  el('span', { class: 'item-title' }, item.title),
  host && host !== item.title ? el('span', { class: 'item-host' }, host) : null);

  const li = el('li', { class: 'item', dataset: { id: item.id } },
    link,
    el('span', { class: 'item-actions' },
      iconButton('edit', 'Редагувати', () => editItem(item.id)),
      iconButton('close', 'Видалити', () => removeItem(item.id)),
    ));
  return li;
}

// ---------- drag & drop ----------

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function endDrag() {
  dragging = null;
  clearDropMarks();
  document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
}

const isExternalLink = (e) => !dragging && e.dataTransfer.types.includes('text/uri-list');

// Where a drop at the pointer position should land.
function dropTarget(e, section) {
  if (dragging?.type === 'cat') {
    const r = section.getBoundingClientRect();
    return { node: section, place: e.clientY < r.top + r.height / 2 ? 'before' : 'after' };
  }
  const row = e.target.closest('.item');
  if (row && section.contains(row)) {
    const r = row.getBoundingClientRect();
    return { node: row, place: e.clientY < r.top + r.height / 2 ? 'before' : 'after' };
  }
  return { node: section, place: 'into' };
}

function onDragOver(e, catId, section) {
  if (!dragging && !isExternalLink(e)) return;
  if (dragging?.type === 'cat' && dragging.id === catId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
  clearDropMarks();
  const { node, place } = dropTarget(e, section);
  node.classList.add(`drop-${place}`);
}

async function onDrop(e, catId, section) {
  if (!dragging && !isExternalLink(e)) return;
  e.preventDefault();
  const { node, place } = dropTarget(e, section);
  const drag = dragging;
  endDrag();

  if (drag?.type === 'cat') {
    if (drag.id === catId) return;
    await update((d) => {
      const from = d.categories.findIndex((c) => c.id === drag.id);
      const [moved] = d.categories.splice(from, 1);
      let to = d.categories.findIndex((c) => c.id === catId);
      if (place === 'after') to++;
      d.categories.splice(to, 0, moved);
    });
    return;
  }

  // Item id that the dropped link should be inserted before (null = append).
  let beforeId = null;
  if (place === 'before') beforeId = node.dataset.id;
  else if (place === 'after') beforeId = node.nextElementSibling?.dataset.id ?? null;

  if (drag?.type === 'item') {
    if (drag.id === beforeId) return;
    await update((d) => moveItem(d, drag.id, catId, beforeId));
    return;
  }

  // A link or tab dragged in from a web page / the tab strip.
  const url = e.dataTransfer.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!isSavableUrl(url)) return;
  const openTab = (await chrome.tabs.query({})).find((t) => t.url === url);
  const added = await update((d) => {
    const ok = addItem(d, catId, { url, title: openTab?.title });
    const cat = findCategory(d, catId);
    if (ok && beforeId) {
      const item = cat.items.pop();
      cat.items.splice(Math.max(0, cat.items.findIndex((i) => i.id === beforeId)), 0, item);
    }
    return ok;
  });
  toast(added ? 'Посилання збережено' : 'Це посилання вже є в категорії');
}

function moveItem(d, itemId, toCatId, beforeId) {
  const found = findItem(d, itemId);
  const to = findCategory(d, toCatId);
  if (!found || !to) return;
  found.cat.items.splice(found.index, 1);
  // Moving into a category that already has this URL merges the duplicate away.
  if (to !== found.cat && to.items.some((i) => i.url === found.item.url)) return;
  let index = beforeId ? to.items.findIndex((i) => i.id === beforeId) : -1;
  if (index === -1) index = to.items.length;
  to.items.splice(index, 0, found.item);
}

// ---------- actions ----------

async function openUrl(url, e = {}) {
  if (e.shiftKey) return chrome.windows.create({ url });
  const background = e.ctrlKey || e.metaKey;
  if (background || settings.openInNewTab) return chrome.tabs.create({ url, active: !background });
  return chrome.tabs.update({ url });
}

async function toggleCategory(catId) {
  await update((d) => {
    const cat = findCategory(d, catId);
    if (cat) cat.collapsed = !cat.collapsed;
  });
}

async function saveActiveTab(catId) {
  const tab = await activeTab();
  if (!tab || !isSavableUrl(tab.url)) return toast('Цю сторінку не можна зберегти');
  const { added, name } = await update((d) => ({
    added: addItem(d, catId, { url: tab.url, title: tab.title }),
    name: findCategory(d, catId)?.name ?? 'Вхідні',
  }));
  toast(added ? `Збережено в «${name}»` : `Вже є в «${name}»`);
}

async function saveWindowTabs() {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => isSavableUrl(t.url));
  if (!tabs.length) return toast('Немає вкладок для збереження');

  const byGroup = new Map();
  for (const t of tabs) {
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  }
  const groupInfo = new Map();
  for (const id of byGroup.keys()) {
    if (id !== chrome.tabGroups.TAB_GROUP_ID_NONE) groupInfo.set(id, await chrome.tabGroups.get(id));
  }

  const stamp = new Date().toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const created = await update((d) => {
    let count = 0;
    for (const [groupId, groupTabs] of byGroup) {
      const info = groupInfo.get(groupId);
      const cat = addCategory(d, {
        name: info ? (info.title || `Група ${stamp}`) : `Вкладки ${stamp}`,
        color: info?.color ?? 'blue',
      });
      for (const t of groupTabs) addItem(d, cat.id, { url: t.url, title: t.title });
      count++;
    }
    return count;
  });
  toast(`Збережено ${linksLabel(tabs.length)} у ${created} ${plural(created, 'категорію', 'категорії', 'категорій')}`);
}

async function openCategory(catId) {
  const cat = findCategory(data, catId);
  if (!cat?.items.length) return toast('Категорія порожня');
  if (cat.items.length > 15) {
    const res = await openDialog({
      title: 'Відкрити всі посилання?',
      message: `Буде відкрито ${cat.items.length} вкладок.`,
      okLabel: 'Відкрити',
    });
    if (res.action !== 'ok') return;
  }
  const win = await chrome.windows.getCurrent();
  const tabIds = [];
  for (const [n, item] of cat.items.entries()) {
    const tab = await chrome.tabs.create({ url: item.url, active: n === 0, windowId: win.id });
    tabIds.push(tab.id);
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
  await chrome.tabGroups.update(groupId, { title: cat.name, color: cat.color in COLORS ? cat.color : 'grey' });
}

async function createCategory() {
  const used = new Set(data.categories.map((c) => c.color));
  const color = Object.keys(COLORS).find((c) => c !== 'grey' && !used.has(c)) ?? 'blue';
  const res = await openDialog({
    title: 'Нова категорія',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', value: '', required: true },
      { name: 'color', label: 'Колір', type: 'color', value: color },
    ],
    okLabel: 'Створити',
  });
  if (res.action !== 'ok') return;
  await update((d) => addCategory(d, { name: res.values.name, color: res.values.color }));
}

async function editCategory(catId) {
  const cat = findCategory(data, catId);
  if (!cat) return;
  const res = await openDialog({
    title: 'Категорія',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', value: cat.name, required: true },
      { name: 'color', label: 'Колір', type: 'color', value: cat.color },
    ],
    deleteLabel: 'Видалити',
  });
  if (res.action === 'ok') {
    await update((d) => {
      const c = findCategory(d, catId);
      if (!c) return;
      c.name = res.values.name.trim() || c.name;
      c.color = res.values.color;
    });
  } else if (res.action === 'delete') {
    const confirm = await openDialog({
      title: `Видалити «${cat.name}»?`,
      message: cat.items.length ? `Разом із категорією буде видалено ${linksLabel(cat.items.length)}.` : 'Категорія порожня.',
      okLabel: 'Видалити',
      danger: true,
    });
    if (confirm.action !== 'ok') return;
    await update((d) => { d.categories = d.categories.filter((c) => c.id !== catId); });
  }
}

async function editItem(itemId) {
  const found = findItem(data, itemId);
  if (!found) return;
  const res = await openDialog({
    title: 'Посилання',
    fields: [
      { name: 'title', label: 'Назва', type: 'text', value: found.item.title, required: true },
      { name: 'url', label: 'Адреса', type: 'url', value: found.item.url, required: true },
      {
        name: 'cat', label: 'Категорія', type: 'select', value: found.cat.id,
        options: data.categories.map((c) => ({ value: c.id, label: c.name })),
      },
    ],
    deleteLabel: 'Видалити',
  });
  if (res.action === 'ok') {
    await update((d) => {
      const f = findItem(d, itemId);
      if (!f) return;
      f.item.title = res.values.title.trim() || f.item.title;
      if (isSavableUrl(res.values.url)) f.item.url = res.values.url.trim();
      if (res.values.cat !== f.cat.id) moveItem(d, itemId, res.values.cat, null);
    });
  } else if (res.action === 'delete') {
    await removeItem(itemId);
  }
}

async function removeItem(itemId) {
  let removed;
  await update((d) => {
    const f = findItem(d, itemId);
    if (!f) return;
    removed = { catId: f.cat.id, index: f.index, item: f.item };
    f.cat.items.splice(f.index, 1);
  });
  if (!removed) return;
  showUndo('Посилання видалено', () => update((d) => {
    const cat = findCategory(d, removed.catId);
    if (cat) cat.items.splice(removed.index, 0, removed.item);
  }));
}

function showUndo(text, undo) {
  const t = $('#toast');
  t.replaceChildren(text, el('button', {
    class: 'link-btn',
    type: 'button',
    onclick: () => { t.hidden = true; undo(); },
  }, 'Скасувати'));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function importBookmarksBar() {
  // Must be the first await: permission requests need the user gesture.
  const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
  if (!granted) return toast('Немає доступу до закладок');

  const [root] = await chrome.bookmarks.getTree();
  const bar = root.children.find((n) => n.folderType === 'bookmarks-bar') ?? root.children[0];
  const flatten = (node) => (node.children ?? []).flatMap((c) => (c.url ? [c] : flatten(c)));

  const loose = (bar.children ?? []).filter((n) => n.url);
  const folders = (bar.children ?? []).filter((n) => !n.url);
  const palette = Object.keys(COLORS).filter((c) => c !== 'grey');

  const count = await update((d) => {
    let added = 0;
    const fill = (name, color, links) => {
      const cat = d.categories.find((c) => c.name === name) ?? addCategory(d, { name, color });
      for (const b of links) if (addItem(d, cat.id, { url: b.url, title: b.title })) added++;
    };
    if (loose.length) fill('Панель закладок', 'grey', loose);
    folders.forEach((f, i) => fill(f.title || 'Папка', palette[i % palette.length], flatten(f)));
    return added;
  });
  toast(count ? `Імпортовано ${linksLabel(count)}` : 'Нових закладок не знайдено');
}

function exportJson() {
  const payload = { app: 'tab-shelf', version: 1, exportedAt: new Date().toISOString(), categories: data.categories };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `tab-shelf-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast('Файл пошкоджений або не є JSON');
  }
  const categories = Array.isArray(parsed?.categories) ? parsed.categories : null;
  if (!categories) return toast('У файлі немає категорій Tab Shelf');

  const count = await update((d) => {
    let added = 0;
    for (const src of categories) {
      if (typeof src?.name !== 'string') continue;
      const cat = d.categories.find((c) => c.name === src.name)
        ?? addCategory(d, { name: src.name, color: src.color in COLORS ? src.color : 'blue' });
      for (const i of Array.isArray(src.items) ? src.items : []) {
        if (addItem(d, cat.id, { url: i?.url, title: i?.title })) added++;
      }
    }
    return added;
  });
  toast(`Імпортовано ${linksLabel(count)}`);
}

async function setCollapsedAll(collapsed) {
  await update((d) => d.categories.forEach((c) => { c.collapsed = collapsed; }));
}

async function toggleOpenInNewTab() {
  settings = { ...settings, openInNewTab: !settings.openInNewTab };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  toast(settings.openInNewTab ? 'Посилання відкриватимуться в новій вкладці' : 'Посилання відкриватимуться в поточній вкладці');
}

// ---------- popover menu ----------

function showMenu(anchor, entries) {
  menuEl.replaceChildren(...entries.map((entry) => {
    if (entry === '-') return el('hr');
    return el('button', {
      type: 'button',
      role: 'menuitem',
      class: 'menu-item',
      onclick: () => { hideMenu(); entry.action(); },
    },
    entry.color ? el('span', { class: 'dot', style: `background:${COLORS[entry.color] ?? COLORS.grey}` }) : null,
    el('span', {}, entry.label),
    entry.checked !== undefined ? el('span', { class: 'check' }, entry.checked ? '✓' : '') : null);
  }));
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const width = menuEl.offsetWidth;
  menuEl.style.top = `${r.bottom + 4}px`;
  menuEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  menuEl.querySelector('button')?.focus();
}

function hideMenu() {
  menuEl.hidden = true;
}

document.addEventListener('click', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('[aria-haspopup="menu"]')) hideMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

// ---------- dialog ----------

function openDialog({ title, message = '', fields = [], okLabel = 'Зберегти', deleteLabel, danger = false }) {
  const dialog = $('#dialog');
  $('#dialogTitle').textContent = title;
  $('#dialogMessage').textContent = message;
  $('#dialogMessage').hidden = !message;
  $('#dialogOk').textContent = okLabel;
  $('#dialogOk').classList.toggle('danger', danger);
  $('#dialogOk').classList.toggle('primary', !danger);
  $('#dialogDelete').hidden = !deleteLabel;
  if (deleteLabel) $('#dialogDelete').textContent = deleteLabel;

  $('#dialogFields').replaceChildren(...fields.map((f) => {
    let control;
    if (f.type === 'color') {
      control = el('div', { class: 'swatches', role: 'radiogroup' }, Object.entries(COLORS).map(([name, hex]) =>
        el('label', { class: 'swatch', title: name },
          el('input', { type: 'radio', name: f.name, value: name, checked: name === f.value }),
          el('span', { style: `background:${hex}` }))));
      return el('div', { class: 'field' }, el('span', { class: 'label' }, f.label), control);
    }
    if (f.type === 'select') {
      control = el('select', { name: f.name },
        f.options.map((o) => el('option', { value: o.value, selected: o.value === f.value }, o.label)));
    } else {
      control = el('input', { type: f.type, name: f.name, value: f.value, required: f.required, spellcheck: 'false' });
    }
    return el('label', { class: 'field' }, el('span', { class: 'label' }, f.label), control);
  }));

  dialog.returnValue = '';
  dialog.showModal();
  dialog.querySelector('input[type=text], input[type=url]')?.select();

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const values = Object.fromEntries(new FormData($('#dialogForm')));
      resolve({ action: dialog.returnValue || 'cancel', values });
    }, { once: true });
  });
}

// ---------- wiring ----------

$('#moreBtn').append(icon('more'));

$('#moreBtn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  { label: 'Зберегти всі вкладки вікна', action: saveWindowTabs },
  { label: 'Імпорт з панелі закладок Chrome', action: importBookmarksBar },
  '-',
  { label: 'Згорнути всі категорії', action: () => setCollapsedAll(true) },
  { label: 'Розгорнути всі категорії', action: () => setCollapsedAll(false) },
  { label: 'Відкривати в новій вкладці', checked: Boolean(settings.openInNewTab), action: toggleOpenInNewTab },
  '-',
  { label: 'Експорт у файл (JSON)', action: exportJson },
  { label: 'Імпорт з файлу (JSON)', action: () => $('#importFile').click() },
]));

$('#saveTabBtn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  ...data.categories.map((c) => ({ label: c.name, color: c.color, action: () => saveActiveTab(c.id) })),
  '-',
  {
    label: '+ У нову категорію…',
    action: async () => {
      const before = new Set(data.categories.map((c) => c.id));
      await createCategory();
      const created = (await load()).categories.find((c) => !before.has(c.id));
      if (created) await saveActiveTab(created.id);
    },
  },
]));

$('#addCatBtn').addEventListener('click', createCategory);

$('#importFile').addEventListener('change', async (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (file) await importJson(file);
});

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  render();
});

searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = listEl.querySelector('.item-link');
  if (first) openUrl(first.getAttribute('href'), e);
});

render();
