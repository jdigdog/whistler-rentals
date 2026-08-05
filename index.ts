/**
 * whistler-rentals — Worker entry point.
 *
 * Public:  GET  /api/listings          browse approved listings (filterable)
 *          GET  /api/listings/:id      single listing
 *          POST /api/listings          submit a listing (lands in 'pending')
 *          GET  /api/landlords/:id     public landlord card
 *
 * Admin (requires ADMIN_TOKEN bearer header — a stopgap until real auth):
 *          GET   /api/admin/queue      pending listings, riskiest first
 *          POST  /api/admin/listings/:id/review   { decision, note }
 */

import {
  validateListing,
  runLocalChecks,
  scoreFlags,
  type ListingInput,
  type RiskFlag,
} from "./listings";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  LANDLORDS: KVNamespace;
  RATELIMIT: KVNamespace;
  ENVIRONMENT: string;
  ADMIN_TOKEN: string; // wrangler secret put ADMIN_TOKEN
  // AI: Ai;            // add [ai] binding = "AI" to wrangler.toml
}

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60;
const SUBMIT_LIMIT_MAX = 5; // stricter budget for writes
const SUBMIT_LIMIT_WINDOW = 3600;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (path === "/health") {
        return cors(json({ ok: true, environment: env.ENVIRONMENT }));
      }

      if (await isRateLimited(request, env, ctx, "rl", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)) {
        return cors(json({ error: "Too many requests" }, 429, {
          "Retry-After": String(RATE_LIMIT_WINDOW),
        }));
      }

      // --- public -------------------------------------------------------
      if (path === "/api/listings" && request.method === "GET") {
        return cors(await browseListings(env, url));
      }

      if (path === "/api/listings" && request.method === "POST") {
        return cors(await submitListing(request, env, ctx));
      }

      const listingMatch = path.match(/^\/api\/listings\/([\w-]+)$/);
      if (listingMatch && request.method === "GET") {
        return cors(await getListing(env, listingMatch[1]));
      }

      const landlordMatch = path.match(/^\/api\/landlords\/([\w-]+)$/);
      if (landlordMatch && request.method === "GET") {
        return cors(await getLandlord(env, landlordMatch[1]));
      }

      // --- admin --------------------------------------------------------
      if (path.startsWith("/api/admin/")) {
        if (!isAdmin(request, env)) return cors(json({ error: "Unauthorized" }, 401));

        if (path === "/api/admin/queue" && request.method === "GET") {
          return cors(await reviewQueue(env, url));
        }

        const reviewMatch = path.match(/^\/api\/admin\/listings\/([\w-]+)\/review$/);
        if (reviewMatch && request.method === "POST") {
          return cors(await reviewListing(request, env, reviewMatch[1]));
        }
      }

      return cors(json({ error: "Not found" }, 404));
    } catch (err) {
      console.error("Unhandled error", err);
      return cors(json({ error: "Internal error" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

/* -------------------------------------------------------------------------
 * Public handlers
 * ---------------------------------------------------------------------- */

async function browseListings(env: Env, url: URL): Promise<Response> {
  const p = url.searchParams;
  const limit = clamp(Number(p.get("limit") ?? 25), 1, 100);
  const offset = clamp(Number(p.get("offset") ?? 0), 0, 10_000);

  const where: string[] = ["l.status = 'active'", "l.moderation_status = 'approved'"];
  const binds: unknown[] = [];

  if (p.get("neighbourhood")) {
    binds.push(p.get("neighbourhood"));
    where.push(`l.neighbourhood = ?${binds.length}`);
  }
  if (p.get("max_rent")) {
    binds.push(Number(p.get("max_rent")) * 100); // query in dollars, store cents
    where.push(`l.rent_cents <= ?${binds.length}`);
  }
  if (p.get("min_bedrooms")) {
    binds.push(Number(p.get("min_bedrooms")));
    where.push(`l.bedrooms >= ?${binds.length}`);
  }
  if (p.get("furnished") === "true") {
    where.push(`l.furnished = 1`);
  }
  if (p.get("verified_only") === "true") {
    where.push(`ld.verification_status = 'verified'`);
  }

  binds.push(limit, offset);

  const sql = `
    SELECT l.id, l.title, l.neighbourhood, l.rent_cents, l.bedrooms, l.furnished,
           l.available_from, l.created_at,
           ld.id AS landlord_id, ld.display_name AS landlord_name,
           ld.verification_status
      FROM listings l
      JOIN landlords ld ON ld.id = l.landlord_id
     WHERE ${where.join(" AND ")}
     ORDER BY l.created_at DESC
     LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ listings: results, limit, offset, count: results.length });
}

async function getListing(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT l.id, l.title, l.description, l.neighbourhood, l.rent_cents, l.bedrooms,
            l.furnished, l.available_from, l.created_at,
            ld.id AS landlord_id, ld.display_name AS landlord_name,
            ld.verification_status
       FROM listings l
       JOIN landlords ld ON ld.id = l.landlord_id
      WHERE l.id = ?1 AND l.status = 'active' AND l.moderation_status = 'approved'`
  ).bind(id).first();

  if (!row) return json({ error: "Not found" }, 404);
  return json({ listing: row });
}

async function submitListing(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Writes get a much tighter budget than reads.
  if (await isRateLimited(request, env, ctx, "sub", SUBMIT_LIMIT_MAX, SUBMIT_LIMIT_WINDOW)) {
    return json({ error: "Submission limit reached, try again later" }, 429);
  }

  let body: Partial<ListingInput>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be valid JSON" }, 400);
  }

  const errors = validateListing(body);
  if (errors.length) return json({ error: "Validation failed", errors }, 400);

  const input = body as ListingInput;

  // The landlord must already exist. Creating landlords is part of the
  // signup flow, which is deliberately not built yet.
  const landlord = await env.DB.prepare(
    `SELECT id FROM landlords WHERE id = ?1`
  ).bind(input.landlord_id).first();
  if (!landlord) return json({ error: "Unknown landlord_id" }, 400);

  const flags: RiskFlag[] = await runLocalChecks(input, env.DB);
  const score = scoreFlags(flags);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO listings
       (id, landlord_id, title, description, neighbourhood, rent_cents, bedrooms,
        furnished, available_from, contact_email, status, moderation_status,
        risk_score, risk_flags, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'active','pending',?11,?12,datetime('now'))`
  ).bind(
    id,
    input.landlord_id,
    input.title.trim(),
    input.description?.trim() ?? null,
    input.neighbourhood ?? null,
    input.rent_cents,
    input.bedrooms ?? null,
    input.furnished ? 1 : 0,
    input.available_from ?? null,
    input.contact_email ?? null,
    score,
    flags.length ? JSON.stringify(flags) : null
  ).run();

  if (flags.length) {
    ctx.waitUntil(
      logModeration(env, "listing", id, "auto:local_checks", "flagged", { score, flags })
    );
  }

  // Deliberately does not echo the flags — a submitter learning which
  // phrases trip the checks is a submitter learning to evade them.
  return json(
    { id, status: "pending", message: "Listing submitted for review" },
    201
  );
}

async function getLandlord(env: Env, id: string): Promise<Response> {
  const cached = await env.LANDLORDS.get(`landlord:${id}`, "json");
  if (cached) return json({ landlord: cached, cached: true });

  const row = await env.DB.prepare(
    `SELECT id, display_name, verification_status, verified_at
       FROM landlords WHERE id = ?1`
  ).bind(id).first();

  if (!row) return json({ error: "Not found" }, 404);

  await env.LANDLORDS.put(`landlord:${id}`, JSON.stringify(row), { expirationTtl: 3600 });
  return json({ landlord: row, cached: false });
}

/* -------------------------------------------------------------------------
 * Admin handlers
 * ---------------------------------------------------------------------- */

async function reviewQueue(env: Env, url: URL): Promise<Response> {
  const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 100);

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.title, l.neighbourhood, l.rent_cents, l.bedrooms, l.created_at,
            l.risk_score, l.risk_flags, l.contact_email,
            ld.display_name AS landlord_name, ld.verification_status
       FROM listings l
       JOIN landlords ld ON ld.id = l.landlord_id
      WHERE l.moderation_status = 'pending'
      ORDER BY COALESCE(l.risk_score, 0) DESC, l.created_at ASC
      LIMIT ?1`
  ).bind(limit).all();

  const queue = results.map((r) => ({
    ...r,
    risk_flags: r.risk_flags ? JSON.parse(r.risk_flags as string) : [],
  }));

  return json({ queue, count: queue.length });
}

async function reviewListing(request: Request, env: Env, id: string): Promise<Response> {
  let body: { decision?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be valid JSON" }, 400);
  }

  if (!["approved", "rejected"].includes(body.decision ?? "")) {
    return json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }

  const res = await env.DB.prepare(
    `UPDATE listings
        SET moderation_status = ?1, reviewed_at = datetime('now'),
            reviewed_note = ?2, updated_at = datetime('now')
      WHERE id = ?3 AND moderation_status = 'pending'`
  ).bind(body.decision, body.note ?? null, id).run();

  if (!res.meta.changes) {
    return json({ error: "Listing not found or already reviewed" }, 404);
  }

  await logModeration(env, "listing", id, "human:admin", body.decision!, {
    note: body.note ?? null,
  });

  return json({ id, moderation_status: body.decision });
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function isAdmin(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || !token) return false;
  // Constant-time-ish: compare full strings of equal length only.
  return token.length === env.ADMIN_TOKEN.length && token === env.ADMIN_TOKEN;
}

async function logModeration(
  env: Env,
  subjectType: "listing" | "landlord",
  subjectId: string,
  actor: string,
  action: string,
  detail: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_events (subject_type, subject_id, actor, action, detail)
     VALUES (?1,?2,?3,?4,?5)`
  ).bind(subjectType, subjectId, actor, action, JSON.stringify(detail)).run();
}

/**
 * KV-backed rate limiting. Eventually consistent, so a client spread across
 * colos can overshoot before counts propagate. Adequate for casual abuse;
 * move to Durable Objects if it ever guards something that matters.
 */
async function isRateLimited(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  prefix: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `${prefix}:${ip}:${bucket}`;

  const current = Number((await env.RATELIMIT.get(key)) ?? 0);
  if (current >= max) return true;

  ctx.waitUntil(
    env.RATELIMIT.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 })
  );
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function cors(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", "*"); // tighten to your domain before launch
  r.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return r;
}
