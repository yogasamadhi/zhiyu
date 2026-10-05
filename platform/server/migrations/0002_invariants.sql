ALTER TABLE cloud_orders ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK(environment='test');
ALTER TABLE cloud_ai_requests ADD COLUMN environment text NOT NULL DEFAULT 'test' CHECK(environment='test');
ALTER TABLE cloud_orders ADD CONSTRAINT cloud_order_state CHECK(status IN ('pending','paid','failed','canceled','closed','refunded'));
ALTER TABLE cloud_orders ADD CONSTRAINT cloud_payment_channel CHECK(channel IN ('mock-wechat','mock-alipay'));
ALTER TABLE cloud_credit_periods ADD CONSTRAINT cloud_period_state CHECK(state IN ('scheduled','active','expired','revoked'));
ALTER TABLE cloud_ai_requests ADD CONSTRAINT cloud_request_state CHECK(status IN ('reserved','calling','settled','released','review'));
ALTER TABLE cloud_terms ADD COLUMN months int NOT NULL DEFAULT 1 CHECK(months IN (1,12));
UPDATE cloud_terms t SET months=CASE WHEN o.snapshot->>'cycle'='year' THEN 12 ELSE 1 END FROM cloud_orders o WHERE o.id=t.order_id;
CREATE FUNCTION cloud_keep_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config THEN RAISE EXCEPTION 'Create a new immutable configuration version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_immutable_price BEFORE UPDATE ON cloud_prices FOR EACH ROW EXECUTE FUNCTION cloud_keep_configuration();
CREATE TRIGGER cloud_immutable_model BEFORE UPDATE ON cloud_models FOR EACH ROW EXECUTE FUNCTION cloud_keep_configuration();
CREATE FUNCTION cloud_keep_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Credit history is append-only; append an audited adjustment';
END $$;
CREATE TRIGGER cloud_ledger_append_only BEFORE UPDATE OR DELETE ON cloud_credit_ledger FOR EACH ROW EXECUTE FUNCTION cloud_keep_ledger();
CREATE TABLE cloud_runtime_status (key text PRIMARY KEY, updated_at timestamptz NOT NULL);
