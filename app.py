"""New review backend scaffolding. No external commerce clients or dotenv loading."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import UUID

from flask import Blueprint, Flask, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

from review import DuplicateConflict, InvalidSnapshot, TOPICS, snapshot
from storage import PostgresStore

MAX_BODY = 65536
CONFIG_KEYS = ("APP_ENV", "BRIDGE_INTAKE_ENABLED", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_API_SECRET", "ADMIN_TOKEN", "DATABASE_URL")


def configuration_errors(config, injected=False):
    errors = []
    if config["APP_ENV"] not in {"production", "development", "test"}:
        errors.append("APP_ENV")
    if config["BRIDGE_INTAKE_ENABLED"] not in {"true", "false"}:
        errors.append("BRIDGE_INTAKE_ENABLED")
    domain = config["SHOPIFY_STORE_DOMAIN"]
    if not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com", domain):
        errors.append("SHOPIFY_STORE_DOMAIN")
    for key in ("SHOPIFY_API_SECRET", "ADMIN_TOKEN"):
        value = config[key]
        if (config["BRIDGE_INTAKE_ENABLED"] == "true" or value) and (
            not isinstance(value, str) or not 32 <= len(value) <= 512 or value.isspace()
        ):
            errors.append(key)
    if config["SHOPIFY_API_SECRET"] and config["SHOPIFY_API_SECRET"] == config["ADMIN_TOKEN"]:
        errors.append("SEPARATE_SECRETS_REQUIRED")
    if not injected:
        try:
            dsn = urlsplit(config["DATABASE_URL"])
            if dsn.scheme not in {"postgres", "postgresql"} or not dsn.path.strip("/"):
                errors.append("DATABASE_URL")
        except (TypeError, ValueError):
            errors.append("DATABASE_URL")
    return errors


def create_app(overrides=None, *, store=None):
    app = Flask(__name__, static_folder=None)
    app.config.update({key: os.environ.get(key, "") for key in CONFIG_KEYS})
    app.config.update(APP_ENV=os.environ.get("APP_ENV", "production"), BRIDGE_INTAKE_ENABLED=os.environ.get("BRIDGE_INTAKE_ENABLED", "false"))
    if overrides:
        app.config.update(overrides)
    app.config.update(MAX_CONTENT_LENGTH=MAX_BODY)
    if store is not None and app.config["APP_ENV"] not in {"test", "development"}:
        raise ValueError("injected stores prohibited in production")
    errors = configuration_errors(app.config, injected=store is not None)
    if store is None and not errors:
        store = PostgresStore(app.config["DATABASE_URL"])
    app.extensions["review_store"] = store
    app.extensions["review_configuration_errors"] = tuple(errors)
    api = Blueprint("review_api", __name__)

    def available():
        return not errors and store is not None

    @api.get("/health/live")
    def live():
        return jsonify(schema_version=1, status="live", mode="review_only")

    @api.get("/health/ready")
    def ready():
        status = "not_ready"
        reason = "configuration"
        if available():
            try:
                if store.ready():
                    status, reason = "ready", None
                else:
                    reason = "storage_or_migration"
            except Exception:
                reason = "storage_or_migration"
        return jsonify(schema_version=1, status=status, mode="review_only", intake_enabled=app.config["BRIDGE_INTAKE_ENABLED"] == "true", reason=reason), 200 if status == "ready" else 503

    @api.post("/api/shopify/webhook/orders")
    def intake():
        if app.config["BRIDGE_INTAKE_ENABLED"] != "true":
            return jsonify(error="intake_disabled"), 503
        if not available():
            return jsonify(error="not_ready"), 503
        if request.mimetype != "application/json" or request.headers.get("Content-Encoding", "identity") != "identity":
            return jsonify(error="json_identity_encoding_required"), 415
        raw = request.stream.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise RequestEntityTooLarge()
        expected = base64.b64encode(hmac.digest(app.config["SHOPIFY_API_SECRET"].encode(), raw, "sha256"))
        received = request.headers.get("X-Shopify-Hmac-Sha256", "").encode()
        if not hmac.compare_digest(expected, received):
            return jsonify(error="invalid_signature"), 401
        domain = request.headers.get("X-Shopify-Shop-Domain", "")
        if domain != app.config["SHOPIFY_STORE_DOMAIN"]:
            return jsonify(error="store_mismatch"), 403
        topic = request.headers.get("X-Shopify-Topic", "")
        if topic not in TOPICS:
            # refunds/create is a different order_id payload, intentionally not acknowledged.
            return jsonify(error="unsupported_topic"), 422
        event_id = request.headers.get("X-Shopify-Event-Id", "")
        try:
            if str(UUID(event_id)) != event_id:
                raise ValueError()
        except (ValueError, AttributeError):
            return jsonify(error="canonical_event_id_required"), 400
        try:
            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError("duplicate JSON key")
                    result[key] = value
                return result
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid constant")))
            order = snapshot(payload, topic)
        except (InvalidSnapshot, ValueError, UnicodeError, RecursionError):
            return jsonify(error="invalid_order_snapshot"), 422
        try:
            result = store.receive(domain, event_id, topic, hashlib.sha256(raw).hexdigest(), order)
        except DuplicateConflict:
            return jsonify(error="duplicate_identity_conflict"), 409
        except Exception:
            # Do not log bodies, secrets or exception strings containing database credentials.
            app.logger.error("review_storage_failure")
            return jsonify(error="receipt_not_committed"), 503
        return jsonify(status="recorded_for_review", **result), 200

    @api.get("/api/reviews")
    def reviews():
        token = app.config["ADMIN_TOKEN"]
        supplied = request.headers.get("X-Admin-Token", "")
        if not token or not hmac.compare_digest(token.encode(), supplied.encode()):
            return jsonify(error="unauthorized"), 401
        if not available():
            return jsonify(error="not_ready"), 503
        try:
            return jsonify(mode="review_only", reviews=store.list_reviews(app.config["SHOPIFY_STORE_DOMAIN"]))
        except Exception:
            return jsonify(error="storage_unavailable"), 503

    @api.route("/api/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def unsupported(path):
        if path.split("/")[0] in {"sellvia", "payout", "payouts", "paypal", "payments", "capture", "dispatch", "refund"}:
            return jsonify(error="financial_and_supplier_actions_disabled", mode="review_only"), 403
        return jsonify(error="not_found"), 404

    @app.get("/")
    def demo():
        return send_file(Path(__file__).with_name("index.html"))

    @app.errorhandler(RequestEntityTooLarge)
    def body_too_large(_):
        return jsonify(error="body_too_large"), 413

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        if request.path != "/":
            response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        return response

    app.register_blueprint(api)
    return app
