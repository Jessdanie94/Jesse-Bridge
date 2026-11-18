"""Review-only snapshot validation. No fulfillment or money-moving operations."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import re

TOPICS = frozenset({"orders/create", "orders/paid", "orders/updated", "orders/cancelled", "orders/fulfilled"})
FINANCIAL = frozenset({"pending", "authorized", "partially_paid", "paid", "partially_refunded", "refunded", "voided", "expired"})
# Explicit limited currency support; expand only with reviewed minor-unit rules.
CURRENCIES = frozenset("USD CAD EUR GBP AUD JPY CHF NZD CNY HKD INR SGD MXN BRL SEK NOK DKK PLN KRW AED ZAR".split())


class InvalidSnapshot(ValueError):
    pass


class DuplicateConflict(Exception):
    pass


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise InvalidSnapshot("timestamp required")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value):
        raise InvalidSnapshot("timezone-aware timestamp required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as exc:
        raise InvalidSnapshot("invalid timestamp") from exc
    if not datetime(2000, 1, 1, tzinfo=timezone.utc) <= parsed <= datetime.now(timezone.utc) + timedelta(minutes=5):
        raise InvalidSnapshot("timestamp outside bounds")
    return parsed


def snapshot(payload, topic):
    if not isinstance(payload, dict):
        raise InvalidSnapshot("object required")
    order_id = payload.get("id")
    if isinstance(order_id, bool) or not isinstance(order_id, (str, int)):
        raise InvalidSnapshot("order id required")
    order_id = str(order_id)
    if not re.fullmatch(r"[1-9][0-9]{0,18}", order_id) or int(order_id) > 9223372036854775807:
        raise InvalidSnapshot("invalid order id")
    gid = payload.get("admin_graphql_api_id")
    if gid is not None and gid != f"gid://shopify/Order/{order_id}":
        raise InvalidSnapshot("conflicting order identity")
    created = timestamp(payload.get("created_at"))
    updated = timestamp(payload.get("updated_at"))
    if created > updated:
        raise InvalidSnapshot("reversed order timestamps")
    currency = payload.get("currency")
    if not isinstance(currency, str) or currency not in CURRENCIES:
        raise InvalidSnapshot("unsupported currency")
    amount = payload.get("total_price")
    if not isinstance(amount, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?", amount):
        raise InvalidSnapshot("invalid amount")
    amount_decimal = Decimal(amount)
    if currency in {"JPY", "KRW"} and amount_decimal != amount_decimal.to_integral_value():
        raise InvalidSnapshot("invalid minor units")
    financial = payload.get("financial_status")
    if not isinstance(financial, str) or financial not in FINANCIAL:
        raise InvalidSnapshot("invalid financial status")
    if topic == "orders/paid" and financial != "paid":
        raise InvalidSnapshot("paid topic contradicts snapshot")
    fulfilment = payload.get("fulfillment_status")
    if fulfilment not in (None, "fulfilled", "partial", "restocked", "unfulfilled"):
        raise InvalidSnapshot("invalid fulfillment status")
    if topic == "orders/fulfilled" and fulfilment != "fulfilled":
        raise InvalidSnapshot("fulfilled topic requires whole fulfilled order")
    cancelled = payload.get("cancelled_at")
    if cancelled is not None and not created <= timestamp(cancelled) <= updated:
        raise InvalidSnapshot("invalid cancellation time")
    if topic == "orders/cancelled" and cancelled is None:
        raise InvalidSnapshot("cancelled topic requires cancellation time")
    return {
        "order_id": order_id,
        "created_at": created.isoformat(),
        "updated_at": updated.isoformat(),
        "amount": format(amount_decimal, ".2f"),
        "currency": currency,
        "financial_status": financial,
        "fulfillment_status": fulfilment,
        "cancelled": cancelled is not None,
        "refund_seen": financial in {"partially_refunded", "refunded"},
    }


def reduce_review(previous, incoming):
    """Terminal holds accumulate even for stale events; nothing authorizes dispatch."""
    previous = previous or {}
    old_snapshot = previous.get("snapshot")
    newest = incoming
    conflict = previous.get("conflict", False)
    if old_snapshot:
        if old_snapshot["created_at"] != incoming["created_at"] or old_snapshot["currency"] != incoming["currency"]:
            conflict = True
        if old_snapshot["updated_at"] > incoming["updated_at"]:
            newest = old_snapshot
        elif old_snapshot["updated_at"] == incoming["updated_at"] and old_snapshot != incoming:
            conflict = True
    cancelled = previous.get("cancelled", False) or incoming["cancelled"]
    refund_seen = previous.get("refund_seen", False) or incoming["refund_seen"]
    if cancelled:
        state = "hold_cancelled"
    elif refund_seen:
        state = "hold_refund"
    elif conflict:
        state = "hold_conflict"
    elif newest["financial_status"] == "paid":
        state = "review_paid"
    else:
        state = "review_pending"
    return {"snapshot": newest, "cancelled": cancelled, "refund_seen": refund_seen, "conflict": conflict, "state": state}
