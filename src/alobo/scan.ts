import {
  type Area,
  type Interval,
  searchDates,
  weekday,
  windows,
} from "./rules";

export type Api = {
  request(route: string, query?: Record<string, string>): Promise<unknown>;
};

export type Venue = { id: string; name: string; area: string | null };
export type Origin = { name: string; latitude: number; longitude: number };
export type Origins = Partial<Record<Area, Origin>>;
export type RouteCache = Record<string, { at: number; meters: number }>;

export type Match = {
  branch_name: string;
  court_name: string;
  map_url: string;
  distance_m: number | null;
  date_label: string;
  time_label: string;
  url: string;
  branch_id: string;
  court_id: string;
  date: string;
  start: number;
  end: number;
  total_price: number | null;
};

export type ScannedVenue = { id: string; name: string; url: string };
export type VenueScan = { venue: ScannedVenue; matches: Match[] } | null;

type Json = Record<string, unknown>;

export const DISTRICTS: Record<Area, string> = {
  "quan-2": "769",
  "tan-binh": "766",
  "tan-phu": "767",
};
export const CRITERIA: Record<Area, string> = {
  "quan-2":
    "Thứ 2–6 · 18:00–20:00, ưu tiên 2 giờ, nếu không có thì 18:00–19:00 · 1 sân",
  "tan-binh": "Cả tuần · 2 giờ liên tục trong 19:00–23:00 · 1 sân",
  "tan-phu": "Cả tuần · 2 giờ liên tục trong 19:00–23:00 · 1 sân",
};

const ALOBO_HOME = "https://datlich.alobo.vn/";
const SLOT_STEP_MINUTES = 15;
const TWO_HOURS = 120;
const ROUTE_TTL_MS = 604_800_000;
const ROUTE_PAUSE_MS = 1100;
const ROUTE_URL =
  "https://routing.openstreetmap.de/routed-car/route/v1/driving/";
const ROUTE_USER_AGENT =
  "PipiCourtWatcher/1.0 (https://badminton.huyab.cfd/courts)";
const VN_OFFSET_MINUTES = 7 * 60;
const MINUTES_PER_DAY = 1440;
const PRICE_RULE_FIELDS = new Set([
  "time",
  "dateRangeWeek",
  "price",
  "priceOneTime",
  "unit",
  "minDuration",
]);

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function minuteOf(value: string): { day: string; minutes: number } {
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))
    throw new Error("Invalid Alobo timestamp");
  return { day: value.slice(0, 10), minutes: hour * 60 + minute };
}

export function occupancy(
  bookings: Json[],
  locks: Json[],
  courtId: string,
  day: string,
): Interval[] {
  const blocked: Interval[] = [];
  for (const booking of bookings) {
    if (booking.status !== 1) throw new Error("Unknown Alobo booking status");
    for (const raw of (booking.services as Json[] | undefined) ?? []) {
      if (raw.serviceId !== courtId) continue;
      const at = minuteOf(String(raw.startTime));
      if (at.day === day)
        blocked.push([at.minutes, at.minutes + Number(raw.duration)]);
    }
  }
  const isoWeekday = weekday(day) + 1;
  for (const lock of locks) {
    if (!(lock.servicesId as string[]).includes(courtId)) continue;
    const start = minuteOf(String(lock.startTime));
    const end = minuteOf(String(lock.endTime));
    const frequency = (lock.frequency as number[] | undefined) ?? [];
    const skipped = new Set(
      ((lock.skipDates as unknown[] | undefined) ?? []).map((item) =>
        String(item).slice(0, 10),
      ),
    );
    if (skipped.has(day)) continue;
    if (
      (frequency.length > 0 && frequency.includes(isoWeekday)) ||
      (frequency.length === 0 && start.day === day)
    ) {
      blocked.push([start.minutes, end.minutes]);
    }
  }
  return blocked;
}

export function freeIntervals(
  openAt: number,
  closeAt: number,
  blocked: Interval[],
): Interval[] {
  const result: Interval[] = [];
  let cursor = openAt;
  for (const [start, end] of [...blocked].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  )) {
    if (end <= cursor) continue;
    if (start > cursor) result.push([cursor, Math.min(start, closeAt)]);
    cursor = Math.max(cursor, end);
    if (cursor >= closeAt) break;
  }
  if (cursor < closeAt) result.push([cursor, closeAt]);
  return result.filter(([a, b]) => a < b);
}

