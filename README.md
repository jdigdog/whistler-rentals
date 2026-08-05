# whistler-rentals

Cloudflare Workers scaffold for a verified tenant/landlord rental platform.

Verification tiers, not listings, are the product. See `EXECUTION-GUIDE.md` for
the phased build plan and provisioning commands.

## Quick start

```bash
npm install
npx wrangler login
# provision resources, paste ids into wrangler.jsonc — see EXECUTION-GUIDE.md Phase 1
npx wrangler d1 migrations apply rentals --local
npx wrangler dev
```

## Stack

| Binding | Resource | Role |
|---|---|---|
| `DB` | D1 | listings, users, verifications, reports |
| `MEDIA` | R2 (public) | listing photos |
| `EVIDENCE` | R2 (private) | verification documents, signed URLs only |
| `SESSIONS` | KV | sessions and cached search |
| `ALERTS` | Queues | moderation, embedding, alert fan-out |
| `CONVERSATION` | Durable Objects | one per conversation, WebSocket messaging |
| `AI` + `VECTORIZE` | Workers AI | scam classification, semantic search |

Edge layer (dashboard-configured): WAF managed ruleset, Turnstile on write
endpoints, rate limiting on search and messaging, Access on `/admin/*`.
