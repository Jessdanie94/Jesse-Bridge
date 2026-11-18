# Python order-review scaffolding

This is a **new Flask review-only backend**, not a restored live integration. It follows the repository's Python direction; the deleted Node backend has not been restored. It records validated Shopify order snapshots for manual review. It does not call Shopify, Sellvia, PayPal, payment processors, suppliers, or messaging services. It cannot approve orders, capture payments, issue refunds, dispatch fulfillment, or make payouts. `review_paid` describes a signed snapshot's financial status, not independently verified funds, revenue, withdrawable balance, or authorization to act.

The existing `index.html` remains a **SIMULATED** visual demonstration. Its displayed statistics, workflow checks, money and payout figures are fictional. The original file ends in incomplete JavaScript; that pre-existing defect is not repaired or redesigned here. It still references third-party browser assets; those are not backend integrations and no browser was opened during testing.

## Configuration and health

Python 3.12 is the supported target. The app reads explicit process environment only: it never loads the original `.env`. `.env.example` contains blank placeholders, not credentials. Always provide an exact lowercase `SHOPIFY_STORE_DOMAIN` ending in `.myshopify.com`; no URL, path, alternate store or custom-domain alias is accepted. `BRIDGE_INTAKE_ENABLED` defaults to `false` and accepts only `true`/`false`. Enabling intake requires separate `SHOPIFY_API_SECRET` and `ADMIN_TOKEN` values, each 32–512 characters. They are not required for disabled intake. `DATABASE_URL` is required for durable readiness. Do not put real values in source, logs or documentation.

- `GET /health/live`: process liveness, 200; `{schema_version: 1, status: live, mode: review_only}`. No database call.
- `GET /health/ready`: 200 only with valid configuration and accessible migrated Postgres; otherwise 503 with generic `configuration` or `storage_or_migration` reason. Intake can intentionally remain disabled while the service is ready.
- `POST /api/shopify/webhook/orders`: disabled by default; signed, bounded JSON intake.
- `GET /api/reviews`: `X-Admin-Token` required; configured store only, latest 100 minimized reviews. No write/approval API exists.
- Supplier and financial prefixes such as `/api/sellvia/auto-approve`, `/api/paypal/capture`, `/api/payouts/status` and `/api/refund/request` return 403. Unsupported API routes return 404.

## Intake contract

Accepted topics are `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, and `orders/fulfilled`. All require a **whole order** with positive ID, consistent optional GraphQL order ID, timezone-aware `created_at` and `updated_at`, nonnegative decimal-string `total_price`, supported currency and valid financial status. Paid/cancelled/fulfilled topics must agree with their corresponding snapshot fields. `refunds/create` has a different `order_id` payload and is **explicitly unsupported (422, not acknowledged)**. Do not subscribe it to this endpoint; refunded states in whole-order updates produce permanent review holds.

The raw body is limited to 64 KiB and verified byte-for-byte using base64 HMAC-SHA256 before JSON parsing. Require exact `X-Shopify-Shop-Domain`, allowlisted `X-Shopify-Topic`, and canonical UUID `X-Shopify-Event-Id` (not a fallback delivery ID). Duplicate JSON keys, malformed timestamps/identity/amounts and unknown currencies fail closed. Supported currencies/minor-unit rules are deliberately limited in `review.py`. Shopify body HMAC does **not** cryptographically sign topic, store or event headers; TLS and trusted upstream header handling remain necessary. No live delivery was verified.

The `(store_domain, event_id)` key is unique. An exact same-topic/raw-digest retry is acknowledged as a duplicate only after checking the durable inbox. A changed body or topic under the same key returns 409 without overwriting data. The inbox and review row commit in one transaction before HTTP 200; failed persistence or commit returns 503. Raw bodies, customer objects, names, email, phone, addresses, notes and line items are not stored. Only the minimized order ID/times/amount/currency/status fields, receipt headers, digest and review state persist.

Per-order row locks serialize concurrent receipts. Cancellation/refund holds accumulate even from older events and cannot return to a paid-review state. Older nonterminal snapshots cannot replace newer ones; conflicting equal timestamps or immutable identity metadata produce sticky conflict holds. There are no background workers or automatic downstream actions.

## Local tests and reproducible build

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements-dev.lock.txt
.venv/bin/python -m pip check
.venv/bin/python -m pytest -m 'not integration' -q
```

Unit tests inject a memory store defined **only in tests** and forbid Python socket connections. There is no environment-selectable production memory backend; injection is rejected for `APP_ENV=production`. Integration tests require an explicitly supplied disposable local Postgres database named `bridge_review_test_20261118` or `bridge_review_ci`; all other targets are rejected. They apply the additive migration and clear only review tables in that disposable database. Without that explicit test variable, integration tests skip.

```bash
REVIEW_TEST_DATABASE_URL=postgresql:///bridge_review_test_20261118 .venv/bin/python -m pytest -q
.venv/bin/pip-audit -r requirements.lock.txt --disable-pip --no-deps
.venv/bin/pip-audit -r requirements-dev.lock.txt --disable-pip --no-deps
```

Production builds use `requirements.lock.txt`; audit/test tools are separate. Regenerate with pinned pip-tools from the dev lock:

```bash
.venv/bin/pip-compile --generate-hashes --output-file=requirements.lock.txt requirements.txt
.venv/bin/pip-compile --allow-unsafe --generate-hashes --output-file=requirements-dev.lock.txt requirements-dev.txt
```

Removed unused direct runtime Flask-Cors, requests and python-dotenv dependencies. There is no cross-origin API access or outbound commerce client. CI installs hash locks, checks dependency consistency, runs offline unit tests and isolated Postgres tests, and gates known-vulnerability audits; it has no deployment job. Public advisory lookup and package installation require network, but application tests make no external commerce calls. Legacy `test/bridge.test.js` remains historical and is not executed because its backend was deleted by the user.

See [ROLLOUT.md](ROLLOUT.md) for manual migration, disabled-by-default Render proposal and rollback gates. No deployment, external transaction, commit, push or pull request is part of this change.
