-- Explicit operator-run additive migration; never executed by application startup.
BEGIN;
CREATE TABLE IF NOT EXISTS public.bridge_review_schema (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    version integer NOT NULL CHECK (version = 1)
);
CREATE TABLE IF NOT EXISTS public.bridge_review_inbox (
    store_domain text NOT NULL,
    event_id uuid NOT NULL,
    topic text NOT NULL CHECK (topic IN ('orders/create','orders/paid','orders/updated','orders/cancelled','orders/fulfilled')),
    raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_domain, event_id)
);
CREATE TABLE IF NOT EXISTS public.bridge_review_orders (
    store_domain text NOT NULL,
    order_id text NOT NULL CHECK (order_id ~ '^[1-9][0-9]{0,18}$'),
    review jsonb NOT NULL CHECK (jsonb_typeof(review) = 'object'),
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_domain, order_id)
);
CREATE INDEX IF NOT EXISTS bridge_review_orders_received ON public.bridge_review_orders (store_domain, received_at DESC);
INSERT INTO public.bridge_review_schema (singleton,version) VALUES (TRUE,1) ON CONFLICT (singleton) DO NOTHING;
COMMIT;
