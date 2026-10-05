import {
  STORAGE_KEY, SETTINGS_KEY, SNOOZED_ID, COLORS, load, update, loadSettings, updateSettings, withDefaults, addItem, addCategory,
  findCategory, findItem, allItems, snoozeTab, dueTime, isSavableUrl, faviconUrl,
} from './storage.js';
import {
  REPEATS, presetList, presetTime, nextOccurrence, formatWhen, formatDays, toInputValue, fromInputValue,
} from './reminders.js';
import { openCategoryAsGroup } from './tabs.js';
import {
  SLACK_ORIGIN, isWebhookUrl, postToSlack, buildDigest, buildCategoryMessage, collectOpenTabs,
} from './slack.js';
import {
  $, el, icon, iconButton, plural, linksLabel, toast, showMenu, openDialog, confirmDialog,
} from './ui.js';

const listEl = $('#list');
const searchEl = $('#search');

let data = await load();
let settings = await loadSettings();
let query = '';
let showAllReminders = false;
let dragging = null; // { type: 'item' | 'cat', id }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) settings = withDefaults(changes[SETTINGS_KEY].newValue);
  if (changes[STORAGE_KEY]) {
    data = changes[STORAGE_KEY].newValue ?? data;
    render();
  }
});

// Keep "прострочено" labels fresh.
setInterval(() => { if (!dragging && !document.querySelector('dialog[open]')) render(); }, 60 * 1000);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const isOverdue = (r, now) => r.fired || dueTime(r) <= now;
const isRepeating = (r) => Boolean(r.repeat) && r.repeat !== 'none';

// ---------- rendering ----------

