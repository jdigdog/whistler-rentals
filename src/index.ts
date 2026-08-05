import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;              // public listing photos
  EVIDENCE: R2Bucket;           // private verification evidence
  SESSIONS: KVNamespace;
  ALERTS: Queue<AlertJob>;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  CONVERSATION: DurableObjectNamespace;
  TURNSTILE_SECRET: string;
  SITE_URL: string;
  FB_EXCLUSIVITY_HOURS: string; // e.g. "36"
}

type AlertJob =
  | { type: 'new_listing'; listingId: string }
  | { type: 'fb_release'; listingId: string };

const app = new Hono<{ Bindings: Env; Variables: { user: any } }>();

app.use('/api/*', cors({ origin: (o) => o, credentials: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function verifyTurnstile(env: Env, token: string, ip: string | null) {
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  const out = (await res.json()) as { success: boolean };
  return out.success === true;
}

async function currentUser(c: any) {
  const sid = c.req.header('Cookie')?.match(/sid=([^;]+)/)?.[1];
  if (!sid) return null;
  const raw = await c.env.SESSIONS.get(`session:${sid}`);
  if (!raw) return null;
  const { userId } = JSON.parse(raw) as { userId: string };
  return await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
}

async function requireUser(c: any, next: any) {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'not_authenticated' }, 401);
  c.set('user', user);
  await next();
}

// Phrases that show up immediately before a deposit scam. Cheap first pass;
// the model check in the queue consumer is the second pass.
const RISK_PATTERNS = [
  /e-?transfer.{0,30}(deposit|hold|secure)/i,
  /wire.{0,20}(transfer|funds)/i,
  /(currently|i am) (abroad|overseas|out of the country)/i,
  /send.{0,20}(first|last).{0,20}month.{0,30}before/i,
  /keys? will be (mailed|couriered|shipped)/i,
];

function riskFlags(text: string): string[] {
  return RISK_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 24));
}

// ---------------------------------------------------------------------------
// Public search
// ---------------------------------------------------------------------------

app.get('/api/listings', async (c) => {
  const q = c.req.query();
  const where: string[] = ["l.status = 'live'", "(l.publish_at IS NULL OR l.publish_at <= datetime('now'))"];
  const binds: unknown[] = [];

  if (q.term) { where.push('l.term_type = ?'); binds.push(q.term); }
  if (q.maxRent) { where.push('l.rent_cents <= ?'); binds.push(Number(q.maxRent) * 100); }
  if (q.minBeds) { where.push('l.bedrooms >= ?'); binds.push(Number(q.minBeds)); }
  if (q.pets === '1') where.push('l.pets_allowed = 1');
  if (q.parking === '1') where.push('l.parking_spots > 0');
  if (q.furnished === '1') where.push('l.furnished = 1');
  if (q.from) { where.push('l.available_from <= ?'); binds.push(q.from); }
  if (q.minTier) { where.push('u.verification_tier >= ?'); binds.push(Number(q.minTier)); }

  const sql = `
    SELECT l.id, l.title, l.term_type, l.rent_cents, l.rent_period, l.bedrooms, l.bathrooms,
           l.furnished, l.pets_allowed, l.parking_spots, l.available_from, l.transit_note,
           p.neighbourhood, p.zoning_class, p.approx_lat, p.approx_lng,
           u.display_name AS owner_name, u.verification_tier,
           (SELECT r2_key FROM listing_photos WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) AS hero_key
    FROM listings l
    JOIN properties p ON p.id = l.property_id
    JOIN users u ON u.id = l.owner_id
    WHERE ${where.join(' AND ')}
    ORDER BY u.verification_tier DESC, l.publish_at DESC
    LIMIT 60`;

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ listings: results });
});

