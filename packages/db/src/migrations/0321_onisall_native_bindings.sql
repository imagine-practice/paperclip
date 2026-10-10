CREATE TABLE "onisall_native_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"project_id" uuid,
	"case_id" uuid NOT NULL,
	"entry_stage_key" text NOT NULL,
	"configuration_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"purpose" text DEFAULT 'preparation' NOT NULL,
	"execution_admission" text DEFAULT 'not_granted' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_native_bindings_intake_uq" UNIQUE("company_id","intake_id"),
	CONSTRAINT "onisall_native_bindings_case_uq" UNIQUE("case_id"),
	CONSTRAINT "onisall_native_bindings_preparation_only" CHECK ("onisall_native_bindings"."revision" = 1 AND "onisall_native_bindings"."purpose" = 'preparation' AND "onisall_native_bindings"."execution_admission" = 'not_granted' AND "onisall_native_bindings"."input_sha256" ~ '^[0-9a-f]{64}$' AND "onisall_native_bindings"."configuration_hash" ~ '^[0-9a-f]{64}$' AND "onisall_native_bindings"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "onisall_intake_drafts" DROP CONSTRAINT "onisall_intake_drafts_draft_only";
--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_onisall_scope_uq" UNIQUE("company_id","pipeline_id","id");
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_onisall_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "onisall_intake_drafts" ADD CONSTRAINT "onisall_intake_drafts_input_scope_uq" UNIQUE("company_id","id","initial_snapshot_id");
--> statement-breakpoint
ALTER TABLE "onisall_native_bindings" ADD CONSTRAINT "onisall_native_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "onisall_native_bindings" ADD CONSTRAINT "onisall_native_bindings_intake_fk" FOREIGN KEY ("company_id","intake_id","snapshot_id") REFERENCES "public"."onisall_intake_drafts"("company_id","id","initial_snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "onisall_native_bindings" ADD CONSTRAINT "onisall_native_bindings_case_fk" FOREIGN KEY ("company_id","pipeline_id","case_id") REFERENCES "public"."pipeline_cases"("company_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "onisall_native_bindings" ADD CONSTRAINT "onisall_native_bindings_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "onisall_intake_drafts" ADD CONSTRAINT "onisall_intake_drafts_draft_only" CHECK ("onisall_intake_drafts"."status" = 'draft' AND "onisall_intake_drafts"."binding_status" in ('binding_pending', 'bound') AND "onisall_intake_drafts"."control_mode" = 'native_pipeline');
