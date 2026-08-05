/**
 * whistler-rentals — Worker entry point.
 *
 * Binding names are identical across dev and prod, so nothing in here
 * branches on environment. env.DB is whichever database the deployed
 * environment points at.
 */

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  LANDLORDS: KVNamespace;
  RATELIMIT: KVNamespace;
  ENVIRONMENT: string;
  // VECTORIZE: VectorizeIndex;   // uncomment alongside wrangler.toml
  // FB_APP_SECRET: string;       // set via `wrangler secret put`
}

const RATE_LIMIT_MAX = 60; // requests
const RATE_LIMIT_WINDOW = 60; // seconds

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, environment: env.ENVIRONMENT });
      }

      const limited = await checkRateLimit(request, env, ctx);
      if (limited) {
        return json({ error: "Too many requests" }, 429, {
          "Retry-After": String(RATE_LIMIT_WINDOW),
        });
      }

      if (url.pathname === "/api/listings" && request.method === "GET") {
        return await listListings(env, url);
      }

      if (url.pathname.startsWith("/api/landlords/") && request.method === "GET") {
        const id = url.pathname.split("/")[3];
        return await getLandlord(env, id);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Unhandled error", err);
      return json({ error: "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/* -------------------------------------------------------------------------
 * Handlers
 * ---------------------------------------------------------------------- */

async function listListings(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.title, l.neighbourhood, l.rent_cents, l.bedrooms,
            l.available_from, l.created_at, ld.display_name AS landlord_name
       FROM listings l
       JOIN landlords ld ON ld.id = l.landlord_id
      WHERE l.status = 'active'
      ORDER BY l.created_at DESC
      LIMIT ?1 OFFSET ?2`
  )
    .bind(limit, offset)
    .all();

  return json({ listings: results, limit, offset });
}

/**
 * Verified-landlord lookups are read-heavy and change rarely, so they are
 * cached in KV with the database as the source of truth.
 */
async function getLandlord(env: Env, id: string): Promise<Response> {
  if (!id) return json({ error: "Missing landlord id" }, 400);

  const cached = await env.LANDLORDS.get(`landlord:${id}`, "json");
  if (cached) return json({ landlord: cached, cached: true });

  const row = await env.DB.prepare(
    `SELECT id, display_name, verified, verified_at
       FROM landlords WHERE id = ?1`
  )
    .bind(id)
    .first();

  if (!row) return json({ error: "Not found" }, 404);

  await env.LANDLORDS.put(`landlord:${id}`, JSON.stringify(row), {
    expirationTtl: 3600,
  });

  return json({ landlord: row, cached: false });
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/**
 * KV-backed rate limiting. KV is eventually consistent, so a client hitting
 * multiple colos can overshoot the limit before counts propagate. Fine for
 * casual abuse; use Durable Objects if you need hard guarantees.
 */
async function checkRateLimit(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const window = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
  const key = `rl:${ip}:${window}`;

  const current = Number((await env.RATELIMIT.get(key)) ?? 0);
  if (current >= RATE_LIMIT_MAX) return true;

  ctx.waitUntil(
    env.RATELIMIT.put(key, String(current + 1), {
      expirationTtl: RATE_LIMIT_WINDOW * 2,
    })
  );

  return false;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
