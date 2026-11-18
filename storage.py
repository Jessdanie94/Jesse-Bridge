"""Only bridge_review_* tables; never creates schema or connects at import."""
import atexit
from contextlib import contextmanager
from threading import Lock

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from review import DuplicateConflict, reduce_review


class PostgresStore:
    def __init__(self, dsn):
        self.pool = ConnectionPool(
            dsn, open=False, min_size=0, max_size=4, max_waiting=8,
            timeout=3, num_workers=1, reconnect_timeout=3,
            kwargs={"connect_timeout": 3, "options": "-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000"},
        )
        self._lock = Lock()
        self._opened = False
        atexit.register(self.close)

    def close(self):
        self.pool.close()

    @contextmanager
    def connection(self):
        with self._lock:
            if not self._opened:
                self.pool.open()
                self._opened = True
        with self.pool.connection(timeout=3) as conn:
            yield conn

    def _schema(self, conn):
        row = conn.execute("SELECT version FROM public.bridge_review_schema WHERE singleton = TRUE").fetchone()
        if row != (1,):
            raise RuntimeError("review migration required")
        conn.execute("SELECT store_domain, event_id, topic, raw_sha256, snapshot FROM public.bridge_review_inbox LIMIT 0")
        conn.execute("SELECT store_domain, order_id, review FROM public.bridge_review_orders LIMIT 0")

    def ready(self):
        with self.connection() as conn:
            self._schema(conn)
        return True

    def receive(self, store, event_id, topic, digest, order):
        # Context exit commits before the route can return any successful acknowledgment.
        with self.connection() as conn:
            self._schema(conn)
            inserted = conn.execute(
                "INSERT INTO public.bridge_review_inbox (store_domain,event_id,topic,raw_sha256,snapshot) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (store_domain,event_id) DO NOTHING RETURNING event_id",
                (store, event_id, topic, digest, Jsonb(order)),
            ).fetchone()
            if not inserted:
                existing = conn.execute(
                    "SELECT topic, raw_sha256 FROM public.bridge_review_inbox WHERE store_domain=%s AND event_id=%s",
                    (store, event_id),
                ).fetchone()
                if existing != (topic, digest):
                    raise DuplicateConflict()
                return {"duplicate": True}
            # Create then lock a single order row: concurrent event IDs cannot lose terminal holds.
            conn.execute(
                "INSERT INTO public.bridge_review_orders (store_domain,order_id,review) VALUES (%s,%s,%s) ON CONFLICT (store_domain,order_id) DO NOTHING",
                (store, order["order_id"], Jsonb({})),
            )
            previous = conn.execute(
                "SELECT review FROM public.bridge_review_orders WHERE store_domain=%s AND order_id=%s FOR UPDATE",
                (store, order["order_id"]),
            ).fetchone()[0]
            review = reduce_review(previous, order)
            conn.execute(
                "UPDATE public.bridge_review_orders SET review=%s, received_at=now() WHERE store_domain=%s AND order_id=%s",
                (Jsonb(review), store, order["order_id"]),
            )
        return {"duplicate": False, "state": review["state"]}

    def list_reviews(self, store):
        with self.connection() as conn:
            self._schema(conn)
            rows = conn.execute(
                "SELECT order_id,review FROM public.bridge_review_orders WHERE store_domain=%s ORDER BY received_at DESC,order_id DESC LIMIT 100",
                (store,),
            ).fetchall()
        return [{"order_id": row[0], **row[1]} for row in rows]
