CREATE TABLE "onisall_preparation_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"project_id" uuid,
	"case_id" uuid NOT NULL,
	"case_version" integer NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"binding_revision" integer NOT NULL,
	"binding_configuration_hash" text NOT NULL,
	"workflow_hash" text NOT NULL,
	"workflow_snapshot" text NOT NULL,
	"baseline_hash" text NOT NULL,
	"request_key" text NOT NULL,
	"purpose" text DEFAULT 'preparation' NOT NULL,
	"execution_admission" text DEFAULT 'not_granted' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_preparation_baselines_request_uq" UNIQUE("company_id","intake_id","request_key"),
	CONSTRAINT "onisall_preparation_baselines_shape" CHECK ("onisall_preparation_baselines"."purpose" = 'preparation' AND "onisall_preparation_baselines"."execution_admission" = 'not_granted'
    AND "onisall_preparation_baselines"."binding_revision" = 1 AND "onisall_preparation_baselines"."case_version" > 0 AND length("onisall_preparation_baselines"."stage_key") BETWEEN 1 AND 200
    AND "onisall_preparation_baselines"."request_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "onisall_preparation_baselines"."input_sha256" ~ '^[0-9a-f]{64}$' AND "onisall_preparation_baselines"."binding_configuration_hash" ~ '^[0-9a-f]{64}$'
    AND "onisall_preparation_baselines"."workflow_hash" ~ '^[0-9a-f]{64}$' AND "onisall_preparation_baselines"."baseline_hash" ~ '^[0-9a-f]{64}$'
    AND octet_length("onisall_preparation_baselines"."workflow_snapshot") BETWEEN 1 AND 1048576)
);
--> statement-breakpoint
ALTER TABLE "onisall_native_bindings" ADD CONSTRAINT "onisall_native_bindings_baseline_scope_uq" UNIQUE("company_id","intake_id","id");--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_binding_fk" FOREIGN KEY ("company_id","intake_id","binding_id") REFERENCES "public"."onisall_native_bindings"("company_id","intake_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_intake_fk" FOREIGN KEY ("company_id","intake_id","snapshot_id") REFERENCES "public"."onisall_intake_drafts"("company_id","id","initial_snapshot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_case_fk" FOREIGN KEY ("company_id","pipeline_id","case_id") REFERENCES "public"."pipeline_cases"("company_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
