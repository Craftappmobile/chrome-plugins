import {
  load, update, addItem, findItem, findCategory, snoozeTab, dueTime, allItems,
  loadSettings, updateSettings, STORAGE_KEY, SETTINGS_KEY, INBOX_ID,
} from './storage.js';
import { nextOccurrence, nextScheduled, presetList, presetTime } from './reminders.js';
import { openInBrowser, openCategoryAsGroup } from './tabs.js';
import { postToSlack, buildDigest, buildReminderMessage, collectOpenTabs } from './slack.js';

const MENU_PAGE = 'save-page';
const MENU_LINK = 'save-link';
const MENU_SNOOZE = 'snooze';
const ALARM_DIGEST = 'digest';
const MINUTE = 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Persist the initial data so every view starts from the same state.
  await update(() => {});
  refresh();
});

chrome.runtime.onStartup.addListener(refresh);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY]) refresh();
  else if (changes[SETTINGS_KEY]) queue(syncAlarms);
});

// Serialize rebuilds so overlapping storage events don't interleave.
let chain = Promise.resolve();
function queue(task) {
  chain = chain.then(task).catch((e) => console.error(e));
  return chain;
}

function refresh() {
  queue(rebuildMenus);
  queue(syncAlarms);
}

// ---------- context menu ----------

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const { categories } = await load();
  chrome.contextMenus.create({ id: MENU_PAGE, title: 'Зберегти сторінку в Tab Shelf', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_LINK, title: 'Зберегти посилання в Tab Shelf', contexts: ['link'] });
  chrome.contextMenus.create({ id: MENU_SNOOZE, title: 'Відкласти вкладку', contexts: ['page'] });
  for (const cat of categories) {
    chrome.contextMenus.create({ id: `${MENU_PAGE}:${cat.id}`, parentId: MENU_PAGE, title: cat.name, contexts: ['page'] });
    chrome.contextMenus.create({ id: `${MENU_LINK}:${cat.id}`, parentId: MENU_LINK, title: cat.name, contexts: ['link'] });
  }
  // "Today 18:00" may disappear later in the day, so only the time-independent presets go here.
  for (const p of presetList(new Date().setHours(0, 0, 0, 0)).filter((p) => p.key !== 'evening')) {
    chrome.contextMenus.create({ id: `${MENU_SNOOZE}:${p.key}`, parentId: MENU_SNOOZE, title: p.label, contexts: ['page'] });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [kind, arg] = String(info.menuItemId).split(':');
  if (!arg) return;
  if (kind === MENU_PAGE && tab) {
    await update((data) => addItem(data, arg, { url: tab.url, title: tab.title }));
  } else if (kind === MENU_LINK) {
    await update((data) => addItem(data, arg, { url: info.linkUrl, title: info.selectionText || info.linkUrl }));
  } else if (kind === MENU_SNOOZE && tab) {
    const at = presetTime(arg);
    const item = at && await update((data) => snoozeTab(data, tab, at));
    if (item) await chrome.tabs.remove(tab.id);
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

// ---------- alarms ----------

// Makes chrome.alarms match the reminders, schedules and digest stored in data/settings.
async function syncAlarms() {
  const data = await load();
  const settings = await loadSettings();
  const now = Date.now();
  const want = new Map();

  for (const cat of data.categories) {
    if (cat.schedule?.enabled) {
      const t = nextScheduled(cat.schedule, Math.max(now, (cat.schedule.lastRun ?? 0) + MINUTE));
      if (t) want.set(`cat:${cat.id}`, t);
    }
    for (const item of cat.items) {
      if (item.reminder && !item.reminder.fired && !item.done) want.set(`item:${item.id}`, dueTime(item.reminder));
    }
  }

  const { slack } = settings;
  if (slack.digestEnabled && slack.webhookUrl) {
    const t = nextScheduled({ time: slack.digestTime, days: slack.digestDays }, Math.max(now, slack.lastDigest + MINUTE));
    if (t) want.set(ALARM_DIGEST, t);
  }

  for (const alarm of await chrome.alarms.getAll()) {
    const t = want.get(alarm.name);
    // Chrome may push very near alarms out by up to 30 s, so compare loosely.
    const matches = t !== undefined
      && (Math.abs(alarm.scheduledTime - t) <= 30000 || (t <= now && alarm.scheduledTime <= now + MINUTE));
    if (matches) {
      want.delete(alarm.name);
    } else {
      await chrome.alarms.clear(alarm.name);
    }
  }
  for (const [name, when] of want) await chrome.alarms.create(name, { when: Math.max(when, now + 1000) });

  const overdue = allItems(data).filter(({ item }) => item.reminder?.fired && !item.done).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#e8615a' });
  await chrome.action.setBadgeText({ text: overdue ? String(overdue) : '' });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const sep = alarm.name.indexOf(':');
  const kind = sep === -1 ? alarm.name : alarm.name.slice(0, sep);
  const id = alarm.name.slice(sep + 1);
  if (kind === 'item') queue(() => fireReminder(id));
  else if (kind === 'cat') queue(() => runSchedule(id));
  else if (kind === ALARM_DIGEST) queue(sendDigest);
});

async function fireReminder(itemId) {
  const data = await load();
  const found = findItem(data, itemId);
  const reminder = found?.item.reminder;
  if (!reminder || found.item.done || reminder.fired) return;
  if (dueTime(reminder) > Date.now() + 5000) return; // stale alarm; syncAlarms reschedules it

  if (reminder.reopen) {
    await openInBrowser(found.item.url);
    await update((d) => {
      const f = findItem(d, itemId);
      if (f) f.cat.items.splice(f.index, 1);
    });
    return;
  }

  chrome.notifications.create(`item:${itemId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `⏰ ${found.item.title}`.slice(0, 120),
    message: found.item.note || found.cat.name,
    contextMessage: 'Tab Shelf',
    buttons: [{ title: 'Відкрити' }, { title: 'Відкласти на 1 год' }],
    requireInteraction: true,
  });

  const settings = await loadSettings();
  if (settings.slack.sendReminders) {
    postToSlack(settings.slack.webhookUrl, buildReminderMessage(found.item, found.cat))
      .catch((e) => console.warn('Slack reminder failed:', e.message));
  }

  await update((d) => {
    const r = findItem(d, itemId)?.item.reminder;
    if (!r) return;
    if (r.snoozeUntil) {
      delete r.snoozeUntil;
      if (r.repeat === 'none') r.fired = true;
    } else if (r.repeat && r.repeat !== 'none') {
      r.at = nextOccurrence(r.at, r.repeat);
    } else {
      r.fired = true;
    }
  });
}

async function runSchedule(catId) {
  const data = await load();
  const cat = findCategory(data, catId);
  if (!cat?.schedule?.enabled) return;
  await update((d) => {
    const c = findCategory(d, catId);
    if (c?.schedule) c.schedule.lastRun = Date.now();
  });
  await openCategoryAsGroup(cat);
}

async function sendDigest() {
  const settings = await updateSettings((s) => { s.slack.lastDigest = Date.now(); });
  const { slack } = settings;
  if (!slack.digestEnabled) return;
  const openTabs = slack.includeOpenTabs ? await collectOpenTabs() : null;
  await postToSlack(slack.webhookUrl, buildDigest(await load(), { openTabs }))
    .catch((e) => console.warn('Slack digest failed:', e.message));
}

// ---------- notifications ----------

async function openReminder(notificationId) {
  chrome.notifications.clear(notificationId);
  const found = findItem(await load(), notificationId.replace(/^item:/, ''));
  if (found) await openInBrowser(found.item.url);
}

chrome.notifications.onClicked.addListener(openReminder);

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (buttonIndex === 0) return openReminder(notificationId);
  chrome.notifications.clear(notificationId);
  await update((d) => {
    const r = findItem(d, notificationId.replace(/^item:/, ''))?.item.reminder;
    if (!r) return;
    r.snoozeUntil = Date.now() + 60 * MINUTE;
    r.fired = false;
  });
});
