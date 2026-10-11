CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"branch_ids" uuid[] DEFAULT '{}' NOT NULL,
	"scope_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope_kind" text NOT NULL,
	"surface" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_membership_id" uuid,
	"active_branch_id" uuid,
	"impersonated_by" uuid,
	"read_only" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"auth_method" text,
	"two_factor_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "staff_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"home_branch_id" uuid,
	"title" text,
	"employee_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"on_site_days" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone_number" text,
	"phone_number_verified" boolean DEFAULT false,
	"two_factor_enabled" boolean DEFAULT false,
	"kind" text DEFAULT 'staff' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_phoneNumber_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"offering_id" uuid,
	"code" text NOT NULL,
	"name" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"capacity" integer NOT NULL,
	"schedule_label" text,
	"room_id" uuid,
	"fee_plan_id" uuid,
	"mode" text DEFAULT 'offline' NOT NULL,
	"meet_link" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"phone" text,
	"email" text,
	"gstin" text,
	"gstin_note" text,
	"manager_user_id" uuid,
	"opened_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"status_note" text,
	"monthly_target" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"subject_name" text NOT NULL,
	"room_id" uuid,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"mode" text DEFAULT 'offline' NOT NULL,
	"kind" text DEFAULT 'timetabled' NOT NULL,
	"adhoc_type" text,
	"adhoc_reason" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"topic" text,
	"substitute_for_user_id" uuid,
	"flag" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"attendance_submitted_at" timestamp with time zone,
	"attendance_submitted_by" uuid,
	"subject_taught" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"duration_months" integer NOT NULL,
	"modality" text NOT NULL,
	"description" text,
	"clearance_policy" jsonb,
	"grade_scheme" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_offering" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"default_fee_plan_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_subject" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"branch_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"components" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"gst_rate" numeric DEFAULT 18 NOT NULL,
	"early_pay_discount_pct" numeric DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holiday" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"gstin" text,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"logo_file_id" uuid,
	"brand_color" text DEFAULT '#4f9d68' NOT NULL,
	"academic_year_label" text NOT NULL,
	"academic_year_start" date NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"subject_id" uuid,
	"subject_name" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"lead_id" uuid,
	"sales_user_id" uuid NOT NULL,
	"student_name" text NOT NULL,
	"student_phone" text,
	"student_email" text,
	"student_dob" date,
	"student_address" text,
	"guardian_name" text,
	"guardian_relationship" text,
	"guardian_phone" text,
	"guardian_email" text,
	"batch_id" uuid NOT NULL,
	"fee_plan_id" uuid NOT NULL,
	"discount_pct" numeric DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"quote" jsonb,
	"consent" jsonb,
	"referral_code" text,
	"waitlist" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"needs_super_admin" boolean DEFAULT false NOT NULL,
	"finance_verified_by" uuid,
	"finance_verified_at" timestamp with time zone,
	"super_admin_approved_by" uuid,
	"super_admin_approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"returned_by" uuid,
	"returned_at" timestamp with time zone,
	"returned_to" text,
	"return_note" text,
	"admission_no" text,
	"student_id" uuid,
	"enrollment_id" uuid,
	"seat_hold_until" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admission_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admission_id" uuid NOT NULL,
	"step" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"assignee_label" text,
	"strategy" text DEFAULT 'round_robin' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"fallback" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"file_id" uuid,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_on" date NOT NULL,
	"left_on" date,
	"fee_plan_id" uuid,
	"fee_plan_name" text,
	"fee_total" bigint DEFAULT 0 NOT NULL,
	"discount_pct" numeric DEFAULT 0 NOT NULL,
	"fee_cleared" boolean DEFAULT false NOT NULL,
	"cleared_until" date,
	"clearance_reason" text,
	"exempt_until" date,
	"exempt_reason" text,
	"attendance_pct" integer DEFAULT 100 NOT NULL,
	"credit_balance" bigint DEFAULT 0 NOT NULL,
	"admission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_transfer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_enrollment_id" uuid NOT NULL,
	"to_enrollment_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"reason" text NOT NULL,
	"adjustment" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"source" text NOT NULL,
	"campaign" text,
	"course_id" uuid,
	"preferred_branch_id" uuid,
	"preferred_timing" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"lost_reason" text,
	"owner_user_id" uuid,
	"score" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"consent_whatsapp" boolean DEFAULT false NOT NULL,
	"consent_email" boolean DEFAULT false NOT NULL,
	"consent_captured_at" timestamp with time zone,
	"responded" boolean DEFAULT false NOT NULL,
	"visited" boolean DEFAULT false NOT NULL,
	"demo_attended" boolean DEFAULT false NOT NULL,
	"first_response_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"next_follow_up_note" text,
	"student_id" uuid,
	"admission_id" uuid,
	"import_job_id" uuid,
	"assigned_by_rule_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_import_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_id" uuid,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"headers" text[] DEFAULT '{}' NOT NULL,
	"mapping" jsonb,
	"dup_strategy" text DEFAULT 'merge' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_leads" integer DEFAULT 0 NOT NULL,
	"duplicate_students" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variables" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_template_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sales_target" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"month" date NOT NULL,
	"target_admissions" integer NOT NULL,
	"target_revenue" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"user_id" uuid,
	"admission_no" text,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"dob" date,
	"gender" text,
	"address" text,
	"photo_file_id" uuid,
	"card_token" text,
	"card_issued_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_admissionNo_unique" UNIQUE("admission_no"),
	CONSTRAINT "student_cardToken_unique" UNIQUE("card_token")
);
--> statement-breakpoint
CREATE TABLE "student_guardian" (
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	CONSTRAINT "student_guardian_student_id_guardian_id_pk" PRIMARY KEY("student_id","guardian_id")
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"amount" bigint,
	"pct" numeric,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "cash_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"counter_name" text NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_cash" bigint DEFAULT 0 NOT NULL,
	"deposited" bigint DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"denominations" jsonb,
	"counted" bigint,
	"expected_cash" bigint,
	"difference" bigint,
	"explanation" text,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"invoice_id" uuid,
	"enrollment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "day_close" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "doc_sequence" (
	"scope_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"period" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "doc_sequence_scope_id_doc_type_period_pk" PRIMARY KEY("scope_id","doc_type","period")
);
--> statement-breakpoint
CREATE TABLE "dues_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text,
	"note" text,
	"promise_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"purpose" text NOT NULL,
	"gateway" text NOT NULL,
	"external_order_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_order_externalOrderId_unique" UNIQUE("external_order_id")
);
--> statement-breakpoint
CREATE TABLE "instalment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"label" text NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"paid" bigint DEFAULT 0 NOT NULL,
	"pending_paid" bigint DEFAULT 0 NOT NULL,
	"late_fee" bigint DEFAULT 0 NOT NULL,
	"waived" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"instalment_id" uuid,
	"number" text NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal" bigint NOT NULL,
	"tax" bigint NOT NULL,
	"total" bigint NOT NULL,
	"paid" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"credit_note_id" uuid,
	"reprint_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"invoice_id" uuid,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" bigint NOT NULL,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"cash_session_id" uuid,
	"received_by" uuid,
	"idempotency_key" text,
	"excess_credit" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gatewayPaymentId_unique" UNIQUE("gateway_payment_id"),
	CONSTRAINT "payment_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payment_allocation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"invoice_id" uuid,
	"amount" bigint NOT NULL,
	"reversed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_tender" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"reference" text,
	"cheque_status" text,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "period_lock" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"month" date NOT NULL,
	"status" text DEFAULT 'locked' NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" uuid,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text
);
--> statement-breakpoint
CREATE TABLE "receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reprint_count" integer DEFAULT 0 NOT NULL,
	"voided" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp with time zone,
	"verify_token" text NOT NULL,
	CONSTRAINT "receipt_paymentId_unique" UNIQUE("payment_id"),
	CONSTRAINT "receipt_number_unique" UNIQUE("number"),
	CONSTRAINT "receipt_verifyToken_unique" UNIQUE("verify_token")
);
--> statement-breakpoint
CREATE TABLE "schedule_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"rows" jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	"external_id" text NOT NULL,
	"settled_on" date NOT NULL,
	"amount" bigint NOT NULL,
	"fees" bigint DEFAULT 0 NOT NULL,
	"utr" text,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_externalId_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "settlement_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"settlement_id" uuid NOT NULL,
	"gateway_payment_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"notes" text,
	"matched_payment_id" uuid,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_event_externalId_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"due_at" timestamp with time zone NOT NULL,
	"max_marks" integer NOT NULL,
	"late_policy" text DEFAULT 'minus_10_per_day' NOT NULL,
	"rubric" text,
	"status" text DEFAULT 'open' NOT NULL,
	"extended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"source" text DEFAULT 'teacher' NOT NULL,
	"marked_by" uuid,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"override_reason" text
);
--> statement-breakpoint
CREATE TABLE "exam" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"start_time" text,
	"room" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"return_note" text,
	"returned_at" timestamp with time zone,
	"returned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_component" (
	"id" uuid PRIMARY KEY NOT NULL,
	"exam_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"max_marks" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mark" (
	"id" uuid PRIMARY KEY NOT NULL,
	"exam_id" uuid NOT NULL,
	"exam_component_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"value" numeric,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"module" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"visibility" text NOT NULL,
	"release_at" timestamp with time zone,
	"file_id" uuid,
	"url" text,
	"meta" text,
	"uploaded_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"material_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text,
	"file_id" uuid,
	"is_late" boolean DEFAULT false NOT NULL,
	"late_days" integer DEFAULT 0 NOT NULL,
	"marks" numeric,
	"final_marks" numeric,
	"feedback" text,
	"graded_at" timestamp with time zone,
	"graded_by" uuid,
	"released" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"branch_id" uuid,
	"author_user_id" uuid NOT NULL,
	"author_role_key" text NOT NULL,
	"kicker" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb NOT NULL,
	"publish_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"ack_required" boolean DEFAULT false NOT NULL,
	"also_whatsapp" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement_recipient" (
	"announcement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	CONSTRAINT "announcement_recipient_announcement_id_user_id_pk" PRIMARY KEY("announcement_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text NOT NULL,
	"role_key" text,
	"role_label" text,
	"action" text NOT NULL,
	"action_kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"entity_label" text,
	"before" jsonb,
	"after" jsonb,
	"summary" text,
	"ip" text,
	"branch_id" uuid,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "file_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"purpose" text NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_object_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"entity_type" text,
	"entity_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "notification_preference_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "outbound_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"to_address" text NOT NULL,
	"to_user_id" uuid,
	"template" text,
	"subject" text,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"handled" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guardian_user_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"teacher_user_id" uuid,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderated_by" uuid,
	"reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ptm_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guardian_user_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"preferred_slot" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_offering_id_course_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."course_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session" ADD CONSTRAINT "class_session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session" ADD CONSTRAINT "class_session_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_subject" ADD CONSTRAINT "course_subject_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan" ADD CONSTRAINT "fee_plan_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_assignment" ADD CONSTRAINT "teacher_assignment_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_event" ADD CONSTRAINT "admission_event_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardian" ADD CONSTRAINT "student_guardian_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardian" ADD CONSTRAINT "student_guardian_guardian_id_guardian_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardian"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_tender" ADD CONSTRAINT "payment_tender_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_item" ADD CONSTRAINT "settlement_item_settlement_id_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_component" ADD CONSTRAINT "exam_component_exam_id_exam_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exam"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "membership_user_id_index" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_user_id_role_id_index" ON "membership" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_institution_id_key_index" ON "role" USING btree ("institution_id","key");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_kind_index" ON "user" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_branch_id_code_index" ON "batch" USING btree ("branch_id","code");--> statement-breakpoint
CREATE INDEX "batch_status_index" ON "batch" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_institution_id_code_index" ON "branch" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "class_session_branch_id_date_index" ON "class_session" USING btree ("branch_id","date");--> statement-breakpoint
CREATE INDEX "class_session_batch_id_date_index" ON "class_session" USING btree ("batch_id","date");--> statement-breakpoint
CREATE INDEX "class_session_teacher_user_id_date_index" ON "class_session" USING btree ("teacher_user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "course_institution_id_code_index" ON "course" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_course_id_branch_id_index" ON "course_offering" USING btree ("course_id","branch_id");--> statement-breakpoint
CREATE INDEX "holiday_date_index" ON "holiday" USING btree ("date");--> statement-breakpoint
CREATE INDEX "leave_user_id_date_index" ON "leave" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "leave_branch_id_status_index" ON "leave" USING btree ("branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "room_branch_id_name_index" ON "room" USING btree ("branch_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_assignment_batch_id_teacher_user_id_index" ON "teacher_assignment" USING btree ("batch_id","teacher_user_id");--> statement-breakpoint
CREATE INDEX "teacher_assignment_teacher_user_id_index" ON "teacher_assignment" USING btree ("teacher_user_id");--> statement-breakpoint
CREATE INDEX "admission_branch_id_status_index" ON "admission" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "admission_event_admission_id_index" ON "admission_event" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "document_owner_type_owner_id_index" ON "document" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "enrollment_batch_id_index" ON "enrollment" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "enrollment_student_id_index" ON "enrollment" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "enrollment_branch_id_status_index" ON "enrollment" USING btree ("branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_active_unique" ON "enrollment" USING btree ("student_id","batch_id") WHERE "enrollment"."status" = 'active';--> statement-breakpoint
CREATE INDEX "follow_up_owner_user_id_status_due_at_index" ON "follow_up" USING btree ("owner_user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "lead_branch_id_stage_index" ON "lead" USING btree ("branch_id","stage");--> statement-breakpoint
CREATE INDEX "lead_owner_user_id_index" ON "lead" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "lead_phone_index" ON "lead" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "lead_email_index" ON "lead" USING btree ("email");--> statement-breakpoint
CREATE INDEX "lead_name_trgm" ON "lead" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "lead_activity_lead_id_created_at_index" ON "lead_activity" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_target_user_id_month_index" ON "sales_target" USING btree ("user_id","month");--> statement-breakpoint
CREATE INDEX "student_branch_id_index" ON "student" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "student_phone_index" ON "student" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "student_name_trgm" ON "student" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_status_level_index" ON "approval_request" USING btree ("status","level");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_branch_id_counter_name_date_index" ON "cash_session" USING btree ("branch_id","counter_name","date");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_branch_id_fy_seq_index" ON "credit_note" USING btree ("branch_id","fy","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "day_close_branch_id_date_index" ON "day_close" USING btree ("branch_id","date");--> statement-breakpoint
CREATE INDEX "dues_activity_enrollment_id_created_at_index" ON "dues_activity" USING btree ("enrollment_id","created_at");--> statement-breakpoint
CREATE INDEX "instalment_enrollment_id_index" ON "instalment" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "instalment_branch_id_due_date_index" ON "instalment" USING btree ("branch_id","due_date");--> statement-breakpoint
CREATE INDEX "invoice_enrollment_id_index" ON "invoice" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "invoice_branch_id_issue_date_index" ON "invoice" USING btree ("branch_id","issue_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_branch_id_fy_seq_index" ON "invoice" USING btree ("branch_id","fy","seq");--> statement-breakpoint
CREATE INDEX "ledger_entry_enrollment_id_at_index" ON "ledger_entry" USING btree ("enrollment_id","at");--> statement-breakpoint
CREATE INDEX "payment_enrollment_id_index" ON "payment" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "payment_branch_id_received_at_index" ON "payment" USING btree ("branch_id","received_at");--> statement-breakpoint
CREATE INDEX "payment_allocation_payment_id_index" ON "payment_allocation" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_instalment_id_index" ON "payment_allocation" USING btree ("instalment_id");--> statement-breakpoint
CREATE INDEX "payment_tender_payment_id_index" ON "payment_tender" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "period_lock_branch_id_month_index" ON "period_lock" USING btree ("branch_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_branch_id_fy_seq_index" ON "receipt" USING btree ("branch_id","fy","seq");--> statement-breakpoint
CREATE INDEX "settlement_item_settlement_id_index" ON "settlement_item" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "assignment_batch_id_index" ON "assignment" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_session_id_enrollment_id_index" ON "attendance" USING btree ("session_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "attendance_enrollment_id_index" ON "attendance" USING btree ("enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_batch_id_name_index" ON "exam" USING btree ("batch_id","name");--> statement-breakpoint
CREATE INDEX "exam_branch_id_status_index" ON "exam" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "exam_component_exam_id_index" ON "exam_component" USING btree ("exam_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mark_exam_component_id_enrollment_id_index" ON "mark" USING btree ("exam_component_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "mark_exam_id_index" ON "mark" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "material_batch_id_index" ON "material" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "material_branch_id_index" ON "material" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "material_access_material_id_index" ON "material_access" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "material_access_at_index" ON "material_access" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_assignment_id_enrollment_id_index" ON "submission" USING btree ("assignment_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "announcement_branch_id_publish_at_index" ON "announcement" USING btree ("branch_id","publish_at");--> statement-breakpoint
CREATE INDEX "announcement_recipient_user_id_index" ON "announcement_recipient" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_index" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_index" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_branch_id_at_index" ON "audit_log" USING btree ("branch_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_index" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "notification_user_id_created_at_index" ON "notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_message_created_at_index" ON "outbound_message" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbound_message_to_user_id_index" ON "outbound_message" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "outbox_unprocessed" ON "outbox_event" USING btree ("occurred_at") WHERE "outbox_event"."processed_at" is null;