app.get('/api/listings/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT l.*, p.neighbourhood, p.zoning_class, p.nightly_permitted, p.approx_lat, p.approx_lng,
            u.display_name AS owner_name, u.verification_tier
     FROM listings l
     JOIN properties p ON p.id = l.property_id
     JOIN users u ON u.id = l.owner_id
     WHERE l.id = ? AND l.status = 'live'`
  ).bind(c.req.param('id')).first();

  if (!row) return c.json({ error: 'not_found' }, 404);

  const { results: photos } = await c.env.DB.prepare(
    'SELECT r2_key, sort_order FROM listing_photos WHERE listing_id = ? ORDER BY sort_order'
  ).bind(c.req.param('id')).all();

  return c.json({ listing: row, photos });
});

// ---------------------------------------------------------------------------
// Listing creation — gated on verification tier and Turnstile
// ---------------------------------------------------------------------------

app.post('/api/listings', requireUser, async (c) => {
  const user = c.get('user') as any;
  const body = await c.req.json();

  const ok = await verifyTurnstile(c.env, body.turnstileToken, c.req.header('CF-Connecting-IP') ?? null);
  if (!ok) return c.json({ error: 'challenge_failed' }, 400);

  if (user.role !== 'landlord') return c.json({ error: 'landlords_only' }, 403);
  if (user.verification_tier < 2) {
    return c.json({ error: 'verification_required', needed_tier: 2 }, 403);
  }

  const property = await c.env.DB.prepare(
    'SELECT * FROM properties WHERE id = ? AND owner_id = ?'
  ).bind(body.propertyId, user.id).first();
  if (!property) return c.json({ error: 'property_not_found' }, 404);

  const listingId = id();
  const hours = Number(c.env.FB_EXCLUSIVITY_HOURS || '36');
  const fbRelease = new Date(Date.now() + hours * 3600_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO listings (id, property_id, owner_id, title, description, term_type, rent_cents,
       rent_period, utilities_incl, bedrooms, bathrooms, max_occupancy, furnished, pets_allowed,
       parking_spots, transit_note, available_from, available_to, status, publish_at, fb_release_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,?)`
  ).bind(
    listingId, body.propertyId, user.id, body.title, body.description, body.termType,
    Math.round(body.rent * 100), body.rentPeriod ?? 'month', body.utilitiesIncluded ? 1 : 0,
    body.bedrooms, body.bathrooms, body.maxOccupancy ?? null, body.furnished ? 1 : 0,
    body.petsAllowed ? 1 : 0, body.parkingSpots ?? 0, body.transitNote ?? null,
    body.availableFrom, body.availableTo ?? null, now(), fbRelease
  ).run();

  await c.env.ALERTS.send({ type: 'new_listing', listingId });
  return c.json({ id: listingId, status: 'pending_review', fbReleaseAt: fbRelease }, 201);
});

// ---------------------------------------------------------------------------
// Facebook composer — the manual bridge, since the Groups API is gone
// ---------------------------------------------------------------------------

app.get('/api/listings/:id/fb-post', requireUser, async (c) => {
  const listingId = c.req.param('id');
  const l = await c.env.DB.prepare(
    `SELECT l.*, p.neighbourhood, u.verification_tier
     FROM listings l JOIN properties p ON p.id = l.property_id
     JOIN users u ON u.id = l.owner_id WHERE l.id = ?`
  ).bind(listingId).first<any>();
  if (!l) return c.json({ error: 'not_found' }, 404);

  const campaign = `fbgroup-${new Date().toISOString().slice(0, 10)}`;
  const url = `${c.env.SITE_URL}/l/${listingId}?utm_source=facebook&utm_medium=group&utm_campaign=${campaign}`;
  const rent = (l.rent_cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
  const tierLabel = ['Unverified', 'Contact verified', 'ID verified', 'ID + ownership verified'][l.verification_tier];

  const text = [
    `${l.title} — ${l.neighbourhood}`,
    ``,
    `${rent}/${l.rent_period} · ${l.bedrooms} bed · ${l.bathrooms} bath · available ${l.available_from}`,
    l.parking_spots ? `Parking: ${l.parking_spots}` : null,
    l.pets_allowed ? `Pets OK` : null,
    ``,
    `Landlord status: ${tierLabel}.`,
    `Full details, photos, and direct message: ${url}`,
    ``,
    `Reminder: never send a deposit to anyone you have not met and whose ownership has not been confirmed.`,
  ].filter(Boolean).join('\n');

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO fb_crossposts (id, listing_id, channel, utm_campaign)
     VALUES (?,?,'group_manual',?)`
  ).bind(id(), listingId, campaign).run();

  return c.json({ text, url, ogImage: `${c.env.SITE_URL}/og/${listingId}.png` });
});

// Share-preview page: minimal HTML with Open Graph tags so pasted links render
// as a full card in the Facebook feed. Real users get redirected to the app.
app.get('/l/:id', async (c) => {
  const l = await c.env.DB.prepare(
    `SELECT l.title, l.rent_cents, l.rent_period, l.bedrooms, l.available_from, p.neighbourhood
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.id = ? AND l.status = 'live'`
  ).bind(c.req.param('id')).first<any>();
  if (!l) return c.notFound();

  const rent = (l.rent_cents / 100).toFixed(0);
  const desc = `$${rent}/${l.rent_period} · ${l.bedrooms} bed · ${l.neighbourhood} · available ${l.available_from}`;
  const canonical = `${c.env.SITE_URL}/listing/${c.req.param('id')}`;

  return c.html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<title>${l.title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${l.title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${c.env.SITE_URL}/og/${c.req.param('id')}.png">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${canonical}">
</head><body><a href="${canonical}">${l.title}</a></body></html>`);
});

