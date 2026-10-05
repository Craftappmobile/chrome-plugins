// Slack integration through an Incoming Webhook URL the user pastes in the settings.
// Nothing is sent unless the user configured a webhook and turned the feature on.
import { allItems, dueTime, isSavableUrl } from './storage.js';
import { formatWhen } from './reminders.js';

export const SLACK_ORIGIN = 'https://hooks.slack.com/*';
const MAX_LINES = 25;

export const isWebhookUrl = (url) => typeof url === 'string' && /^https:\/\/hooks\.slack\.com\/\S+$/.test(url.trim());

export async function hasSlackPermission() {
  return chrome.permissions.contains({ origins: [SLACK_ORIGIN] });
}

export async function postToSlack(webhookUrl, text) {
  if (!isWebhookUrl(webhookUrl)) throw new Error('Не налаштовано вебхук Slack');
  if (!(await hasSlackPermission())) throw new Error('Немає дозволу на доступ до Slack');
  const res = await fetch(webhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
  });
  if (!res.ok) throw new Error(`Slack відповів ${res.status}: ${await res.text()}`);
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function link({ url, title }) {
  const safeUrl = url.replace(/[|<>]/g, (c) => encodeURIComponent(c));
  return `<${safeUrl}|${escape(title || url)}>`;
}

function section(title, lines) {
  if (!lines.length) return '';
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`_…і ще ${lines.length - MAX_LINES}_`);
  return `*${title} (${lines.length})*\n${shown.join('\n')}`;
}

const isToday = (ts, now) => ts && new Date(ts).toDateString() === new Date(now).toDateString();

// Open tabs grouped by tab group: [{ title, tabs: [{ url, title }] }]
export async function collectOpenTabs() {
  const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter((t) => isSavableUrl(t.url));
  const groups = new Map();
  for (const t of tabs) {
    if (!groups.has(t.groupId)) groups.set(t.groupId, []);
    groups.get(t.groupId).push({ url: t.url, title: t.title });
  }
  const result = [];
  for (const [groupId, groupTabs] of groups) {
    let title = 'Без групи';
    if (groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      title = (await chrome.tabGroups.get(groupId).catch(() => null))?.title || 'Група без назви';
    }
    result.push({ title, tabs: groupTabs });
  }
  return result;
}

// "Робочий контекст" — what was done, what is due, what was saved today, what is open now.
export function buildDigest(data, { openTabs = null, now = Date.now() } = {}) {
  const items = allItems(data);
  const tag = (cat) => ` — _${escape(cat.name)}_`;

  const done = items.filter(({ item }) => item.done && isToday(item.doneAt, now))
    .map(({ cat, item }) => `• ${link(item)}${tag(cat)}`);

  const pending = items.filter(({ item }) => item.reminder && !item.done && !item.reminder.reopen)
    .sort((a, b) => dueTime(a.item.reminder) - dueTime(b.item.reminder));
  const overdue = pending.filter(({ item }) => item.reminder.fired || dueTime(item.reminder) <= now)
    .map(({ cat, item }) => `• ${link(item)} — ${formatWhen(dueTime(item.reminder), now)}${tag(cat)}`);
  const upcoming = pending.filter(({ item }) => !item.reminder.fired && dueTime(item.reminder) > now
      && dueTime(item.reminder) < now + 2 * 24 * 60 * 60 * 1000)
    .map(({ cat, item }) => `• ${link(item)} — ${formatWhen(dueTime(item.reminder), now)}${tag(cat)}`);

  const saved = items.filter(({ item }) => isToday(item.addedAt, now))
    .map(({ cat, item }) => `• ${link(item)}${tag(cat)}`);

  const open = (openTabs ?? []).flatMap((g) => [`_${escape(g.title)}_`, ...g.tabs.map((t) => `• ${link(t)}`)]);
  const openCount = (openTabs ?? []).reduce((n, g) => n + g.tabs.length, 0);

  const stamp = new Date(now).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = [
    `*🗂 Робочий контекст · ${stamp}*`,
    section('✅ Зроблено сьогодні', done),
    section('⚠️ Прострочені нагадування', overdue),
    section('⏰ Найближчі нагадування', upcoming),
    section('📥 Збережено сьогодні', saved),
    openTabs ? (openCount ? `*🌐 Відкриті вкладки (${openCount})*\n${open.slice(0, MAX_LINES * 2).join('\n')}` : '') : '',
  ].filter(Boolean);

  if (parts.length === 1) parts.push('_Сьогодні без змін._');
  return parts.join('\n\n');
}

export function buildCategoryMessage(cat) {
  const lines = cat.items.map((i) => `• ${i.done ? '~' : ''}${link(i)}${i.done ? '~' : ''}${i.note ? ` — ${escape(i.note)}` : ''}`);
  return section(`🗂 ${escape(cat.name)}`, lines) || `*🗂 ${escape(cat.name)}* — порожньо`;
}

export function buildReminderMessage(item, cat) {
  const note = item.note ? `\n> ${escape(item.note).replace(/\n/g, '\n> ')}` : '';
  return `⏰ *Нагадування:* ${link(item)} — _${escape(cat.name)}_${note}`;
}
