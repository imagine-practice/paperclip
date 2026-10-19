CREATE TABLE "onisall_input_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_by_user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onisall_input_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"line_count" integer NOT NULL,
	"has_bom" boolean NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_input_snapshots_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_input_snapshots_shape" CHECK ("onisall_input_snapshots"."protocol" = 'onisall.input-text.v1' AND "onisall_input_snapshots"."sha256" ~ '^[0-9a-f]{64}$' AND "onisall_input_snapshots"."byte_size" BETWEEN 1 AND 1048576 AND "onisall_input_snapshots"."line_count" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "onisall_intake_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"business_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"goal" text NOT NULL,
	"source_label" text NOT NULL,
	"initial_snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"binding_status" text DEFAULT 'binding_pending' NOT NULL,
	"control_mode" text DEFAULT 'native_pipeline' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_intake_drafts_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_intake_drafts_draft_only" CHECK ("onisall_intake_drafts"."status" = 'draft' AND "onisall_intake_drafts"."binding_status" = 'binding_pending' AND "onisall_intake_drafts"."control_mode" = 'native_pipeline')
);
--> statement-breakpoint
ALTER TABLE "onisall_input_observations" ADD CONSTRAINT "onisall_input_observations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_input_observations" ADD CONSTRAINT "onisall_input_observations_intake_fk" FOREIGN KEY ("company_id","intake_id") REFERENCES "public"."onisall_intake_drafts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_input_observations" ADD CONSTRAINT "onisall_input_observations_snapshot_fk" FOREIGN KEY ("company_id","snapshot_id") REFERENCES "public"."onisall_input_snapshots"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_input_snapshots" ADD CONSTRAINT "onisall_input_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_intake_drafts" ADD CONSTRAINT "onisall_intake_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_intake_drafts" ADD CONSTRAINT "onisall_intake_drafts_snapshot_fk" FOREIGN KEY ("company_id","initial_snapshot_id") REFERENCES "public"."onisall_input_snapshots"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onisall_input_observations_request_uq" ON "onisall_input_observations" USING btree ("company_id","intake_id","request_key");--> statement-breakpoint
CREATE INDEX "onisall_input_observations_history_idx" ON "onisall_input_observations" USING btree ("company_id","intake_id","observed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "onisall_input_snapshots_content_uq" ON "onisall_input_snapshots" USING btree ("company_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "onisall_input_snapshots_object_uq" ON "onisall_input_snapshots" USING btree ("company_id","object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "onisall_intake_drafts_business_uq" ON "onisall_intake_drafts" USING btree ("company_id","business_key");