export function branchHours(branch: Json): Interval[] {
  const morning: Interval = [
    Number(branch.morningStartWorkingTime) * 60,
    Number(branch.morningEndWorkingTime) * 60,
  ];
  const afternoon: Interval = [
    Number(branch.afternoonStartWorkingTime) * 60,
    Number(branch.afternoonEndWorkingTime) * 60,
  ];
  return [morning, afternoon].filter((part) => part[0] < part[1]);
}

export function monthlySpans(days: string[]): [string, string, string][] {
  const byMonth = new Map<string, string[]>();
  for (const day of days) {
    const month = day.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), day]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, group]) => [
      month,
      [...group].sort()[0],
      [...group].sort()[group.length - 1],
    ]);
}

export function formatTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

type PriceRule = {
  opening: number;
  closing: number;
  weekdays: [number, number];
  index: number;
  rule: Json;
};

function parseClock(text: string): number | null {
  const [hour, minute, extra] = text.split(":");
  if (
    extra !== undefined ||
    !/^\d+$/.test(hour ?? "") ||
    !/^\d+$/.test(minute ?? "")
  )
    return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h < 0 || h > 24 || m < 0 || m >= 60) return null;
  return h * 60 + m;
}

export function slotTotalPrice(
  priceTypes: unknown,
  day: string,
  start: number,
  end: number,
): number | null {
  if (
    !Array.isArray(priceTypes) ||
    priceTypes.length !== 1 ||
    end <= start ||
    (end - start) % SLOT_STEP_MINUTES
  ) {
    return null;
  }
  const pricing = priceTypes[0];
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing))
    return null;
  const record = pricing as Json;
  const special = record.specialPrice || [];
  if (record.unit !== "h" || !Array.isArray(special)) return null;
  const rules: PriceRule[] = [];
  for (const [index, raw] of special.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return null;
    const rule = raw as Json;
    if (Object.keys(rule).some((key) => !PRICE_RULE_FIELDS.has(key)))
      return null;
    if (typeof rule.time !== "string") return null;
    const parts = rule.time.split("-");
    if (parts.length !== 2) return null;
    const opening = parseClock(parts[0]);
    const closing = parseClock(parts[1]);
    if (opening === null || closing === null) return null;
    let weekdays: number[] = [1, 7];
    if (rule.dateRangeWeek) {
      if (typeof rule.dateRangeWeek !== "string") return null;
      const bounds = rule.dateRangeWeek.split("-");
      if (bounds.some((bound) => !/^\d+$/.test(bound))) return null;
      weekdays = bounds.map(Number);
    }
    if (
      rule.unit !== "h" ||
      !(opening >= 0 && opening < closing && closing <= MINUTES_PER_DAY) ||
      weekdays.length !== 2 ||
      !(weekdays[0] >= 1 && weekdays[0] <= weekdays[1] && weekdays[1] <= 7)
    ) {
      return null;
    }
    rules.push({
      opening,
      closing,
      weekdays: [weekdays[0], weekdays[1]],
      index,
      rule,
    });
  }
  const isoWeekday = weekday(day) + 1;
  let total = 0;
  for (let minute = start; minute < end; minute += SLOT_STEP_MINUTES) {
    const applicable = rules.filter(
      (item) =>
        item.opening <= minute &&
        minute + SLOT_STEP_MINUTES <= item.closing &&
        item.weekdays[0] <= isoWeekday &&
        isoWeekday <= item.weekdays[1] &&
        Number(item.rule.minDuration ?? 0) <= end - start,
    );
    const rank = (item: PriceRule): [number, number, number] => [
      item.weekdays[0] === 1 && item.weekdays[1] === 7 ? 0 : 1,
      item.opening,
      item.index,
    ];
    const best = applicable.reduce<PriceRule | null>((chosen, item) => {
      if (!chosen) return item;
      const [a, b] = [rank(item), rank(chosen)];
      const diff = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      return diff > 0 ? item : chosen;
    }, null);
    const selected = best ? best.rule : record;
    const rate = selected[best ? "priceOneTime" : "normalPriceOneTime"];
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0)
      return null;
    total += rate * SLOT_STEP_MINUTES;
  }
  return total % 60 === 0 ? total / 60 : null;
}

