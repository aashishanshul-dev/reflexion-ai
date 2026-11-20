export interface DemoVisitorRecord {
  leadId: string;
  name: string;
  email: string;
  phone: string;
  registeredAt: string;
  aiRequestCount: number;
  meditateCount: number;
  ranMeditate: boolean;
}

export interface DemoVisitorDayBucket {
  dateIso: string;
  label: string;
  count: number;
}

export interface DemoVisitorMetrics {
  total: number;
  today: number;
  last7Days: number;
  last30Days: number;
  dailySeries: DemoVisitorDayBucket[];
  sortedVisitors: DemoVisitorRecord[];
}

function safeTimeZone(timeZone?: string): string {
  const candidate = (timeZone || '').trim() || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

export function toCalendarDateKey(isoOrDate: string | Date, timeZone?: string): string | null {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return null;
  const tz = safeTimeZone(timeZone);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatShortDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return utc.toISOString().slice(0, 10);
}

export function normalizeDemoVisitorRecord(
  leadId: string,
  raw: Record<string, unknown> | undefined
): DemoVisitorRecord {
  const data = raw || {};
  const registeredAt =
    typeof data.registeredAt === 'string' && !Number.isNaN(Date.parse(data.registeredAt))
      ? data.registeredAt
      : typeof data.createdAt === 'string' && !Number.isNaN(Date.parse(data.createdAt))
        ? data.createdAt
        : new Date(0).toISOString();
  const meditateCount = Math.max(0, Math.floor(Number(data.meditateCount) || 0));
  const aiRequestCount = Math.max(meditateCount, Math.floor(Number(data.aiRequestCount) || 0));
  const ranMeditate = Boolean(data.ranMeditate) || meditateCount > 0;

  return {
    leadId,
    name: String(data.name ?? '').trim() || 'Unknown Guest',
    email: String(data.email ?? '').trim(),
    phone: String(data.phone ?? '').trim(),
    registeredAt,
    aiRequestCount,
    meditateCount,
    ranMeditate,
  };
}

export function sortVisitorsNewestFirst(visitors: DemoVisitorRecord[]): DemoVisitorRecord[] {
  return [...visitors].sort((a, b) => {
    const tA = Date.parse(a.registeredAt) || 0;
    const tB = Date.parse(b.registeredAt) || 0;
    if (tB !== tA) return tB - tA;
    return a.name.localeCompare(b.name);
  });
}

export function computeDemoVisitorMetrics(
  visitors: DemoVisitorRecord[],
  now: Date = new Date(),
  timeZone?: string
): DemoVisitorMetrics {
  const tz = safeTimeZone(timeZone);
  const todayKey = toCalendarDateKey(now, tz) || now.toISOString().slice(0, 10);
  const start7Key = shiftDateKey(todayKey, -6);
  const start30Key = shiftDateKey(todayKey, -29);

  const countsByDay = new Map<string, number>();
  for (let offset = 29; offset >= 0; offset--) {
    countsByDay.set(shiftDateKey(todayKey, -offset), 0);
  }

  let today = 0;
  let last7Days = 0;
  let last30Days = 0;

  for (const visitor of visitors) {
    const dayKey = toCalendarDateKey(visitor.registeredAt, tz);
    if (!dayKey) continue;
    if (dayKey === todayKey) today += 1;
    if (dayKey >= start7Key && dayKey <= todayKey) last7Days += 1;
    if (dayKey >= start30Key && dayKey <= todayKey) {
      last30Days += 1;
      if (countsByDay.has(dayKey)) {
        countsByDay.set(dayKey, (countsByDay.get(dayKey) || 0) + 1);
      }
    }
  }

  const dailySeries: DemoVisitorDayBucket[] = Array.from(countsByDay.entries()).map(
    ([dateIso, count]) => ({
      dateIso,
      label: formatShortDayLabel(dateIso),
      count,
    })
  );

  return {
    total: visitors.length,
    today,
    last7Days,
    last30Days,
    dailySeries,
    sortedVisitors: sortVisitorsNewestFirst(visitors),
  };
}

export function filterDemoVisitors(
  visitors: DemoVisitorRecord[],
  query: string
): DemoVisitorRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return visitors;
  const digitQ = q.replace(/\D/g, '');

  return visitors.filter((v) => {
    if (v.name.toLowerCase().includes(q)) return true;
    if (v.email.toLowerCase().includes(q)) return true;
    if (v.phone.toLowerCase().includes(q)) return true;
    if (digitQ.length >= 3 && v.phone.replace(/\D/g, '').includes(digitQ)) return true;
    return false;
  });
}

function escapeCsvCell(value: string, allowLeadingPlusPhone: boolean = false): string {
  let text = String(value ?? '');
  const isPurePhone = allowLeadingPlusPhone && /^\+[0-9\s()-]+$/.test(text.trim());
  if (!isPurePhone && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function formatVisitorDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = safeTimeZone(timeZone);
  return d.toLocaleString('en-IN', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function buildDemoVisitorsCsv(
  visitors: DemoVisitorRecord[],
  timeZone?: string
): string {
  const headers = [
    'Registered At',
    'Name',
    'Email',
    'Phone',
    'Ran Meditate',
    'AI Requests',
  ];
  const rows = visitors.map((v) =>
    [
      escapeCsvCell(formatVisitorDateTime(v.registeredAt, timeZone)),
      escapeCsvCell(v.name),
      escapeCsvCell(v.email),
      escapeCsvCell(v.phone, true),
      escapeCsvCell(v.ranMeditate ? 'Yes' : 'No'),
      String(v.aiRequestCount),
    ].join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}
