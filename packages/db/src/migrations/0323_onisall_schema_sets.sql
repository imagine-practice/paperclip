CREATE TABLE "onisall_frozen_schema_set_members" (
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "onisall_frozen_schema_members_position_uq" UNIQUE("company_id","set_id","position"),
	CONSTRAINT "onisall_frozen_schema_members_schema_uq" UNIQUE("company_id","set_id","schema_id"),
	CONSTRAINT "onisall_frozen_schema_members_position" CHECK ("onisall_frozen_schema_set_members"."position" BETWEEN 0 AND 63)
);
--> statement-breakpoint
CREATE TABLE "onisall_frozen_schema_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"manifest" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"schema_count" integer NOT NULL,
	"total_byte_size" integer NOT NULL,
	"purpose" text DEFAULT 'preparation' NOT NULL,
	"execution_admission" text DEFAULT 'not_granted' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_frozen_schema_sets_manifest_uq" UNIQUE("company_id","manifest_sha256"),
	CONSTRAINT "onisall_frozen_schema_sets_scope_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_frozen_schema_sets_shape" CHECK ("onisall_frozen_schema_sets"."purpose" = 'preparation' AND "onisall_frozen_schema_sets"."execution_admission" = 'not_granted'
    AND "onisall_frozen_schema_sets"."schema_count" BETWEEN 1 AND 64 AND "onisall_frozen_schema_sets"."total_byte_size" BETWEEN 1 AND 8388608
    AND "onisall_frozen_schema_sets"."manifest_sha256" ~ '^[0-9a-f]{64}$' AND octet_length("onisall_frozen_schema_sets"."manifest") BETWEEN 1 AND 131072)
);
--> statement-breakpoint
CREATE TABLE "onisall_schema_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"registry_key" text NOT NULL,
	"revision" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onisall_schema_versions_identity_uq" UNIQUE("company_id","registry_key","revision"),
	CONSTRAINT "onisall_schema_versions_scope_uq" UNIQUE("company_id","id"),
	CONSTRAINT "onisall_schema_versions_shape" CHECK (length("onisall_schema_versions"."registry_key") BETWEEN 1 AND 200
    AND length("onisall_schema_versions"."revision") BETWEEN 1 AND 160 AND "onisall_schema_versions"."revision" NOT IN ('latest','main','master','HEAD')
    AND "onisall_schema_versions"."sha256" ~ '^[0-9a-f]{64}$' AND "onisall_schema_versions"."byte_size" BETWEEN 1 AND 1048576
    AND octet_length("onisall_schema_versions"."content") = "onisall_schema_versions"."byte_size")
);
--> statement-breakpoint
ALTER TABLE "onisall_frozen_schema_set_members" ADD CONSTRAINT "onisall_frozen_schema_members_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."onisall_frozen_schema_sets"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_frozen_schema_set_members" ADD CONSTRAINT "onisall_frozen_schema_members_schema_fk" FOREIGN KEY ("company_id","schema_id") REFERENCES "public"."onisall_schema_versions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_frozen_schema_sets" ADD CONSTRAINT "onisall_frozen_schema_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onisall_schema_versions" ADD CONSTRAINT "onisall_schema_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;