export function mapUrl(branch: Json): string {
  const location = asRecord(branch.location);
  const lat = location._latitude;
  const lng = location._longitude;
  let destination: string;
  if (
    typeof lat === "number" &&
    typeof lng === "number" &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  ) {
    destination = `${lat},${lng}`;
  } else if (branch.address) {
    destination = `${branch.name}, ${branch.address}`;
  } else {
    return "";
  }
  const query = new URLSearchParams({ api: "1", destination })
    .toString()
    .replace(/%7E/g, "~")
    .replace(/\*/g, "%2A");
  return `https://www.google.com/maps/dir/?${query}`;
}

export type RouteDeps = {
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  nowMs: number;
};

export async function roadDistance(
  branch: Json,
  area: Area,
  origins: Origins,
  routes: RouteCache,
  deps: RouteDeps,
): Promise<number | null> {
  const location = asRecord(branch.location);
  const lat = location._latitude;
  const lng = location._longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const point = origins[area];
  if (!point) return null;
  const key = `(${point.latitude}, ${point.longitude}):${lat},${lng}`;
  try {
    const entry = routes[key];
    if (entry && deps.nowMs - entry.at < ROUTE_TTL_MS) return entry.meters;
    await deps.sleep(ROUTE_PAUSE_MS);
    const result = asRecord(
      await deps.fetchJson(
        `${ROUTE_URL}${point.longitude},${point.latitude};${lng},${lat}?overview=false&steps=false`,
        { "User-Agent": ROUTE_USER_AGENT },
      ),
    );
    const found = result.routes as Json[] | undefined;
    if (result.code !== "Ok" || !found?.length) return null;
    const meters = found[0].distance;
    if (typeof meters !== "number" || meters < 0) return null;
    routes[key] = { at: deps.nowMs, meters };
    return meters;
  } catch {
    return null;
  }
}

export type CourtGroup = {
  branch_name: string;
  court_name: string;
  url: string;
  map_url: string;
  distance_m: number | null;
  matches: Match[];
  match_count: number;
};

