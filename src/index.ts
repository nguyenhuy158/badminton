import { getClaimsFromRequest, ssoUrl } from "@huyab/sso";
import { BUILD_INFO } from "./build-info";

type Env = {
  ASSETS: Fetcher;
  DATA: KVNamespace;
  SSO_ISSUER: string;
};

const DATA_PATH = /^\/data\/([a-z0-9-]+)\.json$/;
const DATA_KEY_PREFIX = "data:";

const VERSION_PATH = "/api/version";
const HEALTH_PATH = "/api/health";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === VERSION_PATH)
      return Response.json(BUILD_INFO);
    if (request.method === "GET" && pathname === HEALTH_PATH)
      return Response.json({ ok: true });
    const claims = await getClaimsFromRequest(request, env.SSO_ISSUER);
    if (!claims)
      return Response.redirect(
        ssoUrl(env.SSO_ISSUER, "/login", request.url),
        302,
      );
    const dataName =
      request.method === "GET" ? DATA_PATH.exec(pathname)?.[1] : undefined;
    if (dataName) {
      const body = await env.DATA.get(`${DATA_KEY_PREFIX}${dataName}`);
      if (body === null) return new Response("Not found", { status: 404 });
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, no-store",
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
