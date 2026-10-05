import { load, update, addItem, STORAGE_KEY, INBOX_ID } from './storage.js';

const MENU_PAGE = 'save-page';
const MENU_LINK = 'save-link';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Persist the initial data so every view starts from the same state.
  await update(() => {});
  await rebuildMenus();
});

chrome.runtime.onStartup.addListener(rebuildMenus);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) rebuildMenus();
});

// Context menu: "Зберегти в Tab Shelf → <category>" for pages and links.
let rebuilding = Promise.resolve();
function rebuildMenus() {
  rebuilding = rebuilding.then(async () => {
    await chrome.contextMenus.removeAll();
    const { categories } = await load();
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Зберегти сторінку в Tab Shelf', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_LINK, title: 'Зберегти посилання в Tab Shelf', contexts: ['link'] });
    for (const cat of categories) {
      chrome.contextMenus.create({ id: `${MENU_PAGE}:${cat.id}`, parentId: MENU_PAGE, title: cat.name, contexts: ['page'] });
      chrome.contextMenus.create({ id: `${MENU_LINK}:${cat.id}`, parentId: MENU_LINK, title: cat.name, contexts: ['link'] });
    }
  }).catch((e) => console.error('Menu rebuild failed', e));
  return rebuilding;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [kind, catId] = String(info.menuItemId).split(':');
  if (!catId) return;
  if (kind === MENU_PAGE && tab) {
    await update((data) => addItem(data, catId, { url: tab.url, title: tab.title }));
  } else if (kind === MENU_LINK) {
    await update((data) => addItem(data, catId, { url: info.linkUrl, title: info.selectionText || info.linkUrl }));
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'save-current-tab') return;
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return;
  const added = await update((data) => addItem(data, INBOX_ID, { url: tab.url, title: tab.title }));
  if (added) {
    chrome.action.setBadgeBackgroundColor({ color: '#3fae6a' });
    chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 1500);
  }
});
