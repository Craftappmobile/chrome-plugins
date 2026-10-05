// Small DOM toolkit for the side panel: element builder, icons, toast, popover menu, dialog.
import { COLORS } from './storage.js';
import { DAY_LABELS, WEEK_ORDER } from './reminders.js';

export const $ = (sel) => document.querySelector(sel);

const ICONS = {
  plus: '<path d="M11.25 4.5h1.5v6.75h6.75v1.5h-6.75v6.75h-1.5v-6.75H4.5v-1.5h6.75z"/>',
  open: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7v1.5h-7a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7H20v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM15 3.5h5.5V9H19V6.06l-6.47 6.47-1.06-1.06L17.94 5H15z"/>',
  edit: '<path d="M15.6 3.9a2 2 0 0 1 2.83 0l1.67 1.67a2 2 0 0 1 0 2.83L8.6 19.9 3.5 20.5l.6-5.1zm1.77 1.06a.5.5 0 0 0-.7 0l-1.32 1.32 2.37 2.37 1.32-1.32a.5.5 0 0 0 0-.7zM16.66 9.71l-2.37-2.37-8.77 8.77-.3 2.67 2.67-.3z"/>',
  close: '<path d="m6.53 5.47 5.47 5.47 5.47-5.47 1.06 1.06L13.06 12l5.47 5.47-1.06 1.06L12 13.06l-5.47 5.47-1.06-1.06L10.94 12 5.47 6.53z"/>',
  more: '<path d="M12 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>',
  dots: '<path d="M5.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/>',
  chevron: '<path d="m9.53 5.47 6 6a.75.75 0 0 1 0 1.06l-6 6-1.06-1.06L13.94 12 8.47 6.53z"/>',
  bell: '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5z"/>',
  clock: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 1.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5ZM12.75 7v4.69l3.53 2.04-.75 1.3-4.28-2.47V7z"/>',
  check: '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
  snooze: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 1.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5ZM9 8h6v1.4l-3.9 4.85H15V16H9v-1.4l3.9-4.85H9z"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

export function el(tag, props = {}, ...children) {
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

export function iconButton(name, title, onclick, extra = {}) {
  return el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick, ...extra }, icon(name));
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const linksLabel = (n) => `${n} ${plural(n, 'посилання', 'посилання', 'посилань')}`;

// ---------- toast ----------

let toastTimer;
export function toast(text, { action, actionLabel, duration = 2400 } = {}) {
  const t = $('#toast');
  t.replaceChildren(el('span', {}, text));
  if (action) {
    t.append(el('button', { class: 'link-btn', type: 'button', onclick: () => { t.hidden = true; action(); } }, actionLabel));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? Math.max(duration, 5000) : duration);
}

// ---------- popover menu ----------

const menuEl = () => $('#menu');

// entries: [{ label, action, color?, checked?, icon?, danger? } | '-' | { heading }]
export function showMenu(anchor, entries) {
  const menu = menuEl();
  menu.replaceChildren(...entries.map((entry) => {
    if (entry === '-') return el('hr');
    if (entry.heading) return el('div', { class: 'menu-heading' }, entry.heading);
    return el('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item${entry.danger ? ' danger' : ''}`,
      onclick: () => { hideMenu(); entry.action(); },
    },
    entry.color ? el('span', { class: 'dot', style: `background:${COLORS[entry.color] ?? COLORS.grey}` }) : null,
    entry.icon ? icon(entry.icon) : null,
    el('span', { class: 'menu-label' }, entry.label),
    entry.checked !== undefined ? el('span', { class: 'check' }, entry.checked ? '✓' : '') : null);
  }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = menu;
  const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  menu.querySelector('button')?.focus();
}

export function hideMenu() {
  menuEl().hidden = true;
}

document.addEventListener('click', (e) => {
  const menu = menuEl();
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[aria-haspopup="menu"]')) hideMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

// ---------- dialog ----------

function buildField(f) {
  const label = (text) => el('span', { class: 'label' }, text);
  switch (f.type) {
    case 'help':
      return el('p', { class: 'field-help' }, f.text);
    case 'color':
      return el('div', { class: 'field' }, label(f.label),
        el('div', { class: 'swatches', role: 'radiogroup' }, Object.entries(COLORS).map(([name, hex]) =>
          el('label', { class: 'swatch', title: name },
            el('input', { type: 'radio', name: f.name, value: name, checked: name === f.value }),
            el('span', { style: `background:${hex}` })))));
    case 'checkbox':
      return el('label', { class: 'field field-check' },
        el('input', { type: 'checkbox', name: f.name, checked: Boolean(f.value) }),
        el('span', {}, f.label));
    case 'days':
      return el('div', { class: 'field' }, label(f.label),
        el('div', { class: 'days' }, WEEK_ORDER.map((d) =>
          el('label', { class: 'day' },
            el('input', { type: 'checkbox', name: f.name, value: String(d), checked: f.value?.includes(d) }),
            el('span', {}, DAY_LABELS[d])))));
    case 'select':
      return el('label', { class: 'field' }, label(f.label),
        el('select', { name: f.name },
          f.options.map((o) => el('option', { value: o.value, selected: o.value === f.value }, o.label))));
    case 'textarea': {
      const area = el('textarea', { name: f.name, rows: '3', placeholder: f.placeholder });
      area.value = f.value ?? '';
      return el('label', { class: 'field' }, label(f.label), area);
    }
    default: {
      const input = el('input', {
        type: f.type ?? 'text', name: f.name, required: f.required, placeholder: f.placeholder, spellcheck: 'false',
      });
      input.value = f.value ?? '';
      return el('label', { class: 'field' }, label(f.label), input);
    }
  }
}

function readFields(form, fields) {
  const values = {};
  for (const f of fields) {
    if (!f.name) continue;
    if (f.type === 'checkbox') values[f.name] = form.elements[f.name].checked;
    else if (f.type === 'days') values[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => Number(i.value));
    else if (f.type === 'color') values[f.name] = form.querySelector(`input[name="${f.name}"]:checked`)?.value;
    else values[f.name] = form.elements[f.name].value;
  }
  return values;
}

// Resolves to { action: 'ok' | 'cancel' | 'delete', values }.
export function openDialog({ title, message = '', fields = [], okLabel = 'Зберегти', deleteLabel, danger = false }) {
  const dialog = $('#dialog');
  const form = $('#dialogForm');
  $('#dialogTitle').textContent = title;
  $('#dialogMessage').textContent = message;
  $('#dialogMessage').hidden = !message;
  $('#dialogOk').textContent = okLabel;
  $('#dialogOk').classList.toggle('danger', danger);
  $('#dialogOk').classList.toggle('primary', !danger);
  $('#dialogDelete').hidden = !deleteLabel;
  if (deleteLabel) $('#dialogDelete').textContent = deleteLabel;
  $('#dialogFields').replaceChildren(...fields.map(buildField));

  dialog.returnValue = '';
  dialog.showModal();
  dialog.querySelector('input[type=text], input[type=url]')?.select();

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve({ action: dialog.returnValue || 'cancel', values: readFields(form, fields) });
    }, { once: true });
  });
}

export const confirmDialog = async (title, message, okLabel = 'Видалити') =>
  (await openDialog({ title, message, okLabel, danger: true })).action === 'ok';
