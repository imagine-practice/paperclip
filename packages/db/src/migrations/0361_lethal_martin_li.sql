CREATE TABLE "pipeline_operation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"root_kind" text DEFAULT 'case_transition' NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"principal_type" text DEFAULT 'user' NOT NULL,
	"principal_id" text NOT NULL,
	"provenance_version" integer DEFAULT 1 NOT NULL,
	"request_canonical_version" integer DEFAULT 1 NOT NULL,
	"request_fingerprint" text NOT NULL,
	"epoch" text,
	"epoch_provenance" text DEFAULT 'legacy_unversioned' NOT NULL,
	"coverage_kind" text DEFAULT 'limited_root_result_v1' NOT NULL,
	"facts_version" integer DEFAULT 1 NOT NULL,
	"root_facts" jsonb,
	"root_facts_sha256" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_disposition" text DEFAULT 'facts_preserved' NOT NULL,
	"redacted_at" timestamp with time zone,
	"retention_policy_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pipeline_operation_receipts_protocol_ck" CHECK ("pipeline_operation_receipts"."root_kind" = 'case_transition' AND "pipeline_operation_receipts"."protocol_version" = 1 AND "pipeline_operation_receipts"."principal_type" = 'user' AND "pipeline_operation_receipts"."principal_id" NOT IN ('board', 'local-board') AND length("pipeline_operation_receipts"."principal_id") > 0 AND "pipeline_operation_receipts"."provenance_version" = 1 AND "pipeline_operation_receipts"."request_canonical_version" = 1 AND "pipeline_operation_receipts"."facts_version" = 1 AND "pipeline_operation_receipts"."coverage_kind" = 'limited_root_result_v1' AND "pipeline_operation_receipts"."epoch" IS NULL AND "pipeline_operation_receipts"."epoch_provenance" = 'legacy_unversioned' AND "pipeline_operation_receipts"."retention_policy_version" = 1),
	CONSTRAINT "pipeline_operation_receipts_fingerprint_ck" CHECK ("pipeline_operation_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pipeline_operation_receipts_retention_ck" CHECK (("pipeline_operation_receipts"."retention_disposition" = 'facts_preserved' AND "pipeline_operation_receipts"."root_facts" IS NOT NULL AND "pipeline_operation_receipts"."root_facts_sha256" IS NOT NULL AND "pipeline_operation_receipts"."root_facts_sha256" ~ '^[0-9a-f]{64}$' AND "pipeline_operation_receipts"."redacted_at" IS NULL) OR ("pipeline_operation_receipts"."retention_disposition" = 'tombstone' AND "pipeline_operation_receipts"."root_facts" IS NULL AND "pipeline_operation_receipts"."root_facts_sha256" IS NULL AND "pipeline_operation_receipts"."redacted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "pipeline_operation_receipts" ADD CONSTRAINT "pipeline_operation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_operation_receipts_company_operation_uq" ON "pipeline_operation_receipts" USING btree ("company_id","operation_id");
--> statement-breakpoint
-- Immutable operation binding. Trusted lifecycle/redaction writers must opt in
-- within their transaction; privileged direct SQL is outside the service proof.
CREATE FUNCTION pipeline_operation_receipt_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('paperclip.pipeline_receipt_company_cleanup', true) IS DISTINCT FROM OLD.company_id::text THEN
      RAISE EXCEPTION 'pipeline operation key cannot be ordinarily deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['root_facts', 'root_facts_sha256', 'retention_disposition', 'redacted_at'])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['root_facts', 'root_facts_sha256', 'retention_disposition', 'redacted_at'])
     OR OLD.retention_disposition <> 'facts_preserved'
     OR NEW.retention_disposition <> 'tombstone'
     OR NEW.root_facts IS NOT NULL OR NEW.root_facts_sha256 IS NOT NULL OR NEW.redacted_at IS NULL
     OR current_setting('paperclip.pipeline_receipt_redaction', true) IS DISTINCT FROM OLD.company_id::text THEN
    RAISE EXCEPTION 'pipeline operation receipt binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pipeline_operation_receipt_guard_v1
BEFORE UPDATE OR DELETE ON pipeline_operation_receipts
FOR EACH ROW EXECUTE FUNCTION pipeline_operation_receipt_guard_v1();
