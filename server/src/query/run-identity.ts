const timestampId = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3}))?Z(?:-[a-zA-Z0-9._-]+)?$/;

const shanghaiTime = (() => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", era: "short",
    });
  } catch { return null; }
})();

interface ShanghaiClock {
  date: Date;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function toShanghaiClock(date: Date): ShanghaiClock | null {
  if (!Number.isFinite(date.getTime()) || !shanghaiTime) return null;
  try {
    const parts = Object.fromEntries(shanghaiTime.formatToParts(date).map(part => [part.type, part.value]));
    // This summary has no era field, so do not misrepresent an ISO year zero as AD year one.
    if (parts.era !== "AD" || ["year", "month", "day", "hour", "minute", "second"].some(key => !/^\d+$/.test(parts[key] ?? ""))) return null;
    return {
      date,
      year: parts.year.padStart(4, "0"),
      month: parts.month.padStart(2, "0"),
      day: parts.day.padStart(2, "0"),
      hour: parts.hour.padStart(2, "0"),
      minute: parts.minute.padStart(2, "0"),
      second: parts.second.padStart(2, "0"),
    };
  } catch { return null; }
}

function parseTimestampIdDate(id: string): { date: Date; millis?: string } | null {
  const match = timestampId.exec(id);
  // `$` also matches before a final newline; canonical IDs must consume the entire input.
  if (!match || match[0] !== id) return null;
  const utc = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5] ?? "000"}Z`;
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== utc) return null;
  return { date, millis: match[5] };
}

function parseIsoDate(iso?: string): Date | null {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function formatDurationBadge(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** A readable date is optional metadata; the complete recorded ID remains the identity. */
export function runIdentity(id: string): { id: string; summary: string | null } {
  const unknown = { id, summary: null };
  const parsed = parseTimestampIdDate(id);
  if (!parsed) return unknown;
  const clock = toShanghaiClock(parsed.date);
  if (!clock) return unknown;
  const day = `${clock.year}/${clock.month}/${clock.day}`;
  const time = `${clock.hour}:${clock.minute}:${clock.second}`;
  return { id, summary: `${day} ${time}${parsed.millis === undefined ? "" : `.${parsed.millis}`}` };
}

/** Formats a run's start–end window and duration in Asia/Shanghai without millisecond noise. */
export function runWindowSummary(run: { id: string; startedAt?: string; endedAt?: string }): { id: string; summary: string | null } {
  const idParsed = parseTimestampIdDate(run.id);
  const startDate = idParsed?.date ?? parseIsoDate(run.startedAt);
  const startClock = startDate ? toShanghaiClock(startDate) : null;
  if (!startClock) return { id: run.id, summary: null };
  const startDay = `${startClock.year}/${startClock.month}/${startClock.day}`;
  const endDate = parseIsoDate(run.endedAt);
  const endClock = endDate && endDate.getTime() >= startClock.date.getTime() ? toShanghaiClock(endDate) : null;
  if (!endClock) {
    return { id: run.id, summary: `${startDay} ${startClock.hour}:${startClock.minute}:${startClock.second}` };
  }
  const durationMs = endClock.date.getTime() - startClock.date.getTime();
  const duration = formatDurationBadge(durationMs);
  const sameDay = startClock.year === endClock.year && startClock.month === endClock.month && startClock.day === endClock.day;
  const sameYear = startClock.year === endClock.year;
  if (durationMs < 60_000) {
    const startHms = `${startClock.hour}:${startClock.minute}:${startClock.second}`;
    const endHms = `${endClock.hour}:${endClock.minute}:${endClock.second}`;
    const endPart = sameDay ? endHms : sameYear ? `${endClock.month}/${endClock.day} ${endHms}` : `${endClock.year}/${endClock.month}/${endClock.day} ${endHms}`;
    return { id: run.id, summary: `${startDay} ${startHms} – ${endPart} · ${duration}` };
  }
  const startHm = `${startClock.hour}:${startClock.minute}`;
  const endHm = `${endClock.hour}:${endClock.minute}`;
  const endPart = sameDay ? endHm : sameYear ? `${endClock.month}/${endClock.day} ${endHm}` : `${endClock.year}/${endClock.month}/${endClock.day} ${endHm}`;
  return { id: run.id, summary: `${startDay} ${startHm} – ${endPart} · ${duration}` };
}
