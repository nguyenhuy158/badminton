import { describe, expect, it } from "vitest";
import type { Area } from "./rules";
import {
  type Api,
  assembleArea,
  groupCourts,
  type Match,
  type Origins,
  type RouteCache,
  type RouteDeps,
  roadDistance,
  scanVenue,
  slotTotalPrice,
} from "./scan";
import fixtures from "./scan.fixtures.json";

const origins: Origins = {
  "quan-2": { name: "company", latitude: 10.7965557, longitude: 106.7432268 },
  "tan-binh": { name: "home", latitude: 10.804519, longitude: 106.647551 },
};

function fakeAlobo(district = "769"): Api {
  return {
    async request(route, query) {
      if (route === "branch/get_branch/venue") {
        return {
          districtId: district,
          status: 1,
          name: "Sân thử",
          morningStartWorkingTime: 5,
          morningEndWorkingTime: 12,
          afternoonStartWorkingTime: 12,
          afternoonEndWorkingTime: 23,
        };
      }
      if (route === "branch/get_cores/venue")
        return { cores: [{ id: "court", name: "Sân 1", status: 1 }] };
      if (route === "branch/get_core_types/venue") {
        return [{ unit: "h", normalPriceOneTime: 50000, specialPrice: [] }];
      }
      if (route === "branch/get_lock_yards/venue") return [];
      if (route === "branch/get_schedule_bookings") return [];
      if (route === "branch/get_onetime_bookings") {
        return query?.startDate.startsWith("2026-10")
          ? [
              {
                status: 1,
                services: [
                  {
                    serviceId: "court",
                    startTime: "2026-10-28T08:00:00.000",
                    duration: 60,
                  },
                  {
                    serviceId: "court",
                    startTime: "2026-10-29T18:00:00.000",
                    duration: 120,
                  },
                ],
              },
            ]
          : [];
      }
      throw new Error(`unexpected route ${route}`);
    },
  };
}

const offline: RouteDeps = {
  fetchJson: async () => {
    throw new Error("offline");
  },
  sleep: async () => {},
  nowMs: 0,
};

async function scanArea(area: Area, district: string, now: Date) {
  const scan = await scanVenue(
    fakeAlobo(district),
    area,
    "venue",
    now,
    origins,
    {},
    { ...offline, nowMs: now.getTime() },
  );
  return assembleArea(area, now, [scan], origins);
}

describe("group_courts", () => {
  it("keeps same-named courts in different venues apart", () => {
    const common = {
      branch_name: "CLB",
      court_name: "Sân 1",
      court_id: "1",
      url: "https://datlich.alobo.vn/",
    };
    const matches = [
      { ...common, branch_id: "a", date: "2026-10-30" },
      { ...common, branch_id: "b", date: "2026-10-30" },
      { ...common, branch_id: "a", date: "2026-11-02" },
    ] as unknown as Match[];
    const groups = groupCourts(matches);
    expect(groups.map((group) => group.match_count)).toEqual([2, 1]);
    expect(groups[0].matches).toEqual([matches[0], matches[2]]);
    expect(groups[1].matches).toEqual([matches[1]]);
  });
});

describe("roadDistance", () => {
  const point = {
    "quan-2": { name: "company", latitude: 10.0, longitude: 106.0 },
  } as Origins;
  const branch = { location: { _latitude: 10.1, _longitude: 106.1 } };

  it("reuses a fresh route", async () => {
    const routes: RouteCache = {
      "(10, 106):10.1,106.1": { at: 1000, meters: 4200 },
    };
    const deps = { ...offline, nowMs: 2000 };
    expect(await roadDistance(branch, "quan-2", point, routes, deps)).toBe(
      4200,
    );
  });

  it("fetches and records a new route", async () => {
    const routes: RouteCache = {};
    const urls: string[] = [];
    const deps: RouteDeps = {
      fetchJson: async (url) => {
        urls.push(url);
        return { code: "Ok", routes: [{ distance: 900 }] };
      },
      sleep: async () => {},
      nowMs: 5000,
    };
    expect(await roadDistance(branch, "quan-2", point, routes, deps)).toBe(900);
    expect(routes["(10, 106):10.1,106.1"]).toEqual({ at: 5000, meters: 900 });
    expect(urls[0]).toContain("106,10;106.1,10.1");
  });

  it("returns null when routing fails or the venue has no location", async () => {
    expect(await roadDistance(branch, "quan-2", point, {}, offline)).toBeNull();
    expect(await roadDistance({}, "quan-2", point, {}, offline)).toBeNull();
    expect(
      await roadDistance(branch, "tan-phu", point, {}, offline),
    ).toBeNull();
  });
});