function render() {
  const q = query.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  let shown = 0;

  if (!q) {
    const upcoming = renderReminders();
    if (upcoming) fragment.append(upcoming);
  }

  for (const cat of data.categories) {
    if (cat.id === SNOOZED_ID && !cat.items.length) continue; // reappears when a tab is snoozed
    const nameMatch = q && cat.name.toLowerCase().includes(q);
    const items = q && !nameMatch
      ? cat.items.filter((i) => `${i.title} ${i.url} ${i.note ?? ''}`.toLowerCase().includes(q))
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
  const reminders = allItems(data).filter(({ item }) => item.reminder && !item.done).length;
  $('#stats').textContent = [
    `${data.categories.length} ${plural(data.categories.length, 'категорія', 'категорії', 'категорій')}`,
    linksLabel(total),
    reminders ? `${reminders} ${plural(reminders, 'нагадування', 'нагадування', 'нагадувань')}` : null,
  ].filter(Boolean).join(' · ');
}

function renderReminders() {
  const now = Date.now();
  const rows = allItems(data)
    .filter(({ item }) => item.reminder && !item.done)
    .sort((a, b) => dueTime(a.item.reminder) - dueTime(b.item.reminder));
  if (!rows.length) return null;

  const overdue = rows.filter(({ item }) => isOverdue(item.reminder, now)).length;
  const limit = showAllReminders ? rows.length : 5;

  return el('section', { class: 'reminders' },
    el('div', { class: 'reminders-header' },
      icon('bell'),
      el('span', { class: 'cat-name' }, 'Нагадування'),
      overdue ? el('span', { class: 'count overdue' }, `${overdue} прострочено`) : null),
    el('ul', { class: 'items' }, rows.slice(0, limit).map(({ cat, item }) => {
      const r = item.reminder;
      const late = isOverdue(r, now);
      const when = r.reopen ? `відкриється ${formatWhen(dueTime(r), now)}` : formatWhen(dueTime(r), now);
      return el('li', { class: 'item', dataset: { id: item.id } },
        el('a', {
          class: 'item-link',
          href: item.url,
          title: `${item.title}\n${item.url}${item.note ? `\n\n${item.note}` : ''}`,
          onclick: (e) => { e.preventDefault(); openUrl(item.url, e); },
        },
        el('img', { class: 'favicon', src: faviconUrl(item.url), alt: '', loading: 'lazy' }),
        el('span', { class: 'item-title' }, item.title),
        el('span', { class: `chip${late ? ' overdue' : ''}`, title: `${cat.name}${isRepeating(r) ? ` · ${REPEATS[r.repeat]}` : ''}` },
          isRepeating(r) ? '↻ ' : '', when)),
        el('span', { class: 'item-actions' },
          r.reopen
            ? iconButton('open', 'Відкрити зараз', () => completeReminder(item.id))
            : iconButton('check', isRepeating(r) ? 'Готово (до наступного разу)' : 'Готово', () => completeReminder(item.id)),
          iconButton('snooze', 'Відкласти', (e) => reminderMenu(e.currentTarget, item.id), { 'aria-haspopup': 'menu' })));
    })),
    rows.length > 5
      ? el('button', {
        class: 'show-more', type: 'button',
        onclick: () => { showAllReminders = !showAllReminders; render(); },
      }, showAllReminders ? 'Згорнути' : `Показати всі (${rows.length})`)
      : null);
}

function renderCategory(cat, items, searching) {
  const collapsed = cat.collapsed && !searching;
  const color = COLORS[cat.color] ?? COLORS.grey;
  const schedule = cat.schedule?.enabled ? cat.schedule : null;

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
  schedule ? el('span', { class: 'sched', title: `Автовідкриття: ${formatDays(schedule.days)} о ${schedule.time}` }, icon('clock')) : null,
  el('span', { class: 'count' }, String(cat.items.length)),
  el('span', { class: 'cat-actions' },
    iconButton('plus', 'Зберегти поточну вкладку сюди', () => saveActiveTab(cat.id)),
    iconButton('open', 'Відкрити всі як групу вкладок', () => openCategory(cat.id)),
    iconButton('dots', 'Ще дії', (e) => categoryMenu(e.currentTarget, cat.id), { 'aria-haspopup': 'menu' }),
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
  const r = item.done ? null : item.reminder;
  const now = Date.now();

  const link = el('a', {
    class: 'item-link',
    href: item.url,
    title: `${item.title}\n${item.url}${item.note ? `\n\n${item.note}` : ''}`,
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
  item.note ? el('span', { class: 'note-mark', title: item.note }, '✎') : null,
  r ? el('span', { class: `chip${isOverdue(r, now) ? ' overdue' : ''}` }, icon('bell'), formatWhen(dueTime(r), now))
    : (host && host !== item.title ? el('span', { class: 'item-host' }, host) : null));

  const li = el('li', { class: `item${item.done ? ' done' : ''}`, dataset: { id: item.id } },
    link,
    el('span', { class: 'item-actions' },
      iconButton('bell', 'Нагадати', (e) => reminderMenu(e.currentTarget, item.id), { 'aria-haspopup': 'menu' }),
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
    const item = addItem(d, catId, { url, title: openTab?.title });
    const cat = findCategory(d, catId);
    if (item && beforeId) {
      cat.items.pop();
      cat.items.splice(Math.max(0, cat.items.findIndex((i) => i.id === beforeId)), 0, item);
    }
    return Boolean(item);
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

// ---------- links & categories ----------

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
    added: Boolean(addItem(d, catId, { url: tab.url, title: tab.title })),
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
  await openCategoryAsGroup(cat, (await chrome.windows.getCurrent()).id);
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
  if (res.action !== 'ok') return null;
  return update((d) => addCategory(d, { name: res.values.name, color: res.values.color }));
}

function categoryMenu(anchor, catId) {
  const cat = findCategory(data, catId);
  if (!cat) return;
  showMenu(anchor, [
    { label: 'Перейменувати, колір…', icon: 'edit', action: () => editCategory(catId) },
    { label: cat.schedule?.enabled ? 'Розклад автовідкриття (увімкнено)…' : 'Розклад автовідкриття…', icon: 'clock', action: () => editSchedule(catId) },
    { label: 'Надіслати список у Slack', icon: 'open', action: () => sendCategoryToSlack(catId) },
    '-',
    { label: 'Видалити категорію…', icon: 'close', danger: true, action: () => deleteCategory(catId) },
  ]);
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
    await deleteCategory(catId);
  }
}

async function deleteCategory(catId) {
  const cat = findCategory(data, catId);
  if (!cat) return;
  const ok = await confirmDialog(`Видалити «${cat.name}»?`,
    cat.items.length ? `Разом із категорією буде видалено ${linksLabel(cat.items.length)}.` : 'Категорія порожня.');
  if (!ok) return;
  await update((d) => { d.categories = d.categories.filter((c) => c.id !== catId); });
}

async function editSchedule(catId) {
  const cat = findCategory(data, catId);
  if (!cat) return;
  const s = cat.schedule ?? { enabled: false, time: '09:00', days: [1, 2, 3, 4, 5] };
  const res = await openDialog({
    title: `Автовідкриття «${cat.name}»`,
    fields: [
      { type: 'help', text: 'У вибраний час усі посилання категорії відкриються групою вкладок. Chrome має бути запущений.' },
      { name: 'enabled', type: 'checkbox', label: 'Відкривати автоматично', value: s.enabled },
      { name: 'time', type: 'time', label: 'Час', value: s.time },
      { name: 'days', type: 'days', label: 'Дні', value: s.days },
    ],
  });
  if (res.action !== 'ok') return;
  const { enabled, time, days } = res.values;
  if (enabled && (!time || !days.length)) return toast('Вкажіть час і хоча б один день');
  await update((d) => {
    const c = findCategory(d, catId);
    if (c) c.schedule = { enabled, time: time || s.time, days, lastRun: s.lastRun };
  });
  toast(enabled ? `Відкриватиметься ${formatDays(days)} о ${time}` : 'Автовідкриття вимкнено');
}

// ---------- items ----------

async function editItem(itemId) {
  const found = findItem(data, itemId);
  if (!found) return;
  const { item } = found;
  const res = await openDialog({
    title: 'Посилання',
    fields: [
      { name: 'title', label: 'Назва', type: 'text', value: item.title, required: true },
      { name: 'url', label: 'Адреса', type: 'url', value: item.url, required: true },
      {
        name: 'cat', label: 'Категорія', type: 'select', value: found.cat.id,
        options: data.categories.map((c) => ({ value: c.id, label: c.name })),
      },
      { name: 'note', label: 'Нотатка', type: 'textarea', value: item.note ?? '', placeholder: 'Що тут треба зробити?' },
      { name: 'remindAt', label: 'Нагадати', type: 'datetime-local', value: toInputValue(item.reminder && dueTime(item.reminder)) },
      {
        name: 'repeat', label: 'Повтор', type: 'select', value: item.reminder?.repeat ?? 'none',
        options: Object.entries(REPEATS).map(([value, label]) => ({ value, label })),
      },
      { name: 'done', label: 'Зроблено', type: 'checkbox', value: item.done },
    ],
    deleteLabel: 'Видалити',
  });
  if (res.action === 'delete') return removeItem(itemId);
  if (res.action !== 'ok') return;

  const v = res.values;
  const at = fromInputValue(v.remindAt);
  await update((d) => {
    const f = findItem(d, itemId);
    if (!f) return;
    const it = f.item;
    it.title = v.title.trim() || it.title;
    if (isSavableUrl(v.url.trim())) it.url = v.url.trim();
    if (v.note.trim()) it.note = v.note.trim();
    else delete it.note;

    const old = it.reminder;
    if (!at) delete it.reminder;
    else if (!old || at !== dueTime(old) || v.repeat !== old.repeat) it.reminder = { at, repeat: v.repeat, reopen: old?.reopen };

    if (v.done && !it.done) Object.assign(it, { done: true, doneAt: Date.now() });
    else if (!v.done) { delete it.done; delete it.doneAt; }

    if (v.cat !== f.cat.id) moveItem(d, itemId, v.cat, null);
  });
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
  toast('Посилання видалено', {
    actionLabel: 'Скасувати',
    action: () => update((d) => {
      const cat = findCategory(d, removed.catId);
      if (cat) cat.items.splice(removed.index, 0, removed.item);
    }),
  });
}

// ---------- reminders ----------

function reminderMenu(anchor, itemId) {
  const found = findItem(data, itemId);
  if (!found) return;
  const r = found.item.reminder;
  showMenu(anchor, [
    { heading: r ? `Зараз: ${formatWhen(dueTime(r))}` : 'Нагадати' },
    ...presetList().map((p) => ({ label: p.label, action: () => setReminder(itemId, presetTime(p.key)) })),
    { label: 'Обрати дату й повтор…', action: () => customReminder(itemId) },
    ...(r ? ['-', { label: 'Прибрати нагадування', danger: true, action: () => clearReminder(itemId) }] : []),
  ]);
}

async function setReminder(itemId, at, repeat) {
  await update((d) => {
    const it = findItem(d, itemId)?.item;
    if (!it) return;
    const old = it.reminder;
    // Snoozing a repeating reminder keeps its series; everything else sets a fresh reminder.
    if (old && !repeat && isRepeating(old)) {
      old.snoozeUntil = at;
      old.fired = false;
    } else {
      it.reminder = { at, repeat: repeat ?? 'none', reopen: old?.reopen };
    }
    delete it.done;
    delete it.doneAt;
  });
  toast(`Нагадаю ${formatWhen(at)}`);
}

async function customReminder(itemId) {
  const r = findItem(data, itemId)?.item.reminder;
  const res = await openDialog({
    title: 'Нагадування',
    fields: [
      { name: 'at', label: 'Коли', type: 'datetime-local', value: toInputValue(r ? dueTime(r) : presetTime('tomorrow')), required: true },
      {
        name: 'repeat', label: 'Повтор', type: 'select', value: r?.repeat ?? 'none',
        options: Object.entries(REPEATS).map(([value, label]) => ({ value, label })),
      },
    ],
    okLabel: 'Нагадати',
  });
  if (res.action !== 'ok') return;
  const at = fromInputValue(res.values.at);
  if (at) await setReminder(itemId, at, res.values.repeat);
}

async function clearReminder(itemId) {
  await update((d) => {
    const f = findItem(d, itemId);
    if (!f) return;
    // A snoozed tab without its reminder has no reason to stay in "Відкладені".
    if (f.item.reminder?.reopen) f.cat.items.splice(f.index, 1);
    else delete f.item.reminder;
  });
}

async function completeReminder(itemId) {
  const found = findItem(data, itemId);
  const r = found?.item.reminder;
  if (!r) return;
  if (r.reopen) {
    await chrome.tabs.create({ url: found.item.url });
    return clearReminder(itemId);
  }
  await update((d) => {
    const it = findItem(d, itemId)?.item;
    const rem = it?.reminder;
    if (!rem) return;
    if (isRepeating(rem)) {
      // A snoozed occurrence is finished by clearing the snooze; otherwise skip to the next one.
      if (rem.snoozeUntil) delete rem.snoozeUntil;
      else rem.at = nextOccurrence(rem.at, rem.repeat);
      rem.fired = false;
    } else {
      delete it.reminder;
      Object.assign(it, { done: true, doneAt: Date.now() });
    }
  });
}

function snoozeTabMenu(anchor) {
  showMenu(anchor, [
    { heading: 'Закрити вкладку й повернути її…' },
    ...presetList().map((p) => ({ label: p.label, action: () => snoozeActiveTab(presetTime(p.key)) })),
    { label: 'Обрати час…', action: snoozeActiveTabCustom },
  ]);
}

async function snoozeActiveTab(at) {
  const tab = await activeTab();
  if (!tab || !isSavableUrl(tab.url)) return toast('Цю вкладку не можна відкласти');
  const item = await update((d) => snoozeTab(d, tab, at));
  if (!item) return;
  await chrome.tabs.remove(tab.id);
  toast(`Вкладка повернеться ${formatWhen(at)}`);
}

async function snoozeActiveTabCustom() {
  const res = await openDialog({
    title: 'Відкласти вкладку',
    fields: [{ name: 'at', label: 'Повернути', type: 'datetime-local', value: toInputValue(presetTime('tomorrow')), required: true }],
    okLabel: 'Відкласти',
  });
  const at = res.action === 'ok' && fromInputValue(res.values.at);
  if (at) await snoozeActiveTab(at);
}

// ---------- Slack ----------

async function slackSettings() {
  const s = settings.slack;
  const res = await openDialog({
    title: 'Інтеграція зі Slack',
    fields: [
      {
        type: 'help',
        text: '1. Відкрийте api.slack.com/apps → Create New App → From scratch.\n'
          + '2. Incoming Webhooks → увімкніть → Add New Webhook → виберіть канал (можна особистий).\n'
          + '3. Скопіюйте адресу https://hooks.slack.com/… і вставте нижче.\n\n'
          + 'У Slack потраплять назви й адреси ваших посилань. Відкриті вкладки — лише якщо ввімкнете пункт нижче.',
      },
      { name: 'webhookUrl', label: 'Адреса вебхука', type: 'url', value: s.webhookUrl, placeholder: 'https://hooks.slack.com/services/…' },
      { name: 'sendReminders', type: 'checkbox', label: 'Дублювати нагадування в Slack (прийдуть і на телефон)', value: s.sendReminders },
      { name: 'digestEnabled', type: 'checkbox', label: 'Надсилати підсумок роботи за розкладом', value: s.digestEnabled },
      { name: 'digestTime', type: 'time', label: 'Час підсумку', value: s.digestTime },
      { name: 'digestDays', type: 'days', label: 'Дні', value: s.digestDays },
      { name: 'includeOpenTabs', type: 'checkbox', label: 'Додавати до підсумку відкриті вкладки', value: s.includeOpenTabs },
    ],
  });
  if (res.action !== 'ok') return;

  const v = res.values;
  const url = v.webhookUrl.trim();
  if (url && !isWebhookUrl(url)) return toast('Адреса має починатися з https://hooks.slack.com/');
  // Requested right after the click on "Зберегти", while the user gesture is still active.
  if (url && !(await chrome.permissions.request({ origins: [SLACK_ORIGIN] }))) {
    return toast('Без дозволу на hooks.slack.com надсилання не працюватиме');
  }
  settings = await updateSettings((st) => {
    Object.assign(st.slack, {
      webhookUrl: url,
      sendReminders: v.sendReminders,
      digestEnabled: v.digestEnabled,
      digestTime: v.digestTime || st.slack.digestTime,
      digestDays: v.digestDays,
      includeOpenTabs: v.includeOpenTabs,
    });
  });
  if (url) toast('Slack підключено', { actionLabel: 'Надіслати тест', action: sendDigestNow });
  else toast('Slack вимкнено');
}

async function withSlack(send) {
  if (!settings.slack.webhookUrl) {
    toast('Спершу підключіть Slack', { actionLabel: 'Налаштувати', action: slackSettings });
    return;
  }
  try {
    await send(settings.slack.webhookUrl);
    toast('Надіслано в Slack');
  } catch (e) {
    toast(e.message, { duration: 5000 });
  }
}

const sendDigestNow = () => withSlack(async (url) => {
  const openTabs = settings.slack.includeOpenTabs ? await collectOpenTabs() : null;
  await postToSlack(url, buildDigest(data, { openTabs }));
});

const sendCategoryToSlack = (catId) => withSlack(async (url) => {
  const cat = findCategory(data, catId);
  if (cat) await postToSlack(url, buildCategoryMessage(cat));
});

// ---------- import / export ----------

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
        const item = addItem(d, cat.id, { url: i?.url, title: i?.title });
        if (!item) continue;
        if (typeof i.note === 'string') item.note = i.note;
        if (Number.isFinite(i.reminder?.at)) item.reminder = { at: i.reminder.at, repeat: REPEATS[i.reminder.repeat] ? i.reminder.repeat : 'none' };
        added++;
      }
    }
    return added;
  });
  toast(`Імпортовано ${linksLabel(count)}`);
}

