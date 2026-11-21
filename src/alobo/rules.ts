export type Area = "quan-2" | "tan-binh" | "tan-phu";
export type Interval = readonly [start: number, end: number];

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const DAY_MS = DAY_MINUTES * MINUTE_MS;
const WEEK_DAYS = 7;
const HORIZON_EXTRA_DAYS = 20;
const VN_OFFSET_MINUTES = 7 * 60;
const MONDAY_BASED_WEEKEND = 5;
const QUAN_2_PREFERENCES: Interval[] = [
  [1080, 1200],
  [1080, 1140],
];
const EVENING_OPENS = 1140;
const EVENING_CLOSES = 1380;
const MIN_BOOKING_MINUTES = 120;
const AFTERNOON_OPENS = 780;
const AFTERNOON_CLOSES = 1020;
export const AFTERNOON_MINUTES = [60, 120] as const;

type Local = { day: string; minutes: number };

function dayString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function local(now: Date): Local {
  const shifted = now.getTime() + VN_OFFSET_MINUTES * MINUTE_MS;
  const day = dayString(shifted);
  const minutes = Math.floor((shifted - dayStart(day)) / MINUTE_MS);
  return { day, minutes };
}

export function weekday(day: string): number {
  return (new Date(dayStart(day)).getUTCDay() + 6) % WEEK_DAYS;
}

export function searchDates(now: Date): string[] {
  const today = local(now).day;
  const monday = dayStart(today) - weekday(today) * DAY_MS;
  const end = monday + HORIZON_EXTRA_DAYS * DAY_MS;
  const days: string[] = [];
  for (let cursor = dayStart(today); cursor <= end; cursor += DAY_MS)
    days.push(dayString(cursor));
  return days;
}

function merge(intervals: readonly Interval[]): Interval[] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  )) {
    if (!(start >= 0 && start < end && end <= DAY_MINUTES)) {
      throw new Error("Invalid availability interval");
    }
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
}

function clip(
  merged: readonly Interval[],
  earliest: number,
  latest: number,
  shortest: number,
): Interval[] {
  const result: Interval[] = [];
  for (const [a, b] of merged) {
    const start = Math.max(a, earliest);
    const end = Math.min(b, latest);
    if (end - start >= shortest) result.push([start, end]);
  }
  return result;
}

export function afternoonWindows(
  day: string,
  intervals: readonly Interval[],
  now: Date,
): Interval[] {
  const here = local(now);
  if (!searchDates(now).includes(day)) return [];
  const earliest =
    day === here.day
      ? Math.max(AFTERNOON_OPENS, here.minutes + 1)
      : AFTERNOON_OPENS;
  return clip(
    merge(intervals),
    earliest,
    AFTERNOON_CLOSES,
    Math.min(...AFTERNOON_MINUTES),
  );
}

export function windows(
  area: Area,
  day: string,
  intervals: readonly Interval[],
  now: Date,
): Interval[] {
  const here = local(now);
  if (!searchDates(now).includes(day)) return [];
  const merged = merge(intervals);

  const fits = (start: number, end: number): boolean => {
    const startsAt =
      dayStart(day) - VN_OFFSET_MINUTES * MINUTE_MS + start * MINUTE_MS;
    return (
      startsAt > now.getTime() &&
      merged.some(([a, b]) => a <= start && end <= b)
    );
  };

  if (area === "quan-2") {
    if (weekday(day) >= MONDAY_BASED_WEEKEND) return [];
    for (const [start, end] of QUAN_2_PREFERENCES)
      if (fits(start, end)) return [[start, end]];
    return [];
  }
  if (area === "tan-binh" || area === "tan-phu") {
    const earliest =
      day === here.day
        ? Math.max(EVENING_OPENS, here.minutes + 1)
        : EVENING_OPENS;
    return clip(merged, earliest, EVENING_CLOSES, MIN_BOOKING_MINUTES);
  }
  throw new Error("Unknown area");
}
