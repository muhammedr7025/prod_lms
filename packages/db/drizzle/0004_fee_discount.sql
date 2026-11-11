CREATE TABLE "fee_discount" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"pct_after" numeric DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"source_name" text,
	"origin" text NOT NULL,
	"approval_id" uuid,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN "discount_kind" text;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN "discount_source" text;--> statement-breakpoint
CREATE INDEX "fee_discount_enrollment_id_index" ON "fee_discount" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "fee_discount_branch_id_granted_at_index" ON "fee_discount" USING btree ("branch_id","granted_at");