// ---------------------------------------------------------------------------
// Semantic search over listing descriptions
// ---------------------------------------------------------------------------

app.get('/api/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q_required' }, 400);

  const embedding = (await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [q] })) as { data: number[][] };
  const matches = await c.env.VECTORIZE.query(embedding.data[0], { topK: 20 });
  const ids = matches.matches.map((m) => m.id);
  if (!ids.length) return c.json({ listings: [] });

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.title, l.rent_cents, l.bedrooms, p.neighbourhood
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.id IN (${placeholders}) AND l.status = 'live'`
  ).bind(...ids).all();

  return c.json({ listings: results });
});

// ---------------------------------------------------------------------------
// Queue consumer: moderation, embedding, alert fan-out
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<AlertJob>, env: Env) {
    for (const msg of batch.messages) {
      const job = msg.body;

      if (job.type === 'new_listing') {
        const l = await env.DB.prepare('SELECT * FROM listings WHERE id = ?')
          .bind(job.listingId).first<any>();
        if (!l) { msg.ack(); continue; }

        const flags = riskFlags(`${l.title}\n${l.description}`);

        // Second-pass classification for anything the regexes missed.
        const check = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'You screen rental listings for advance-fee fraud. Reply with exactly one word: SAFE or SUSPECT.' },
            { role: 'user', content: `${l.title}\n\n${l.description}` },
          ],
        });
        const suspect = /SUSPECT/i.test((check as any).response ?? '');

        if (flags.length || suspect) {
          await env.DB.prepare(
            `INSERT INTO reports (id, listing_id, reason, detail, status)
             VALUES (?,?,'suspected_scam',?, 'open')`
          ).bind(id(), l.id, JSON.stringify({ flags, modelSuspect: suspect })).run();
        } else {
          await env.DB.prepare(
            "UPDATE listings SET status = 'live', publish_at = datetime('now') WHERE id = ?"
          ).bind(l.id).run();

          const emb = (await env.AI.run('@cf/baai/bge-base-en-v1.5', {
            text: [`${l.title}. ${l.description}`],
          })) as { data: number[][] };
          await env.VECTORIZE.upsert([{ id: l.id, values: emb.data[0] }]);

          // Fan out to saved-search subscribers here (email provider call).
        }
      }

      msg.ack();
    }
  },
};

// ---------------------------------------------------------------------------
// Durable Object: one per conversation, holds message history + WebSockets
// ---------------------------------------------------------------------------

export class Conversation implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith('/send')) {
      const { senderId, text } = await req.json<{ senderId: string; text: string }>();
      const flags = riskFlags(text);
      const message = { id: crypto.randomUUID(), senderId, text, flags, at: now() };

      const history = (await this.state.storage.get<any[]>('messages')) ?? [];
      history.push(message);
      await this.state.storage.put('messages', history);

      for (const ws of this.state.getWebSockets()) {
        ws.send(JSON.stringify(message));
      }
      return Response.json(message);
    }

    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const messages = (await this.state.storage.get<any[]>('messages')) ?? [];
    return Response.json({ messages });
  }
}
