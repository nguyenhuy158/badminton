import { getClaimsFromRequest } from "@huyab/sso";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

vi.mock("@huyab/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@huyab/sso")>()),
  getClaimsFromRequest: vi.fn(async () => null),
}));

const signedIn = vi.mocked(getClaimsFromRequest);

const store = new Map<string, string>([
  ["data:demo-group", '{"group":"Demo"}'],
]);

const env = {
  ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  DATA: {
    get: async (key: string) => store.get(key) ?? null,
  } as unknown as KVNamespace,
  SSO_ISSUER: "https://auth.example.test",
};

describe("worker", () => {
  it("serves the build info without a session", async () => {
    const response = await worker.fetch(
      new Request("https://badminton.test/api/version"),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commit: string };
    expect(body.commit.length).toBeGreaterThan(0);
  });

  it("answers health without a session", async () => {
    const response = await worker.fetch(
      new Request("https://badminton.test/api/health"),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sends everything else to the SSO login", async () => {
    const response = await worker.fetch(
      new Request("https://badminton.test/"),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://auth.example.test/login",
    );
  });

  it("does not answer the two routes for other methods", async () => {
    const response = await worker.fetch(
      new Request("https://badminton.test/api/version", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(302);
  });

  describe("private data", () => {
    beforeEach(() => signedIn.mockReset());

    it("sends an anonymous visitor to the SSO login", async () => {
      signedIn.mockResolvedValue(null);
      const response = await worker.fetch(
        new Request("https://badminton.test/data/demo-group.json"),
        env,
      );
      expect(response.status).toBe(302);
    });

    it("serves a stored document to a signed-in user without caching it", async () => {
      signedIn.mockResolvedValue({ sub: "1" } as never);
      const response = await worker.fetch(
        new Request("https://badminton.test/data/demo-group.json"),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ group: "Demo" });
    });

    it("answers 404 for a name that is not stored", async () => {
      signedIn.mockResolvedValue({ sub: "1" } as never);
      const response = await worker.fetch(
        new Request("https://badminton.test/data/unknown.json"),
        env,
      );
      expect(response.status).toBe(404);
    });

    it("never reads the store for names with a path or odd characters", async () => {
      signedIn.mockResolvedValue({ sub: "1" } as never);
      const get = vi.fn(async () => "x");
      const probe = { ...env, DATA: { get } as unknown as KVNamespace };
      for (const path of [
        "/data/../secret.json",
        "/data/a%2Fb.json",
        "/data/UPPER.json",
      ]) {
        await worker.fetch(new Request(`https://badminton.test${path}`), probe);
      }
      expect(get).not.toHaveBeenCalled();
    });
  });
});
