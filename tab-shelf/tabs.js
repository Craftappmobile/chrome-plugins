// Opening links and categories; works from the side panel and from the service worker
// (where there may be no browser window at all).
import { COLORS } from './storage.js';

async function targetWindowId() {
  try {
    return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  } catch {
    return undefined;
  }
}

export async function openInBrowser(url, { active = true } = {}) {
  const windowId = await targetWindowId();
  if (windowId === undefined) return chrome.windows.create({ url, focused: true });
  const tab = await chrome.tabs.create({ url, active, windowId });
  if (active) chrome.windows.update(windowId, { focused: true });
  return tab;
}

// Opens every link of a category as one native tab group with the same name and color.
export async function openCategoryAsGroup(cat, windowId) {
  const urls = cat.items.map((i) => i.url);
  if (!urls.length) return;
  windowId ??= await targetWindowId();

  const tabIds = [];
  let start = 0;
  if (windowId === undefined) {
    const win = await chrome.windows.create({ url: urls[0], focused: true });
    windowId = win.id;
    tabIds.push(win.tabs[0].id);
    start = 1;
  }
  for (let n = start; n < urls.length; n++) {
    const tab = await chrome.tabs.create({ url: urls[n], active: n === 0, windowId });
    tabIds.push(tab.id);
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: cat.name, color: cat.color in COLORS ? cat.color : 'grey' });
}
