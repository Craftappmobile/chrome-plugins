// Shared data layer for the side panel and the background service worker.
// Everything lives in chrome.storage.local under a single key:
//   { categories: [{ id, name, color, collapsed, items: [{ id, title, url, addedAt }] }] }

export const STORAGE_KEY = 'shelf';
export const INBOX_ID = 'inbox';

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

function ensureInbox(data) {
  let inbox = findCategory(data, INBOX_ID);
  if (!inbox) {
    inbox = { id: INBOX_ID, name: 'Вхідні', color: 'grey', collapsed: false, items: [] };
    data.categories.unshift(inbox);
  }
  return inbox;
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
// Returns false when the URL is invalid or already in that category.
export function addItem(data, catId, { url, title }) {
  if (!isSavableUrl(url)) return false;
  const cat = findCategory(data, catId) ?? ensureInbox(data);
  if (cat.items.some((i) => i.url === url)) return false;
  cat.items.push({ id: uid(), url, title: title?.trim() || url, addedAt: Date.now() });
  return true;
}

export function faviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}
