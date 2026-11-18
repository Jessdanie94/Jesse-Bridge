import copy
import socket
from threading import Lock

import pytest

from app import create_app
from review import DuplicateConflict, reduce_review

DOMAIN = "synthetic-store.myshopify.com"
CONFIG = {"APP_ENV": "test", "BRIDGE_INTAKE_ENABLED": "true", "SHOPIFY_STORE_DOMAIN": DOMAIN, "SHOPIFY_API_SECRET": "synthetic-signature-secret-for-tests-only", "ADMIN_TOKEN": "synthetic-review-admin-token-for-tests-only", "DATABASE_URL": ""}


class MemoryStore:
    """Injected tests only: never imported by the production application."""
    def __init__(self):
        self.inbox = {}
        self.orders = {}
        self.lock = Lock()

    def ready(self):
        return True

    def receive(self, store, event, topic, digest, order):
        with self.lock:
            key = (store, event)
            if key in self.inbox:
                if self.inbox[key][:2] != (topic, digest):
                    raise DuplicateConflict()
                return {"duplicate": True}
            review = reduce_review(self.orders.get((store, order["order_id"])), order)
            self.inbox[key] = (topic, digest, copy.deepcopy(order))
            self.orders[store, order["order_id"]] = review
        return {"duplicate": False, "state": review["state"]}

    def list_reviews(self, store):
        return [{"order_id": key[1], **value} for key, value in self.orders.items() if key[0] == store]


@pytest.fixture(autouse=True)
def no_python_outbound_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("network prohibited during tests")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def app(store):
    return create_app(CONFIG, store=store)


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def order():
    return {"id": 123, "admin_graphql_api_id": "gid://shopify/Order/123", "created_at": "2026-01-01T10:00:00Z", "updated_at": "2026-01-02T10:00:00Z", "total_price": "12.34", "currency": "USD", "financial_status": "paid", "fulfillment_status": None, "cancelled_at": None, "email": "never-store@example.invalid", "shipping_address": {"address1": "DO NOT STORE"}, "customer": {"phone": "DO NOT STORE"}}