export function groupCourts(matches: Match[]): CourtGroup[] {
  const groups = new Map<string, CourtGroup>();
  for (const item of matches) {
    const key = JSON.stringify([item.branch_id, item.court_id]);
    let group = groups.get(key);
    if (!group) {
      group = {
        branch_name: item.branch_name,
        court_name: item.court_name,
        url: item.url,
        map_url: item.map_url ?? "",
        distance_m: item.distance_m ?? null,
        matches: [],
        match_count: 0,
      };
      groups.set(key, group);
    }
    group.matches.push(item);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    match_count: group.matches.length,
  }));
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export async function scanVenue(
  api: Api,
  area: Area,
  branchId: string,
  now: Date,
  origins: Origins,
  routes: RouteCache,
  deps: RouteDeps,
): Promise<VenueScan> {
  const horizon = searchDates(now);
  const days = horizon.filter((day) => area !== "quan-2" || weekday(day) < 5);
  const branch = asRecord(
    await api.request(`branch/get_branch/${enc(branchId)}`),
  );
  if (branch.districtId !== DISTRICTS[area] || branch.status !== 1) return null;
  const venue: ScannedVenue = {
    id: branchId,
    name: String(branch.name),
    url: `https://datlich.alobo.vn/san/${enc(branchId)}`,
  };
  const distance = await roadDistance(branch, area, origins, routes, deps);
  const cores =
    (asRecord(await api.request(`branch/get_cores/${enc(branchId)}`))
      .cores as Json[]) ?? [];
  let priceTypes: unknown = null;
  try {
    priceTypes = await api.request(`branch/get_core_types/${enc(branchId)}`);
  } catch {
    priceTypes = null;
  }
  const locks = (await api.request(
    `branch/get_lock_yards/${enc(branchId)}`,
  )) as Json[];
  const bookingsByDay = new Map<string, Json[]>();
  for (const [month, first, last] of monthlySpans(days)) {
    const recurring = (await api.request("branch/get_schedule_bookings", {
      branchId,
      month,
    })) as unknown[];
    if (recurring && (!Array.isArray(recurring) || recurring.length > 0)) {
      throw new Error("Alobo recurring booking shape needs verification");
    }
    const booked = (await api.request("branch/get_onetime_bookings", {
      branchId,
      startDate: first,
      endDate: last,
    })) as Json[];
    for (const booking of booked) {
      const bookingDays = new Set(
        ((booking.services as Json[] | undefined) ?? []).map(
          (service) => minuteOf(String(service.startTime)).day,
        ),
      );
      for (const bookingDay of bookingDays) {
        bookingsByDay.set(bookingDay, [
          ...(bookingsByDay.get(bookingDay) ?? []),
          booking,
        ]);
      }
    }
  }
  const matches: Match[] = [];
  for (const day of days) {
    for (const core of cores) {
      if (core.status !== 1) continue;
      const occupied = occupancy(
        bookingsByDay.get(day) ?? [],
        locks,
        String(core.id),
        day,
      );
      const available: Interval[] = [];
      for (const [start, end] of branchHours(branch))
        available.push(...freeIntervals(start, end, occupied));
      const options = windows(area, day, available, now);
      if (options.length === 0) continue;
      let start: number;
      let end: number;
      if (area !== "quan-2") {
        const candidates: number[] = [];
        for (const [from, to] of options) {
          for (
            let slot = Math.floor((from + 14) / 15) * 15;
            slot < to - 119;
            slot += 15
          )
            candidates.push(slot);
        }
        if (candidates.length === 0) continue;
        start = candidates[0];
        end = start + TWO_HOURS;
      } else {
        [start, end] = options[0];
      }
      const [year, month, date] = day.split("-");
      matches.push({
        branch_name: venue.name,
        court_name: String(core.name),
        map_url: mapUrl(branch),
        distance_m: distance,
        date_label: `${date}/${month}/${year}`,
        time_label: `${formatTime(start)}–${formatTime(end)}`,
        url: ALOBO_HOME,
        branch_id: branchId,
        court_id: String(core.id),
        date: day,
        start,
        end,
        total_price: slotTotalPrice(priceTypes, day, start, end),
      });
    }
  }
  return { venue, matches };
}

function isoLocal(now: Date): string {
  const shifted = new Date(now.getTime() + VN_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 19)}+07:00`;
}

export type AreaDocument = {
  status: "ok";
  criteria: string;
  message: string;
  updated_at: string;
  from_date: string;
  through_date: string;
  venues_scanned: number;
  scanned_venues: ScannedVenue[];
  match_count: number;
  matches: Match[];
  court_groups: CourtGroup[];
  origin_name: string;
};

export function assembleArea(
  area: Area,
  now: Date,
  scans: VenueScan[],
  origins: Origins,
): AreaDocument {
  const horizon = searchDates(now);
  const scanned = scans.filter(
    (item): item is NonNullable<VenueScan> => item !== null,
  );
  if (scanned.length === 0)
    throw new Error("No favorite venue found in the requested area");
  let matches = scanned.flatMap((item) => item.matches);
  if (area === "quan-2") {
    const twoHourDays = new Set(
      matches
        .filter((item) => item.end - item.start === TWO_HOURS)
        .map((item) => item.date),
    );
    matches = matches.filter(
      (item) =>
        !twoHourDays.has(item.date) || item.end - item.start === TWO_HOURS,
    );
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  matches.sort(
    (a, b) =>
      compare(a.date, b.date) ||
      a.start - b.start ||
      compare(a.branch_name, b.branch_name) ||
      compare(a.court_name, b.court_name),
  );
  return {
    status: "ok",
    criteria: CRITERIA[area],
    message: `Đã quét ${scanned.length} sân yêu thích.`,
    updated_at: isoLocal(now),
    from_date: horizon[0],
    through_date: horizon[horizon.length - 1],
    venues_scanned: scanned.length,
    scanned_venues: scanned.map((item) => item.venue),
    match_count: matches.length,
    matches,
    court_groups: groupCourts(matches),
    origin_name: origins[area]?.name ?? "Tân Phú",
  };
}
