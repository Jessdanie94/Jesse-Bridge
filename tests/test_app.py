import base64
import hashlib
import hmac
import json
from uuid import uuid4

import pytest

from app import create_app
from conftest import CONFIG, DOMAIN, MemoryStore


def post(client, payload, *, topic="orders/paid", event=None, domain=DOMAIN, raw=None, headers=None):
    raw = raw if raw is not None else json.dumps(payload).encode()
    signed = {"Content-Type": "application/json", "X-Shopify-Shop-Domain": domain, "X-Shopify-Topic": topic, "X-Shopify-Event-Id": event or str(uuid4()), "X-Shopify-Hmac-Sha256": base64.b64encode(hmac.digest(CONFIG["SHOPIFY_API_SECRET"].encode(), raw, "sha256")).decode()}
    signed.update(headers or {})
    return client.post("/api/shopify/webhook/orders", data=raw, headers=signed)


def test_health_root_and_minimization(client, store, order):
    assert client.get("/health/live").json == {"schema_version": 1, "status": "live", "mode": "review_only"}
    assert client.get("/health/ready").status_code == 200
    assert client.get("/").status_code == 200
    response = post(client, order)
    assert response.status_code == 200
    assert response.json["state"] == "review_paid"
    serialized = json.dumps([list(store.inbox.values()), list(store.orders.values())])
    assert "DO NOT STORE" not in serialized and "example.invalid" not in serialized
    assert len(store.inbox) == len(store.orders) == 1


@pytest.mark.parametrize("header,value,status", [
    ("X-Shopify-Hmac-Sha256", "bad", 401),
    ("X-Shopify-Hmac-Sha256", "", 401),
    ("X-Shopify-Shop-Domain", "other.myshopify.com", 403),
    ("X-Shopify-Shop-Domain", "SYNTHETIC-STORE.myshopify.com", 403),
    ("X-Shopify-Shop-Domain", DOMAIN + ".evil.invalid", 403),
    ("X-Shopify-Shop-Domain", "https://" + DOMAIN, 403),
    ("X-Shopify-Event-Id", "", 400),
    ("X-Shopify-Event-Id", "not-a-uuid", 400),
    ("X-Shopify-Event-Id", "ABCDEF00-0000-0000-0000-000000000000", 400),
    ("X-Shopify-Topic", "orders/paid ", 422),
    ("X-Shopify-Topic", "refunds/create", 422),
    ("Content-Type", "text/plain", 415),
    ("Content-Encoding", "gzip", 415),
])
def test_invalid_identity_never_persists(client, store, order, header, value, status):
    assert post(client, order, headers={header: value}).status_code == status
    assert not store.inbox


@pytest.mark.parametrize("field,value", [
    ("id", True), ("id", -1), ("id", 1.2), ("id", "001"), ("id", 9223372036854775808),
    ("admin_graphql_api_id", "gid://shopify/Order/999"),
    ("created_at", "2026-01-03T10:00:00Z"), ("updated_at", "2026-01-02T10:00:00"),
    ("updated_at", "2099-01-01T00:00:00Z"), ("total_price", "NaN"), ("total_price", "-1"),
    ("total_price", 12.34), ("total_price", "1e3"), ("total_price", "1.234"),
    ("currency", "ZZZ"), ("currency", "usd"), ("financial_status", "refunded"),
    ("financial_status", []), ("cancelled_at", "2026-01-04T00:00:00Z"),
])
def test_invalid_snapshot(client, store, order, field, value):
    order[field] = value
    assert post(client, order).status_code == 422
    assert not store.inbox


@pytest.mark.parametrize("raw", [b'{"id":1,"id":2}', b'[]', b'{}', b'{', b'\xff', b'{"id": NaN}'])
def test_malformed_json(client, store, raw):
    assert post(client, {}, raw=raw).status_code == 422
    assert not store.inbox


def test_exact_raw_signature_and_bounded_body(client, store, order):
    raw = json.dumps(order).encode()
    sig = base64.b64encode(hmac.digest(CONFIG["SHOPIFY_API_SECRET"].encode(), raw, "sha256")).decode()
    assert post(client, {}, raw=raw + b" ", headers={"X-Shopify-Hmac-Sha256": sig}).status_code == 401
    assert post(client, {}, raw=b"x" * 65537).status_code == 413
    assert not store.inbox


def test_duplicate_conflict_not_overwritten(client, store, order):
    event = str(uuid4())
    assert post(client, order, event=event).status_code == 200
    assert post(client, order, event=event).json["duplicate"] is True
    order["total_price"] = "99.99"
    assert post(client, order, event=event).status_code == 409
    assert next(iter(store.orders.values()))["snapshot"]["amount"] == "12.34"
    assert len(store.inbox) == 1
    order["total_price"] = "12.34"
    assert post(client, order, event=event, topic="orders/updated").status_code == 409


