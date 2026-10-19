CREATE TABLE "onisall_contract_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"rule_set_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_revision" integer DEFAULT 1 NOT NULL,
	"request_key" text NOT NULL,
	"request_payload" text NOT NULL,
	"request_hash" text NOT NULL,
	"candidate" text NOT NULL,
	"candidate_sha256" text NOT NULL,
	"candidate_byte_size" integer NOT NULL,
	"dependencies" text NOT NULL,
	"dependencies_sha256" text NOT NULL,
	"preflight" text NOT NULL,
	"preflight_sha256" text NOT NULL,
	"check_plan" text NOT NULL,
	"acceptance_criteria_hash" text NOT NULL,
	"check_plan_sha256" text NOT NULL,
	"purpose" text DEFAULT 'preparation' NOT NULL,
	"execution_admission" text DEFAULT 'not_granted' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_contract_preparations_request_uq" UNIQUE("company_id","intake_id","request_key"),
	CONSTRAINT "onisall_contract_preparations_identity_uq" UNIQUE("company_id","contract_id","contract_revision"),
	CONSTRAINT "onisall_contract_preparations_shape" CHECK ("onisall_contract_preparations"."purpose" = 'preparation' AND "onisall_contract_preparations"."execution_admission" = 'not_granted'
    AND "onisall_contract_preparations"."contract_revision" = 1 AND "onisall_contract_preparations"."request_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "onisall_contract_preparations"."candidate_byte_size" BETWEEN 1 AND 1048576 AND octet_length("onisall_contract_preparations"."candidate") = "onisall_contract_preparations"."candidate_byte_size"
    AND octet_length("onisall_contract_preparations"."request_payload") BETWEEN 1 AND 1048576 AND octet_length("onisall_contract_preparations"."dependencies") BETWEEN 1 AND 65536
    AND octet_length("onisall_contract_preparations"."preflight") BETWEEN 1 AND 1048576 AND octet_length("onisall_contract_preparations"."check_plan") BETWEEN 1 AND 1048576 AND "onisall_contract_preparations"."request_hash" ~ '^[a-f0-9]{64}$'
    AND "onisall_contract_preparations"."candidate_sha256" ~ '^[a-f0-9]{64}$' AND "onisall_contract_preparations"."dependencies_sha256" ~ '^[a-f0-9]{64}$'
    AND "onisall_contract_preparations"."preflight_sha256" ~ '^[a-f0-9]{64}$' AND "onisall_contract_preparations"."acceptance_criteria_hash" ~ '^[a-f0-9]{64}$'
    AND "onisall_contract_preparations"."check_plan_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "onisall_contract_preparations" ADD CONSTRAINT "onisall_contract_preparations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_contract_preparations" ADD CONSTRAINT "onisall_contract_preparations_intake_fk" FOREIGN KEY ("company_id","intake_id") REFERENCES "public"."onisall_intake_drafts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_preparation_baselines" ADD CONSTRAINT "onisall_preparation_baselines_scope_uq" UNIQUE("company_id","intake_id","id");--> statement-breakpoint
ALTER TABLE "onisall_contract_preparations" ADD CONSTRAINT "onisall_contract_preparations_baseline_fk" FOREIGN KEY ("company_id","intake_id","baseline_id") REFERENCES "public"."onisall_preparation_baselines"("company_id","intake_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_contract_preparations" ADD CONSTRAINT "onisall_contract_preparations_rule_fk" FOREIGN KEY ("company_id","rule_set_id") REFERENCES "public"."onisall_frozen_rule_sets"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
