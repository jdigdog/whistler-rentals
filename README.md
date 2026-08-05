# whistler-rentals

Cloudflare Worker connecting Whistler tenants with verified landlords.

## Layout

    src/index.ts     Worker entry point
    schema.sql       Starter D1 schema
    wrangler.toml    Bindings for dev (top level) and prod ([env.prod])

## Bindings

| Binding    | Type | Dev                            | Prod                            |
|------------|------|--------------------------------|---------------------------------|
| DB         | D1   | whistler-rentals-db-dev        | whistler-rentals-db-prod        |
| SESSIONS   | KV   | whistler-rentals-sessions-dev  | whistler-rentals-sessions-prod  |
| LANDLORDS  | KV   | whistler-rentals-landlords-dev | whistler-rentals-landlords-prod |
| RATELIMIT  | KV   | whistler-rentals-ratelimit-dev | whistler-rentals-ratelimit-prod |

Environment blocks do not inherit bindings — anything added at the top level
must also be added under `[env.prod]`.

## Setup

    npm install
    npm run db:dev        # apply schema to the dev D1 database
    npm run dev           # local dev server

## Deploy

    npm run deploy        # dev worker
    npm run deploy:prod   # prod worker

Workers Builds deploys on push. The Worker name in wrangler.toml must match
the Worker name in the Cloudflare dashboard or the build fails.

## Secrets

Never in wrangler.toml. Locally use `.dev.vars`; deployed use
`wrangler secret put NAME [--env prod]`.
