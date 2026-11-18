# Local validation — 2026-11-18

Scope: new review-only Python scaffolding on branch `improvements/python-order-review-20261118`, based on `fa0e7c46919223923e1b04ae5727d9bc15febfb9`. No commit, push, PR, Render deploy, live Shopify/PayPal/Sellvia call, supplier action, purchase, payment or message was performed. Original `.env` was not read or loaded. Only the explicitly authorized disposable local Postgres database was used.

## Exact final results

| Check | Result |
|---|---|
| Python | 3.12.3 |
| Disposable database | PostgreSQL 16.15 |
| `pytest -m 'not integration' -q` | **90 passed, 5 deselected in 0.46s** |
| `pytest -q` with explicit disposable local database | **95 passed in 0.58s** |
| `pip install --require-hashes -r requirements-dev.lock.txt` | Pass |
| Fresh isolated runtime install from `requirements.lock.txt` | Pass |
| `pip check` (dev and fresh runtime environments) | **No broken requirements found** |
| Runtime/dev transitive pin comparison | **All 12 runtime package pins match** |
| Runtime `pip-audit` against locked packages | **No known vulnerabilities found** |
| Dev `pip-audit` against locked packages | **No known vulnerabilities found** |
| Source and test `compileall` | Pass |
| Fresh runtime WSGI import/factory route smoke | Pass |
| `gunicorn --check-config wsgi:app` | Pass |
| Actual Gunicorn start, loopback only, synthetic environment | Pass; service stopped after check |
| Loopback `/health/live`, `/health/ready`, `/` | 200, expected 503 without DB config, 200 |
| Loopback POST payout/intake | 403 financial action denied, 503 intake disabled |
| `git diff --check` | Pass |
| Public source/docs targeted owner-identifier and obsolete-secret scan | Pass |

The Postgres tests apply the explicit additive migration; verify durable unique receipt handling and conflicts; prove rollback of both inbox and review when a deferred trigger fails at COMMIT; verify missing-migration readiness/intake failure; and exercise concurrent duplicates and terminal refund/cancellation holds. Tests reject all but specifically named local disposable database URLs. Hostless test URLs are pinned to a local Unix socket rather than trusting ambient PGHOST.

The first development audit found an advisory for pytest 9.0.2; it was replaced with 9.2.0. pip-tools 7.5.2 was incompatible with the installed pip; it was replaced with 7.7.0 and both hash locks/install checks now succeed. Final dev pins include pip-audit 2.10.1. These initial findings are resolved, not accepted exceptions.

## Dependency changes

Runtime direct pins: Flask 3.1.3, Gunicorn 27.0.1, psycopg[binary] 3.3.9, psycopg-pool 3.3.3. Removed unused direct runtime Flask-Cors, requests, python-dotenv. Runtime transitive pins: blinker 1.9.0, click 8.5.1, itsdangerous 2.2.0, Jinja2 3.1.6, MarkupSafe 3.0.4, psycopg-binary 3.3.9, typing-extensions 4.16.0, Werkzeug 3.1.9. The dev audit tool brings its own separate HTTP dependencies; no runtime commerce HTTP client is present.

## Limits and release gates

Advisory audits query a public vulnerability service and cover known findings only. No live integration, production migration, browser UI behavior, hosted CI run or remote Render Blueprint validation was performed. Render proposes Python 3.12.12; only matching major/minor Python 3.12.3 was exercised locally. `plan: starter` is preserved, `autoDeployTrigger: "off"` is explicit, and intake defaults off.

The user's original simulation HTML is preserved except fencing removal and explicit simulation labels. It already ends in incomplete JavaScript; this is documented rather than silently reconstructed. `refunds/create` is explicitly unsupported (422); only validated whole-order supported topics are accepted. Review listing is bounded to 100 records; retention and any broader operator workflow require separate review. The legacy Node test is left untouched and not executed. Review source/DDL and follow `ROLLOUT.md` before any separately approved deployment.

## Final parent hardening

Configured review-access secrets now retain the same minimum strength even when intake is disabled. Blank unused secrets remain allowed and cannot authenticate review reads. The added three-case regression suite passes; the updated offline suite is **93 passed, 5 deselected in 0.51s**. The earlier table records the worker's initial results; the final local Postgres rerun is recorded below after completion.

Final parent Postgres rerun on the guarded disposable local database: **98 passed in 0.61s**. No production database was used.
