CREATE TABLE "onisall_frozen_rule_set_members" (
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "onisall_frozen_rule_members_position_uq" UNIQUE("company_id","set_id","position"),
	CONSTRAINT "onisall_frozen_rule_members_rule_uq" UNIQUE("company_id","set_id","rule_id"),
	CONSTRAINT "onisall_frozen_rule_members_position" CHECK ("onisall_frozen_rule_set_members"."position" BETWEEN 0 AND 255)
);
--> statement-breakpoint
CREATE TABLE "onisall_frozen_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"schema_set_id" uuid NOT NULL,
	"manifest" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"asset_count" integer NOT NULL,
	"total_byte_size" integer NOT NULL,
	"purpose" text DEFAULT 'preparation' NOT NULL,
	"execution_admission" text DEFAULT 'not_granted' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_frozen_rule_sets_manifest_uq" UNIQUE("company_id","manifest_sha256"),
	CONSTRAINT "onisall_frozen_rule_sets_scope_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_frozen_rule_sets_shape" CHECK ("onisall_frozen_rule_sets"."purpose" = 'preparation' AND "onisall_frozen_rule_sets"."execution_admission" = 'not_granted'
    AND "onisall_frozen_rule_sets"."asset_count" BETWEEN 4 AND 256 AND "onisall_frozen_rule_sets"."total_byte_size" BETWEEN 4 AND 268435456
    AND "onisall_frozen_rule_sets"."manifest_sha256" ~ '^[0-9a-f]{64}$' AND octet_length("onisall_frozen_rule_sets"."manifest") BETWEEN 1 AND 262144)
);
--> statement-breakpoint
CREATE TABLE "onisall_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"registry_key" text NOT NULL,
	"revision" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"descriptor" text,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_rule_versions_identity_uq" UNIQUE("company_id","kind","registry_key","revision"),
	CONSTRAINT "onisall_rule_versions_scope_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_rule_versions_shape" CHECK ("onisall_rule_versions"."kind" IN ('check','command','runtime','policy')
    AND length("onisall_rule_versions"."registry_key") BETWEEN 1 AND 200 AND length("onisall_rule_versions"."revision") BETWEEN 1 AND 160
    AND "onisall_rule_versions"."revision" NOT IN ('latest','main','master','HEAD') AND "onisall_rule_versions"."sha256" ~ '^[0-9a-f]{64}$'
    AND "onisall_rule_versions"."byte_size" BETWEEN 1 AND 268435456
    AND ("onisall_rule_versions"."kind" = 'runtime' OR ("onisall_rule_versions"."kind" = 'check' AND "onisall_rule_versions"."byte_size" <= 1048576)
      OR ("onisall_rule_versions"."kind" IN ('command','policy') AND "onisall_rule_versions"."byte_size" <= 65536))
    AND (("onisall_rule_versions"."kind" = 'check' AND "onisall_rule_versions"."descriptor" IS NOT NULL AND octet_length("onisall_rule_versions"."descriptor") BETWEEN 1 AND 4096)
      OR ("onisall_rule_versions"."kind" <> 'check' AND "onisall_rule_versions"."descriptor" IS NULL))
    AND "onisall_rule_versions"."provider" IN ('local_disk','s3') AND "onisall_rule_versions"."object_key" LIKE "onisall_rule_versions"."company_id"::text || '/onisall-rules/v1/%')
);
--> statement-breakpoint
ALTER TABLE "onisall_frozen_rule_set_members" ADD CONSTRAINT "onisall_frozen_rule_members_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."onisall_frozen_rule_sets"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_frozen_rule_set_members" ADD CONSTRAINT "onisall_frozen_rule_members_rule_fk" FOREIGN KEY ("company_id","rule_id") REFERENCES "public"."onisall_rule_versions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_frozen_rule_sets" ADD CONSTRAINT "onisall_frozen_rule_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_frozen_rule_sets" ADD CONSTRAINT "onisall_frozen_rule_sets_schema_fk" FOREIGN KEY ("company_id","schema_set_id") REFERENCES "public"."onisall_frozen_schema_sets"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_rule_versions" ADD CONSTRAINT "onisall_rule_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;