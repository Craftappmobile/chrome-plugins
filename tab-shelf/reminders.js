// Date math and labels for reminders, snoozes and schedules. All times are local.

export const REPEATS = {
  none: 'Не повторювати',
  daily: 'Щодня',
  weekdays: 'По буднях',
  weekly: 'Щотижня',
};

export const DAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // indexed by Date#getDay()
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Next time a repeating reminder is due strictly after `after`; null for one-off reminders.
export function nextOccurrence(at, repeat, after = Date.now()) {
  if (!repeat || repeat === 'none') return null;
  const d = new Date(at);
  do {
    if (repeat === 'weekly') {
      d.setDate(d.getDate() + 7);
    } else {
      d.setDate(d.getDate() + 1);
      if (repeat === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    }
  } while (d.getTime() <= after);
  return d.getTime();
}

// Next run of a weekly schedule ({ time: 'HH:MM', days: [0-6] }) strictly after `after`.
export function nextScheduled({ time, days }, after = Date.now()) {
  if (!days?.length || !/^\d{1,2}:\d{2}$/.test(time ?? '')) return null;
  const [h, m] = time.split(':').map(Number);
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > after && days.includes(d.getDay())) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return null;
}

function atDay(now, plusDays, hours, minutes = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

const PRESETS = {
  '1h': { label: 'Через 1 годину', at: (now) => Math.ceil((now + HOUR) / 60000) * 60000 },
  '3h': { label: 'Через 3 години', at: (now) => Math.ceil((now + 3 * HOUR) / 60000) * 60000 },
  evening: { label: 'Сьогодні о 18:00', at: (now) => atDay(now, 0, 18), when: (now) => new Date(now).getHours() < 17 },
  tomorrow: { label: 'Завтра о 9:00', at: (now) => atDay(now, 1, 9) },
  monday: { label: 'У понеділок о 9:00', at: (now) => atDay(now, ((8 - new Date(now).getDay()) % 7) || 7, 9) },
};

export function presetList(now = Date.now()) {
  return Object.entries(PRESETS)
    .filter(([, p]) => !p.when || p.when(now))
    .map(([key, p]) => ({ key, label: p.label }));
}

export function presetTime(key, now = Date.now()) {
  return PRESETS[key]?.at(now) ?? null;
}

const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

// "сьогодні 18:00", "завтра 09:00", "пт 09:00", "12.10 09:00"
export function formatWhen(ts, now = Date.now()) {
  const time = formatTime(ts);
  const diff = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  if (diff === 0) return `сьогодні ${time}`;
  if (diff === 1) return `завтра ${time}`;
  if (diff === -1) return `вчора ${time}`;
  if (diff > 1 && diff < 7) return `${DAY_LABELS[new Date(ts).getDay()].toLowerCase()} ${time}`;
  return `${new Date(ts).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export function formatDays(days = []) {
  const set = new Set(days);
  if (set.size === 7) return 'щодня';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Пн–Пт';
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => DAY_LABELS[d]).join(', ');
}

// <input type="datetime-local"> <-> timestamp
export function toInputValue(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputValue(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}
