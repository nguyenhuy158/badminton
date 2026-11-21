import { describe, expect, it } from "vitest";
import {
  type Area,
  afternoonWindows,
  type Interval,
  searchDates,
  windows,
} from "./rules";
import fixtures from "./rules.fixtures.json";

const now = new Date("2026-10-28T12:00:00+07:00");

describe("searchDates", () => {
  it("covers this week and the next two calendar weeks", () => {
    const days = searchDates(now);
    expect(days[0]).toBe("2026-10-28");
    expect(days[days.length - 1]).toBe("2026-11-15");
    expect(days).toHaveLength(19);
  });

  it("uses the Ho Chi Minh date and ends on a Sunday", () => {
    const days = searchDates(new Date("2026-11-01T18:00:00Z"));
    expect(days[0]).toBe("2026-11-02");
    expect(days[days.length - 1]).toBe("2026-11-22");
  });
});

describe("windows", () => {
  it("prefers two hours for quan-2 and skips weekends", () => {
    expect(
      windows(
        "quan-2",
        "2026-10-28",
        [
          [1080, 1140],
          [1140, 1200],
        ],
        now,
      ),
    ).toEqual([[1080, 1200]]);
    expect(windows("quan-2", "2026-10-28", [[1080, 1140]], now)).toEqual([
      [1080, 1140],
    ]);
    expect(windows("quan-2", "2026-10-31", [[1080, 1200]], now)).toEqual([]);
  });

  it("does not join gaps into two hours", () => {
    expect(
      windows(
        "tan-binh",
        "2026-10-28",
        [
          [1140, 1200],
          [1230, 1290],
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("returns continuous ranges for tan-binh and tan-phu", () => {
    expect(windows("tan-binh", "2026-10-31", [[1200, 1440]], now)).toEqual([
      [1200, 1380],
    ]);
    expect(windows("tan-phu", "2026-10-31", [[1200, 1440]], now)).toEqual([
      [1200, 1380],
    ]);
  });

  it("drops past starts and days outside the horizon", () => {
    const evening = new Date("2026-10-28T19:00:00+07:00");
    expect(windows("quan-2", "2026-10-28", [[1080, 1200]], evening)).toEqual(
      [],
    );
    expect(windows("tan-binh", "2026-11-16", [[1140, 1380]], evening)).toEqual(
      [],
    );
  });

  it("keeps only future starts tonight", () => {
    const late = new Date("2026-10-28T20:15:00+07:00");
    expect(windows("tan-binh", "2026-10-28", [[1140, 1380]], late)).toEqual([
      [1216, 1380],
    ]);
    expect(windows("tan-binh", "2026-10-28", [[1140, 1320]], late)).toEqual([]);
  });

  it("rejects bad input", () => {
    expect(() => windows("tan-binh", "2026-10-29", [[600, 600]], now)).toThrow(
      "Invalid availability interval",
    );
    expect(() => windows("tan-binh", "2026-10-29", [[0, 1500]], now)).toThrow(
      "Invalid availability interval",
    );
    expect(() =>
      windows("nowhere" as Area, "2026-10-29", [[600, 900]], now),
    ).toThrow("Unknown area");
  });
});

describe("matches the Python watcher", () => {
  it("returns the same dates", () => {
    for (const entry of fixtures.dates) {
      expect(searchDates(new Date(entry.now))).toEqual(entry.dates);
    }
  });

  it("returns the same windows for every recorded case", () => {
    for (const item of fixtures.cases) {
      const actual = windows(
        item.area as Area,
        item.day,
        item.intervals as unknown as Interval[],
        new Date(item.now),
      );
      expect(actual, JSON.stringify(item)).toEqual(item.expected);
    }
  });

  it("returns the same afternoon windows for every recorded case", () => {
    for (const item of fixtures.afternoon) {
      const actual = afternoonWindows(
        item.day,
        item.intervals as unknown as Interval[],
        new Date(item.now),
      );
      expect(actual, JSON.stringify(item)).toEqual(item.expected);
    }
  });
});
