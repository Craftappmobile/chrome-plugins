// Shared data layer for the side panel and the background service worker.
// Everything lives in chrome.storage.local under a single key:
//   { categories: [{ id, name, color, collapsed, schedule?, items: [Item] }] }
// Item: { id, title, url, addedAt, note?, done?, doneAt?, reminder? }
// Reminder: { at, repeat: 'none'|'daily'|'weekdays'|'weekly', fired?, snoozeUntil?, reopen? }
// Schedule (auto-open a category): { enabled, time: 'HH:MM', days: [0-6], lastRun? }

export const STORAGE_KEY = 'shelf';
export const SETTINGS_KEY = 'settings';
export const INBOX_ID = 'inbox';
export const SNOOZED_ID = 'snoozed';

// Same palette as Chrome tab groups, so a category can be opened as a native group.
export const COLORS = {
  grey: '#9aa0a6',
  blue: '#5b8def',
  red: '#e8615a',
  yellow: '#f2b822',
  green: '#3fae6a',
  pink: '#e5609f',
  purple: '#a45ef0',
  cyan: '#21a8c4',
  orange: '#f0873a',
};

export const DEFAULT_SETTINGS = {
  openInNewTab: false,
  slack: {
    webhookUrl: '',
    sendReminders: false,
    digestEnabled: false,
    digestTime: '18:00',
    digestDays: [1, 2, 3, 4, 5],
    includeOpenTabs: false,
    lastDigest: 0,
  },
};

export const uid = () => crypto.randomUUID();

const emptyData = () => ({
  categories: [{ id: INBOX_ID, name: 'Вхідні', color: 'grey', collapsed: false, items: [] }],
});

export async function load() {
  const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
  return data?.categories ? data : emptyData();
}

export async function save(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// Load, mutate in place via fn, persist. Returns whatever fn returns.
export async function update(fn) {
  const data = await load();
  const result = fn(data);
  await save(data);
  return result;
}

export function withDefaults(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    slack: { ...DEFAULT_SETTINGS.slack, ...settings?.slack },
  };
}

export async function loadSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return withDefaults(settings);
}

export async function updateSettings(fn) {
  const settings = await loadSettings();
  fn(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export function findCategory(data, catId) {
  return data.categories.find((c) => c.id === catId);
}

export function findItem(data, itemId) {
  for (const cat of data.categories) {
    const index = cat.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { cat, item: cat.items[index], index };
  }
  return null;
}

export function allItems(data) {
  return data.categories.flatMap((cat) => cat.items.map((item) => ({ cat, item })));
}

const BUILTIN = {
  [INBOX_ID]: { name: 'Вхідні', color: 'grey', index: 0 },
  [SNOOZED_ID]: { name: 'Відкладені', color: 'purple', index: 1 },
};

// Returns a built-in category, recreating it if the user deleted it.
export function ensureCategory(data, catId) {
  let cat = findCategory(data, catId);
  if (!cat) {
    const def = BUILTIN[catId] ?? BUILTIN[INBOX_ID];
    cat = { id: catId, name: def.name, color: def.color, collapsed: false, items: [] };
    data.categories.splice(Math.min(def.index, data.categories.length), 0, cat);
  }
  return cat;
}

export function addCategory(data, { name, color = 'blue', index } = {}) {
  const cat = { id: uid(), name: name?.trim() || 'Нова категорія', color, collapsed: false, items: [] };
  if (index === undefined) data.categories.push(cat);
  else data.categories.splice(index, 0, cat);
  return cat;
}

export function isSavableUrl(url) {
  return typeof url === 'string' && /^(https?|ftp|file|chrome):/i.test(url);
}

// Adds a link to a category (Inbox when the category is missing).
// Returns the new item, or null when the URL is invalid or already in that category.
export function addItem(data, catId, { url, title }) {
  if (!isSavableUrl(url)) return null;
  const cat = findCategory(data, catId) ?? ensureCategory(data, INBOX_ID);
  if (cat.items.some((i) => i.url === url)) return null;
  const item = { id: uid(), url, title: title?.trim() || url, addedAt: Date.now() };
  cat.items.push(item);
  return item;
}

// Saves a tab into "Відкладені" so it reopens by itself at `at`.
export function snoozeTab(data, tab, at) {
  const cat = ensureCategory(data, SNOOZED_ID);
  const item = cat.items.find((i) => i.url === tab.url) ?? addItem(data, SNOOZED_ID, tab);
  if (item) item.reminder = { at, repeat: 'none', reopen: true };
  return item;
}

export const dueTime = (reminder) => reminder.snoozeUntil ?? reminder.at;

export function faviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}
