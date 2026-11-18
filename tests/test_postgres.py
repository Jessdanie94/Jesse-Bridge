from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import psycopg
import pytest

from app import create_app
from conftest import CONFIG, DOMAIN
from review import DuplicateConflict, snapshot
from storage import PostgresStore
from test_app import post

pytestmark = pytest.mark.integration


@pytest.fixture
def postgres():
    dsn = os.environ.get("REVIEW_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("explicit disposable local Postgres URL not provided")
    parsed = urlsplit(dsn)
    if parsed.scheme != "postgresql" or parsed.hostname not in {None, "localhost", "127.0.0.1"} or parsed.path not in {"/bridge_review_test_20261118", "/bridge_review_ci"} or parsed.query or parsed.fragment:
        pytest.fail("refusing anything except a named disposable local test database")
    if parsed.hostname is None:
        # Do not let an ambient PGHOST redirect a hostless test URL off-machine.
        dsn = "postgresql://ubuntu@/bridge_review_test_20261118?host=/var/run/postgresql"
    with psycopg.connect(dsn, autocommit=True, connect_timeout=3) as conn:
        migration = Path(__file__).parents[1] / "migrations" / "001_bridge_review.sql"
        conn.execute(migration.read_text())
        # Tests only, guarded disposable databases; no production cleanup operation exists.
        conn.execute("TRUNCATE public.bridge_review_inbox, public.bridge_review_orders")
        store = PostgresStore(dsn)
        try:
            yield conn, store, dsn
        finally:
            store.close()


def pg_client(store, dsn):
    return create_app({**CONFIG, "APP_ENV": "production", "DATABASE_URL": dsn}).test_client()


def test_real_receipt_duplicate_and_terminal_order(postgres, order):
    conn, store, dsn = postgres
    client = pg_client(store, dsn)
    application_store = client.application.extensions["review_store"]
    try:
        assert client.get("/health/ready").status_code == 200
        event = str(uuid4())
        assert post(client, order, event=event).status_code == 200
        assert post(client, order, event=event).json["duplicate"] is True
        changed = {**order, "total_price": "45.00"}
        assert post(client, changed, event=event).status_code == 409
        refund = {**order, "financial_status": "refunded", "updated_at": "2026-01-01T12:00:00Z"}
        assert post(client, refund, topic="orders/updated").json["state"] == "hold_refund"
        assert post(client, {**order, "updated_at": "2026-01-03T10:00:00Z"}).json["state"] == "hold_refund"
        assert conn.execute("SELECT count(*) FROM public.bridge_review_inbox").fetchone()[0] == 3
        records = conn.execute("SELECT snapshot FROM public.bridge_review_inbox").fetchall()
        assert "DO NOT STORE" not in json.dumps(records)
        assert "example.invalid" not in json.dumps(records)
    finally:
        application_store.close()


def test_real_commit_failure_rolls_back_receipt(postgres, order):
    conn, store, dsn = postgres
    # A deferred constraint trigger proves failure at COMMIT, not just at an INSERT.
    conn.execute("CREATE OR REPLACE FUNCTION public.bridge_review_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic deferred failure'; END $$")
    conn.execute("CREATE CONSTRAINT TRIGGER bridge_review_test_fail AFTER UPDATE ON public.bridge_review_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bridge_review_test_fail()")
    client = pg_client(store, dsn)
    application_store = client.application.extensions["review_store"]
    try:
        assert post(client, order).status_code == 503
        assert conn.execute("SELECT count(*) FROM public.bridge_review_inbox").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM public.bridge_review_orders").fetchone()[0] == 0
    finally:
        application_store.close()
        conn.execute("DROP TRIGGER bridge_review_test_fail ON public.bridge_review_orders")
        conn.execute("DROP FUNCTION public.bridge_review_test_fail()")
    assert post(pg_client(store, dsn), order).status_code == 200


def test_missing_migration_never_ready_or_ack(postgres, order):
    conn, store, dsn = postgres
    conn.execute("ALTER TABLE public.bridge_review_schema RENAME TO bridge_review_schema_test_hidden")
    client = pg_client(store, dsn)
    application_store = client.application.extensions["review_store"]
    try:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
        assert post(client, order).status_code == 503
        assert conn.execute("SELECT count(*) FROM public.bridge_review_inbox").fetchone()[0] == 0
    finally:
        application_store.close()
        conn.execute("ALTER TABLE public.bridge_review_schema_test_hidden RENAME TO bridge_review_schema")


def test_scoped_key_concurrent_duplicates_and_conflicts(postgres, order):
    conn, store, _ = postgres
    event = str(uuid4())
    snap = snapshot(order, "orders/paid")
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: store.receive(DOMAIN, event, "orders/paid", "a" * 64, snap), range(8)))
    assert sum(not result["duplicate"] for result in results) == 1
    with pytest.raises(DuplicateConflict):
        store.receive(DOMAIN, event, "orders/updated", "b" * 64, snap)
    assert not store.receive("second-synthetic.myshopify.com", event, "orders/paid", "a" * 64, snap)["duplicate"]
    assert conn.execute("SELECT count(*) FROM public.bridge_review_inbox").fetchone()[0] == 2


def test_concurrent_terminal_events_no_lost_hold(postgres, order):
    _, store, _ = postgres
    paid = snapshot(order, "orders/paid")
    refund = snapshot({**order, "financial_status": "refunded", "updated_at": "2026-01-01T12:00:00Z"}, "orders/updated")
    cancelled = snapshot({**order, "cancelled_at": "2026-01-01T11:00:00Z"}, "orders/cancelled")
    events = [(paid, "orders/paid"), (refund, "orders/updated"), (cancelled, "orders/cancelled")]
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(store.receive, DOMAIN, str(uuid4()), topic, str(i) * 64, snap) for i, (snap, topic) in enumerate(events)]
        for future in futures:
            future.result()
    review = store.list_reviews(DOMAIN)[0]
    assert review["state"] == "hold_cancelled"
    assert review["refund_seen"] is True and review["cancelled"] is True