// ---------- wiring ----------

$('#moreBtn').append(icon('more'));

$('#moreBtn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  { label: 'Зберегти всі вкладки вікна', action: saveWindowTabs },
  { label: 'Імпорт з панелі закладок Chrome', action: importBookmarksBar },
  '-',
  { label: 'Надіслати підсумок у Slack зараз', action: sendDigestNow },
  { label: 'Налаштування Slack…', action: slackSettings },
  '-',
  { label: 'Згорнути всі категорії', action: () => update((d) => d.categories.forEach((c) => { c.collapsed = true; })) },
  { label: 'Розгорнути всі категорії', action: () => update((d) => d.categories.forEach((c) => { c.collapsed = false; })) },
  {
    label: 'Відкривати в новій вкладці',
    checked: Boolean(settings.openInNewTab),
    action: async () => {
      settings = await updateSettings((s) => { s.openInNewTab = !s.openInNewTab; });
      toast(settings.openInNewTab ? 'Посилання відкриватимуться в новій вкладці' : 'Посилання відкриватимуться в поточній вкладці');
    },
  },
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
      const created = await createCategory();
      if (created) await saveActiveTab(created.id);
    },
  },
]));

$('#snoozeBtn').addEventListener('click', (e) => snoozeTabMenu(e.currentTarget));
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
  const first = listEl.querySelector('.category .item-link');
  if (first) openUrl(first.getAttribute('href'), e);
});

render();
