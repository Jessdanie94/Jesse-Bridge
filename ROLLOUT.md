# Review-only rollout and rollback

## Current change: proposal, not deployment

`render.yaml` is switched from stale Node commands to the Python hash-lock build, `wsgi:app` Gunicorn start and `/health/ready`. It preserves `plan: starter` and region. `autoDeployTrigger: off` and intake default `false` prevent automatic release/intake. Applying a Blueprint or changing an existing service still requires explicit operator approval. No plan upgrade, service creation, schema change in production, or deploy was performed.

## Explicit gates

1. Have an operator review source, privacy scope, retention policy, hash-lock changes and tests. Resolve any vulnerability audit finding; audit success covers known advisories only, not a comprehensive security assessment. Verify the Render Blueprint against the platform before applying it; no remote Blueprint validation was run.
2. Rehearse `migrations/001_bridge_review.sql` against a disposable/staging database. It creates only `public.bridge_review_schema`, `public.bridge_review_inbox`, `public.bridge_review_orders` and an associated index. There is no destructive migration, downgrade, ORM/Alembic dependency or startup DDL. Existing business tables are untouched. Review name collisions and privileges before applying.
3. Obtain a backup/restore plan and separate migration-owner approval. Run the migration as an explicit one-off `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_bridge_review.sql` with secrets supplied privately by the operator; never paste a real URL into docs or logs. No migration is executed by Render build/start or CI against production.
4. Use a least-privilege runtime role: SELECT on the schema marker, SELECT/INSERT on the inbox, and SELECT/INSERT/UPDATE on review orders. Runtime role needs no DDL or DELETE privileges. Configure a secure Postgres connection and exact store domain. Keep intake disabled, inspect liveness/readiness and confirm missing migration is not ready. Missing credentials or schema must never be bypassed with a memory store.
5. Pin one Gunicorn worker with four threads as proposed. The pool has max four connections, min zero, max eight waiting requests, three-second acquisition/connect/statement limits and one-second lock timeout. Connection lifetimes and server timeout are bounded; workers are recycled. Increasing worker count also increases total database connections and requires review.
6. Only after independent approval, supply separate secret/admin token and enable intake. Configure only supported whole-order topics. Do not configure `refunds/create`. Rehearse synthetic signed receipts first, then verify any real Shopify delivery separately under authorization. No outbound commerce credentials are needed. Do not treat a stored `paid` snapshot as live revenue or independent verification.
7. Establish an operator-owned retention/deletion policy and monitoring for 401/409/422/503, pool pressure and readiness failures. The review inbox currently has no automatic pruning or backfill. Review listing is limited to the most recent 100 orders, not a full reporting system.

## Containment and rollback

The responsible operator owns rollout approval and incident response. Disable intake first (`BRIDGE_INTAKE_ENABLED=false`), leave automatic deploy off, and check that intake responds 503. Do not retry unsupported topics endlessly; correct subscriptions. A successful 200 means the minimized receipt and reduction committed, not that any payment/supplier operation occurred.

Select a reviewed, last-known-good **Python** artifact and manually redeploy only under approval; do not restore the deleted Node backend. Readiness and synthetic route checks must pass before resuming intake. Keep additive review tables and receipts; code rollback does not roll back database contents. Never DROP tables or run a production downgrade as incident containment. Preserve conflicting/failed event evidence and investigate offline with minimized data. Prefer a forward fix with a regression test, then document the incident and communicate verified status without payout promises.

## Validation limits

Local Python 3.12 and disposable Postgres 16 tests establish behavior, not live Shopify acceptance or Render compatibility. CI is configured, not remotely executed. Gunicorn startup is tested only on loopback with synthetic environment. Browser simulation JavaScript remains pre-existing incomplete content; there are no tested live dashboard metrics. No external production service, API, DB, billing or user account is contacted.