@pytest.mark.parametrize("terminal,topic,state", [
    ({"financial_status": "refunded"}, "orders/updated", "hold_refund"),
    ({"financial_status": "partially_refunded"}, "orders/updated", "hold_refund"),
    ({"cancelled_at": "2026-01-01T11:00:00Z"}, "orders/cancelled", "hold_cancelled"),
])
def test_out_of_order_terminal_holds(client, store, order, terminal, topic, state):
    assert post(client, order).status_code == 200
    older = {**order, "updated_at": "2026-01-01T12:00:00Z", **terminal}
    assert post(client, older, topic=topic).json["state"] == state
    newer = {**order, "updated_at": "2026-01-03T10:00:00Z"}
    assert post(client, newer).json["state"] == state
    assert next(iter(store.orders.values()))["state"] == state


def test_stale_nonterminal_and_equal_time_conflict(client, store, order):
    post(client, order)
    older = {**order, "updated_at": "2026-01-01T12:00:00Z", "financial_status": "pending"}
    assert post(client, older, topic="orders/updated").json["state"] == "review_paid"
    changed = {**order, "total_price": "20.00"}
    assert post(client, changed).json["state"] == "hold_conflict"


def test_fulfilled_whole_order_and_truthful_refund_rejection(client, store, order):
    assert post(client, order, topic="orders/fulfilled").status_code == 422
    order["fulfillment_status"] = "fulfilled"
    assert post(client, order, topic="orders/fulfilled").status_code == 200
    assert post(client, {"order_id": 123}, topic="refunds/create").status_code == 422


def test_review_auth(client, order):
    post(client, order)
    assert client.get("/api/reviews").status_code == 401
    assert client.get("/api/reviews", headers={"X-Admin-Token": "é"}).status_code == 401
    response = client.get("/api/reviews", headers={"X-Admin-Token": CONFIG["ADMIN_TOKEN"]})
    assert response.status_code == 200
    assert len(response.json["reviews"]) == 1
    assert "email" not in json.dumps(response.json)


@pytest.mark.parametrize("path", ["sellvia/auto-approve", "payouts/status", "payouts/request", "paypal/capture", "payments/capture", "dispatch", "refund/request"])
@pytest.mark.parametrize("method", ["get", "post", "put", "patch", "delete"])
def test_money_and_supplier_denials(client, path, method):
    assert getattr(client, method)("/api/" + path).status_code == 403


@pytest.mark.parametrize("key,value", [("SHOPIFY_STORE_DOMAIN", ""), ("SHOPIFY_STORE_DOMAIN", "shop.example.com"), ("SHOPIFY_API_SECRET", ""), ("ADMIN_TOKEN", ""), ("BRIDGE_INTAKE_ENABLED", "yes")])
def test_missing_config_fail_closed(key, value, order):
    client = create_app({**CONFIG, key: value}, store=MemoryStore()).test_client()
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 503
    assert post(client, order).status_code == 503


def test_disabled_intake_does_not_require_secrets(order):
    app = create_app({**CONFIG, "BRIDGE_INTAKE_ENABLED": "false", "SHOPIFY_API_SECRET": "", "ADMIN_TOKEN": ""}, store=MemoryStore())
    assert app.test_client().get("/health/ready").status_code == 200
    assert post(app.test_client(), order).status_code == 503


def test_production_missing_postgres_and_memory_prohibited():
    app = create_app({**CONFIG, "APP_ENV": "production"})
    assert app.test_client().get("/health/ready").status_code == 503
    with pytest.raises(ValueError):
        create_app({**CONFIG, "APP_ENV": "production"}, store=MemoryStore())


def test_storage_failure_no_ack_and_ready_failure(order):
    class FailedStore(MemoryStore):
        def ready(self):
            raise RuntimeError("synthetic unavailable")
        def receive(self, *args):
            raise RuntimeError("synthetic commit failure")
    store = FailedStore()
    client = create_app(CONFIG, store=store).test_client()
    assert client.get("/health/ready").status_code == 503
    assert post(client, order).status_code == 503
    assert not store.inbox


@pytest.mark.parametrize("token", ["short", " " * 32, "x" * 513])
def test_disabled_intake_rejects_weak_configured_review_token(token):
    client = create_app({**CONFIG, "BRIDGE_INTAKE_ENABLED": "false", "SHOPIFY_API_SECRET": "", "ADMIN_TOKEN": token}, store=MemoryStore()).test_client()
    assert client.get("/health/ready").status_code == 503
    assert client.get("/api/reviews", headers={"X-Admin-Token": token}).status_code == 503