describe("scan", () => {
  it("blocks every date of a group booking", async () => {
    const result = await scanArea(
      "quan-2",
      "769",
      new Date("2026-10-28T15:00:00+07:00"),
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.scanned_venues).toEqual([
      {
        id: "venue",
        name: "Sân thử",
        url: "https://datlich.alobo.vn/san/venue",
      },
    ]);
    expect(result.matches.some((item) => item.date === "2026-10-29")).toBe(
      false,
    );
  });

  it("uses the evening rules for tan-phu", async () => {
    const result = await scanArea(
      "tan-phu",
      "767",
      new Date("2026-10-28T15:00:00+07:00"),
    );
    expect(result.venues_scanned).toBe(1);
    expect(result.origin_name).toBe("Tân Phú");
    expect(result.matches.every((item) => item.end - item.start === 120)).toBe(
      true,
    );
  });
});

describe("slotTotalPrice", () => {
  const pricing = [
    {
      unit: "h",
      normalPriceOneTime: 50000,
      specialPrice: [
        { unit: "h", time: "16:00-18:00", priceOneTime: 90000 },
        { unit: "h", time: "18:00-24:00", priceOneTime: 120000 },
        {
          unit: "h",
          time: "5:00-24:00",
          dateRangeWeek: "6-7",
          priceOneTime: 110000,
        },
      ],
    },
  ];

  it("splits hourly tiers and applies the weekend override", () => {
    expect(slotTotalPrice(pricing, "2026-11-09", 1020, 1140)).toBe(210000);
    expect(slotTotalPrice(pricing, "2026-11-08", 1140, 1260)).toBe(220000);
    expect(
      slotTotalPrice(
        [{ ...pricing[0], specialPrice: [] }],
        "2026-11-09",
        1140,
        1260,
      ),
    ).toBe(100000);
    expect(
      slotTotalPrice(
        [{ ...pricing[0], normalPriceOneTime: 0, specialPrice: [] }],
        "2026-11-09",
        1140,
        1260,
      ),
    ).toBeNull();
  });
});

describe("scan concurrency", () => {
  it("starts the requests after get_branch together", async () => {
    const inner = fakeAlobo("769");
    let inFlight = 0;
    let peak = 0;
    const api: Api = {
      async request(route, query) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await inner.request(route, query);
        } finally {
          inFlight--;
        }
      },
    };
    const now = new Date("2026-10-28T15:00:00+07:00");
    const scan = await scanVenue(
      api,
      "quan-2",
      "venue",
      now,
      origins,
      {},
      {
        ...offline,
        nowMs: now.getTime(),
      },
    );
    expect(scan).not.toBeNull();
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  it("still fails when one parallel request fails", async () => {
    const inner = fakeAlobo("769");
    const api: Api = {
      async request(route, query) {
        if (route === "branch/get_lock_yards/venue")
          throw new Error("locks down");
        return inner.request(route, query);
      },
    };
    const now = new Date("2026-10-28T15:00:00+07:00");
    await expect(
      scanVenue(
        api,
        "quan-2",
        "venue",
        now,
        origins,
        {},
        {
          ...offline,
          nowMs: now.getTime(),
        },
      ),
    ).rejects.toThrow("locks down");
  });

  it("ignores a failing get_core_types like before", async () => {
    const inner = fakeAlobo("769");
    const api: Api = {
      async request(route, query) {
        if (route === "branch/get_core_types/venue")
          throw new Error("no prices");
        return inner.request(route, query);
      },
    };
    const now = new Date("2026-10-28T15:00:00+07:00");
    const scan = await scanVenue(
      api,
      "quan-2",
      "venue",
      now,
      origins,
      {},
      {
        ...offline,
        nowMs: now.getTime(),
      },
    );
    expect(scan?.matches.length).toBeGreaterThan(0);
  });
});

describe("matches the Python watcher", () => {
  it("returns the same document for every recorded scan", async () => {
    for (const item of fixtures.scans) {
      const now = new Date(item.now);
      const area = item.area as Area;
      if ("error" in item.result) {
        await expect(scanArea(area, item.district, now)).rejects.toThrow(
          String(item.result.error),
        );
      } else {
        expect(
          await scanArea(area, item.district, now),
          `${area} ${item.now}`,
        ).toEqual(item.result);
      }
    }
  });

  it("returns the same price for every recorded case", () => {
    for (const item of fixtures.prices) {
      const actual = slotTotalPrice(
        item.pricing,
        item.day,
        item.start,
        item.end,
      );
      expect(actual, JSON.stringify(item)).toBe(item.expected);
    }
  });
});
