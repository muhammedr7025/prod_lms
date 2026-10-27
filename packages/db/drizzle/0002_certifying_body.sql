ALTER TABLE "course" ADD COLUMN "awarding_body" text;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "eligibility" text;--> statement-breakpoint
ALTER TABLE "enrollment" ADD COLUMN "awarding_body" text;--> statement-breakpoint
ALTER TABLE "enrollment" ADD COLUMN "body_reg_no" text;--> statement-breakpoint
ALTER TABLE "enrollment" ADD COLUMN "body_fee" bigint;--> statement-breakpoint
ALTER TABLE "enrollment" ADD COLUMN "body_fee_submitted_on" date;