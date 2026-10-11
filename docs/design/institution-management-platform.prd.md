# Institution Management Platform: Product Requirements Document

Oct 11, 2026 · @Deepu S Nath

## 1. Overview

The product is a multi-branch Institution Management Platform that takes a learner from first enquiry to course completion on one system: lead capture, admission, fee collection, timetabled classes, attendance, assessments, fee-gated learning content, and a parent view of all of it.

**Problem.** Training institutes with several branches and course batches typically run on spreadsheets, WhatsApp groups and a separate payment tool. Leads leak between sales and admissions, fee dues are chased manually, teachers re-enter marks, and parents have no reliable view. Leadership cannot see revenue, collections or batch utilisation by branch.

**Vision.** One source of truth per institution, where every role sees exactly what it is allowed to see, scoped to its branch, course and batch, and every money-related action is auditable.

### Goals (v1)

- Lead to enrolled student in one continuous flow, with no re-keying of data.
- Fee status drives access: notes and selected content unlock automatically when dues are cleared.
- Teachers run a full academic cycle (attendance, assignments, notes, exams, marks) from one workspace.
- Students and parents see attendance, marks and fees in real time.
- Branch-level and institution-level dashboards for admins and finance.
- p95 page interaction under 200 ms for cached views and API p95 under 300 ms at target load.

### Non-goals (v1)

- Live video classes (integrate Google Meet / Zoom links instead).
- A full LMS with SCORM, proctoring or adaptive learning.
- Payroll and HR for staff.
- Native mobile apps (ship a responsive PWA first).
- Multi-institution SaaS billing; the data model is tenant-ready, but onboarding of other institutions is a later phase.

### Success metrics

| Metric | Target 6 months after launch |
| --- | --- |
| Lead-to-admission conversion visible per salesperson | 100% of leads tracked in-system |
| Median lead first-response time | Under 2 hours |
| Fee collection on or before due date | +20% versus baseline |
| Attendance marked same day | Over 95% of sessions |
| Weekly active parents | Over 60% of enrolled students' parents |
| Manual fee reconciliation effort | Reduced by 70% |

## 2. Critical analysis of the brief

The brief is sound on roles and modules, but eight gaps would cause rework if left open. Each is resolved below with a decision that the rest of this PRD follows.

| # | Gap or risk in the brief | Decision |
| --- | --- | --- |
| 1 | "Branches managed by single or multiple things" is undecided | Model a branch as a scope, not a separate deployment. One database, every row carries `institutionId` and `branchId`. A user can hold roles in several branches. This also makes the platform multi-tenant ready. |
| 2 | Roles are listed as fixed job titles | Use role-based access (RBAC) for *what* a user can do plus scope-based rules (ABAC) for *where*: a teacher can mark attendance only for batches assigned to them; a branch admin sees only their branch. Roles are seeded but permissions are configurable. |
| 3 | "Notes visible only if fees are paid" is ambiguous with instalments | Introduce a **Fee Clearance Policy** per course: options are fully paid, current instalment paid, or paid up to a percentage. Content can also be tagged *always free* (syllabus, orientation). Access is computed server-side and cached, never decided in the browser. |
| 4 | Fee structure is described per course and per batch | Fee Plan is a versioned entity attached to a batch (defaulting from the course): components (tuition, exam, material), instalment schedule, discounts, scholarships, tax, late fee rules. Changing a plan never rewrites invoices already issued. |
| 5 | Payments are not mentioned | Online payments through Razorpay (UPI, cards, netbanking) with webhook reconciliation, plus offline receipts (cash, cheque, bank transfer) recorded by finance with approval. GST-compliant receipts and refunds. |
| 6 | Parent to student relationship | One parent can have several children; one student can have two guardians. Parents log in with their own account, never the student's. |
| 7 | "Admin can do everything" | Separate **Super Admin** (institution owner: settings, branches, roles, audit) from **Branch Administrator** (operations within assigned branches). Destructive and financial overrides require reason codes and appear in the audit log. |
| 8 | Sign-in with Google for students and parents | Many parents do not use Google accounts. Support Google OAuth, email magic link, and phone OTP (WhatsApp/SMS), all through Better Auth. Accounts are invite-only, created at admission; no public sign-up. |

### Other risks flagged

- **Batch transfers and drops** are common in training institutes and break naive fee and attendance models. The data model treats an *Enrollment* (student in a batch) as the unit, with transfer history and pro-rated fee adjustment.
- **Data privacy (DPDP Act 2023, India).** Student and minor data needs consent capture, purpose limitation, and parental consent for under-18 learners.
- **Offline-heavy classrooms.** Attendance marking must tolerate poor connectivity: optimistic UI with a retry queue.
- **Bulk import quality.** Lead CSVs will contain duplicates and bad phone numbers; import needs a preview, validation, and dedup step, not a blind insert.
- **Performance claims need a budget.** Targets are written into section 10 so they can be tested in CI, rather than stated as aspirations.

## 3. Users, roles and permissions

Access = role (what actions) × scope (which institution, branch, course, batch, or own records). Both checks run on the server for every request.

### Roles

| Role | Scope | Core responsibilities |
| --- | --- | --- |
| Super Admin (main admin) | Institution | Settings, branches, roles and permissions, fee policies, audit log, all reports, impersonation (logged) |
| Branch Administrator | One or more branches | Courses, batches, timetables, staff assignment, admissions approval, student records, announcements |
| Salesperson | Assigned branches; own leads by default | Lead import, follow-ups, counselling, admission handoff, own pipeline reports |
| Sales Manager (new) | Branch | Lead assignment and reassignment, team targets, pipeline and conversion reports |
| Finance Manager | One or more branches | Fee plans, invoices, payments, receipts, refunds, discounts approval, dues follow-up, announcements |
| Teacher | Assigned batches | Attendance, assignments, notes, exams, marks, batch announcements, student remarks |
| Student | Own enrollments | Timetable, attendance, notes, assignments, exams, marks, fees, payments |
| Parent / Guardian | Linked children | Read-only view of child's attendance, marks, fees; pay fees; receive alerts |

### Permission matrix (default seed)

C = create, R = read, U = update, D = delete, A = approve. Scope applies on top.

| Resource | Super Admin | Branch Admin | Sales | Finance | Teacher | Student | Parent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Branches, roles, settings | CRUD | R | none | R | none | none | none |
| Courses, batches, timetable | CRUD | CRUD | R | R | R (assigned) | R (own) | R (child) |
| Leads | CRUD | CRUD | CRU (own) | R | none | none | none |
| Admissions | CRUDA | CRUA | CRU | RA (fee step) | none | none | none |
| Fee plans | CRUDA | R | R | CRUD | none | R (own) | R (child) |
| Invoices, payments | RA | R | R (own admissions) | CRUDA | none | R (own), pay | R (child), pay |
| Attendance | R, override | RU | none | none | CRU (assigned) | R (own) | R (child) |
| Assignments, notes | R | R | none | none | CRUD (assigned) | R (if cleared), submit | R (titles only) |
| Exams, marks | R | R, publish | none | none | CRU, submit for publish | R (published) | R (published) |
| Announcements | CRUD | CRUD (branch) | none | CRUD (fee topics) | C (own batches) | R | R |
| Audit log | R | R (branch) | none | R (finance) | none | none | none |

### Rules worth stating explicitly

- **Least privilege by default.** New roles start with nothing; permissions are granted, never inherited implicitly.
- **Marks publishing is two-step.** Teacher submits, Branch Admin (or a designated reviewer) publishes. Students and parents never see draft marks.
- **Discounts above a threshold** (configurable, e.g. 10%) require Finance Manager approval; above a second threshold, Super Admin.
- **Impersonation** ("view as student") is read-only, time-boxed, and logged.
- **Multi-role users** (a teacher who is also a branch admin) switch context with a role switcher; the active role is part of the session and every audit entry.

## 4. Organizational structure

The hierarchy is Institution → Branch → Course offering → Batch → Enrollment. A course is defined once at institution level and *offered* at one or more branches; batches belong to a branch offering. Example: "Digital Marketing" is one course; "DM Batch A, Trivandrum, Jan 2027, Weekday mornings" and "DM Batch B, Kochi, Jan 2027, Weekends" are two batches.

### Entities and rules

- **Institution.** Name, logo, brand colours (themes the UI), GSTIN, academic year settings, default policies.
- **Branch.** Address, contact, GST registration (if separate), rooms and capacity, branch manager. Branch can be active, paused, or archived.
- **Course.** Code, name, category, duration, modality (offline, online, hybrid), syllabus (modules and topics), default fee plan, default grading scheme, fee clearance policy, certificate template.
- **Batch.** Course + branch + start and end dates + capacity + schedule pattern + assigned teachers (primary and substitutes) + room + fee plan (inherited or overridden) + status (planned, open for admission, running, completed, cancelled).
- **Timetable.** Recurring rules (for example Mon/Wed/Fri 9:00 to 11:00) generate concrete **Sessions**. Sessions can be rescheduled, cancelled, or swapped to a substitute teacher without breaking the series. Holidays from the branch calendar suppress sessions automatically.
- **Enrollment.** Student × batch with status (active, on hold, transferred, dropped, completed). All attendance, marks, invoices and content access hang off the enrollment, so a student in two courses has two independent records.

### Scheduling constraints (validated on save)

- No teacher double-booked across branches at the same time (with configurable travel buffer).
- No room double-booked.
- Batch capacity cannot be exceeded at admission; overflow goes to a waitlist.
- Conflicts are shown inline in the timetable editor before save, not after.

&#91;embedded content: institution hierarchy · 5 levels, role scopes\]

A user can hold several memberships, for example Teacher in two batches and Branch Admin in one branch, and switches between them in the header.

## 5. Functional requirements by module

Each module below maps to one backend feature module and one frontend feature folder (section 8). Priorities: **P0** = launch blocker, **P1** = launch or within 4 weeks, **P2** = later.

### 5.0 Every module is a full sub-product

Each module (CRM, Admissions, Academics, Finance, Communications, Administration) is built as a dedicated application inside the platform, not a set of screens bolted onto a shared admin panel. Every module ships with the same eight parts:

| Part | What it means in practice |
| --- | --- |
| Own workspace | Its own sidebar section, home dashboard and keyboard shortcuts, visible only to roles with access |
| Full lifecycle | Create, edit, approve, cancel, reverse and archive for every record, with status history |
| Settings | Module-level configuration (numbering, templates, thresholds, defaults) per institution and branch |
| Reports | Its own reports and exports, filterable by branch, course, batch and date |
| Documents | Its own printable outputs (receipts, report cards, admission forms) from managed templates |
| Permissions | Its own permission set (`finance:payment.collect`, `finance:refund.approve`), assignable per role |
| Audit | Every action logged with actor, before and after values |
| Integration contract | Publishes domain events and exposes read interfaces; never writes another module's tables |

Modules integrate through events, not shared tables. Example: Admissions emits `AdmissionApproved`; Finance listens and creates the fee account and invoice schedule; Communications sends the welcome message with the first invoice attached; Academics adds the student to the batch roster. Each module can be developed, tested and, later, extracted on its own.

### 5.1 Sales CRM and leads

- **P0 Bulk import** of leads from CSV/XLSX: column mapping UI, preview of first 50 rows, Zod validation per row (phone in E.164, email, course interest), duplicate detection by phone or email against existing leads and students, choice to skip, merge, or create. Runs as a background job with progress bar and a downloadable error report.
- **P0 Lead capture** from web forms (public endpoint with captcha and rate limit), manual entry, and later Meta/Google lead ads webhooks (P2).
- **P0 Lead record:** name, phone, email, source, campaign, course interest, preferred branch and batch timing, stage, owner, score, tags, consent flags, full activity timeline.
- **P0 Pipeline stages** (configurable): New → Contacted → Counselled → Demo / Visit scheduled → Negotiation → Admission in progress → Won / Lost (with lost reason). Kanban and table views.
- **P0 Follow-ups:** scheduled tasks with due date and channel (call, WhatsApp, email, visit), reminders, overdue queue on the salesperson dashboard, one-click call and WhatsApp deep links, call outcome logging.
- **P1 Assignment rules:** round robin, by branch, by course, by source; manual reassignment by Sales Manager.
- **P1 Lead scoring** from engagement (responded, visited, demo attended) and fit (course interest matches running batch).
- **P1 Templates** for WhatsApp and email messages with variables.
- **P1 Targets and leaderboard** per salesperson per month.

### 5.2 Admissions

- **P0 Convert lead to admission** in one wizard: student details (prefilled from lead), guardian details, batch selection with live seat availability, fee plan preview with discount request, document upload (ID proof, photo, certificates), consent capture.
- **P0 Approval flow:** salesperson submits → finance verifies fee terms and discount → branch admin approves. Each step can return with comments.
- **P0 On approval:** student and parent accounts created and invited, enrollment created, invoice schedule generated, welcome email/WhatsApp sent, lead marked Won with revenue attributed to the salesperson.
- **P1 Seat hold** with expiry (for example 48 hours) after partial booking payment.
- **P1 Waitlist** with automatic offer when a seat frees up.
- **P1 Admission form link** sent to the applicant to self-fill, then reviewed by sales.

**Admission number and barcode (P0).** On approval every student gets a unique admission number (format configurable, for example `TVM-DM-2027-00142`: branch, course, year, sequence) encoded as a Code 128 barcode and a QR code. The barcode is printed on the admission form, ID card, every invoice and every receipt.

- Scanning it at the finance counter opens the student's fee account instantly; at the front desk it opens the student profile; on a teacher's phone it can mark attendance (P2).
- The QR encodes a signed, opaque token, not personal data, so a photographed ID card leaks nothing.
- Works with any USB or Bluetooth barcode scanner (keyboard-wedge input) and with the phone camera in the PWA.
- Lost ID cards can be reissued; the old code is revoked and stops resolving.

### 5.3 Academics: teacher workspace

- **P0 Attendance:** per session roster, mark all present then toggle exceptions, statuses present, absent, late, excused. Works on mobile with large tap targets. Edit window configurable (for example 48 hours); later edits need admin override with reason. Optional QR self check-in (P2).
- **P0 Assignments:** title, instructions (rich text), attachments, due date, max marks, rubric (P1), late submission policy. Students submit files or text; teacher grades with feedback; plagiarism check is P2.
- **P0 Notes and study material:** files (PDF, slides, video links), organised by syllabus module. Each item has visibility: *always visible*, *fee-gated*, or *scheduled release date*. Files are served through short-lived signed URLs; PDFs can be watermarked with the student's name (P1) to discourage sharing.
- **P0 Exams:** create offline exams (date, max marks, components such as theory/practical) and record marks. **P1 Online quizzes**: MCQ and short answer with auto-grading, time limit, randomised question order, one attempt.
- **P0 Marks entry:** spreadsheet-style grid with keyboard navigation, paste from Excel, validation against max marks, draft autosave, submit for publishing.
- **P1 Grading schemes:** marks to grade mapping, weighted components, pass criteria, generated report card and certificate on completion.
- **P1 Remarks:** teacher notes on a student, private to staff or shared with parent.

### 5.4 Finance module (dedicated)

Finance is a complete accounting-grade sub-product: every rupee has a ledger entry, every collection produces a receipt, and nothing is ever deleted, only reversed. It is used by the finance team at the counter, by students and parents online, and read by every other module through a fee-status interface.

#### Workspace

| Screen | Purpose |
| --- | --- |
| Finance dashboard | Today's collection by method, dues by ageing, expected this week, collection vs target by branch |
| Collection desk | Counter screen: scan barcode or search, see dues, collect, print receipt in under 30 seconds |
| Student fee account | Full ledger per student per enrollment: charges, payments, discounts, refunds, running balance |
| Invoices | Issue, view, reprint, cancel (with credit note), bulk generate for a batch |
| Payments and receipts | Every payment with its tenders, allocation and receipt; reprint and resend |
| Instalments and plans | Fee plans, instalment schedules, per-student restructuring |
| Dues and follow-up | Overdue lists, reminder history, promise-to-pay dates, call notes |
| Discounts, scholarships, waivers | Requests, approvals, impact on revenue |
| Refunds and credit notes | Request, approve, pay out, with reason codes |
| Day book and cash closing | Per counter, per cashier, per day: opening, collections by method, deposits, closing |
| Reconciliation | Match Razorpay settlements and bank deposits to recorded payments |
| Reports | Collection, dues, revenue, GST, discount, refund, cashier and branch reports |
| Settings | Numbering series, receipt and invoice templates, tax rates, late fee rules, approval thresholds, payment methods |

#### Fee structures supported

- **One-time:** full fee due at admission.
- **Instalments:** any number, fixed amounts or percentages, with due dates (for example 40% at admission, 30% in month 2, 30% in month 4).
- **Split plan:** fee divided into two payments, the common case for many students (for example 50% at admission and 50% at mid-course). Offered as a standard plan choice at admission.
- **Custom schedule per student:** finance can restructure one student's remaining balance into new instalments (for example split one overdue instalment into two later ones). Requires approval above a threshold; the original schedule is kept in history.
- **Component-based:** registration, tuition, exam, material and certification fees can each have their own due date and tax rate.

#### Payment scenarios

| Scenario | How the system handles it |
| --- | --- |
| Full payment | Allocated to the instalment(s); invoice marked Paid; receipt issued |
| Partial payment | Any amount above a configurable minimum is accepted. Allocated to the oldest due first; invoice becomes Partially paid; balance stays due on the same date; late fee applies only to the unpaid balance |
| Split tender | One payment made with two or more methods (for example ₹10,000 UPI + ₹5,000 cash). Recorded as one payment with several tender lines; one receipt shows each method |
| One payment, several instalments | Allocated across instalments in order; receipt lists each instalment cleared |
| Overpayment or advance | Excess held as a credit balance on the fee account and auto-applied to the next instalment |
| Sibling payment | A parent pays for two children in one transaction; split by child, one receipt per child (P1) |
| Cheque | Recorded as Pending clearance; content access unlocks only after clearance (configurable); a bounce reverses the allocation and adds a charge |
| Online payment fails or is abandoned | No allocation until the gateway confirms by webhook; the student sees "Payment pending" and can retry |
| Refund or cancellation | Approved refund creates a credit note and a payout entry; balances and receipts recompute |

Allocation order is configurable (oldest due first by default, or by component priority such as registration and tax first). Finance users with `finance:payment.allocate` can allocate manually, with a reason.

#### Collection desk flow

1. Scan the admission barcode, or search by name, phone or admission number.
2. The fee account opens with dues highlighted and a suggested amount (next due).
3. Edit the amount for a partial payment, or add a second tender for a split payment.
4. Enter the reference for non-cash methods (UPI transaction ID, cheque number, bank reference).
5. Confirm. The receipt prints automatically and is sent to the student and parent by WhatsApp and email.

The whole flow is keyboard-operable for counter speed. A cashier can also generate a UPI QR for the exact amount on screen, so the payer scans and pays and the payment confirms by webhook while they wait.

#### Invoices and receipts

- **Two documents, kept distinct.** An *invoice* (GST tax invoice) states what is owed; a *receipt* acknowledges money received. Both are generated as PDFs by the worker from managed templates.
- **Contents:** institution logo and GSTIN, branch address, student name and admission number, the admission barcode, course and batch, line items with tax, amount paid by tender, balance remaining, cashier name, and a verification QR.
- **Formats:** A4, A5, and 80 mm thermal for counter printers. Print opens the browser print dialog with a print-optimised layout; no plugin needed.
- **Reprints** are watermarked "Duplicate" and logged.
- **Students and parents** can view, download and print every invoice and receipt from their portal at any time, plus a full **statement of account**.
- **Notifications carry the document:** the payment confirmation, invoice-issued and due-reminder messages attach the PDF and include a secure link, so a parent can print straight from WhatsApp or email.
- **Verification:** scanning the receipt QR opens a public page confirming the receipt number, amount and date, so forged receipts can be detected.
- **Numbering:** sequential, gap-free series per branch per financial year (for example `TVM/RCPT/2026-27/000184`); cancelled numbers stay in the series as cancelled.

#### Controls

- No delete: payments and invoices are voided or reversed with a reason; the original stays visible.
- Maker-checker approval for discounts, waivers, refunds, voids and restructuring above thresholds.
- Daily cash closing per cashier with denomination count; differences must be explained before the day locks.
- Locked periods: once a month is closed, entries in it need Super Admin approval.
- Settlement reconciliation against Razorpay reports and bank deposits, with unmatched items flagged.
- Export to Tally and accounting CSV; GST summary for filing.

#### Online payments and reminders

- Razorpay checkout (UPI, cards, netbanking, wallets) with signature-verified webhooks and idempotent recording.
- Students and parents can pay the next instalment, any custom amount (partial), or the full balance.
- Automated reminders before and after due dates by email and WhatsApp, with the invoice attached; reminders stop the moment a payment is recorded.

#### Data model additions

`fee_account` (per enrollment), `ledger_entry` (append-only debits and credits), `payment` with `payment_tender` (one row per method in a split payment), `payment_allocation`, `instalment_schedule` and `schedule_revision`, `receipt`, `document_template`, `cash_session`, `settlement`.

### 5.5 Fee-gated content access

Access to a gated item is a pure function evaluated on the server: `canAccess(enrollment, item) = item.visibility == ALWAYS or (item.releasedAt <= now and clearance(enrollment, course.policy))`.

- Clearance is recomputed on each payment or invoice event and stored as a cached flag on the enrollment (`feeCleared`, `clearedUntil`), so list pages never run the fee calculation per row.
- Locked items stay visible as titles with a lock icon and a "Pay now" call to action, which converts better than hiding them.
- Admins can grant a temporary exemption (with expiry and reason), for example for a scholarship pending approval.
- File URLs are signed for 5 minutes and bound to the user; the API never returns a permanent storage URL.

### 5.6 Announcements and notifications

- **P0 Announcements** by Super Admin, Branch Admin and Finance (and teachers for their own batches). Audience targeting: institution, branch, course, batch, role, or a saved segment such as "students with overdue fees". Rich text, attachments, pin, schedule publish, expiry, and read receipts.
- **P0 Notification centre** in-app (bell with unread count, real-time via Server-Sent Events), plus email and WhatsApp channels. Users set channel preferences per category; critical categories (fee due, exam schedule) cannot be fully muted.
- **P1 Acknowledgement required** flag for policy announcements, with a report of who has not acknowledged.

### 5.7 Student portal

- **P0 Dashboard:** today's sessions, attendance percentage with threshold warning, pending assignments, upcoming exams, fee status and next due.
- **P0** Timetable (week and list), attendance history by batch, assignments (submit and view feedback), notes library, published marks with trend, invoices and receipts, pay online.
- **P1** Downloadable report card and certificate; calendar export (ICS).

### 5.8 Parent portal

- **P0** Child switcher for parents of several students. Same read views as the student portal for attendance, marks, timetable and fees; pay fees online.
- **P0 Alerts:** absence on the same day, low attendance (below threshold, for example 75%), marks published, fee due and overdue.
- **P1** Message the class teacher (moderated, staff-hours only), request parent-teacher meeting slot.

### 5.9 Administration and reporting

- **P0** Staff management (invite, assign roles and scopes, deactivate), student directory with filters, document verification, batch transfer and drop workflows.
- **P0 Dashboards** per role: Super Admin sees revenue, collections, dues, admissions, active students by branch; Branch Admin sees operations for their branch; Sales Manager sees funnel and conversions.
- **P1 Report builder** with saved filters and CSV/XLSX export; scheduled email of reports.
- **P0 Audit log** of every create, update, delete, approval, login, export and impersonation, with before/after diff, actor, role, IP and timestamp. Immutable (append-only).

## 6. Additional features proposed

These go beyond the brief. Each is chosen because it closes a loop the core modules open, not as decoration. Phase refers to section 13.

| Feature | Why it matters | Phase |
| --- | --- | --- |
| Command palette (Cmd/Ctrl + K) | Staff jump to any student, lead, batch or action in two keystrokes; biggest daily time-saver for admins | 1 |
| Global search across students, leads, invoices | Front-desk queries ("has Arjun paid?") answered in seconds; Postgres full-text plus trigram | 1 |
| At-risk student alerts | Flags students with falling attendance, missed assignments and overdue fees together; these predict dropouts | 2 |
| WhatsApp Business integration | Primary channel for Indian parents; reminders and receipts have far higher open rates than email | 1 |
| Branch holiday calendar | Auto-suppresses sessions and pauses reminders; avoids false absences | 1 |
| Substitute teacher and leave management | Teacher marks leave, admin assigns substitute; students notified of change | 2 |
| Student ID card and QR | Printable ID with QR used for check-in and front-desk lookup | 2 |
| Certificates with verification URL | Auto-generated on completion; public verify page by certificate number reduces fake certificate risk | 2 |
| Feedback surveys | End-of-module course and teacher feedback; anonymous to teacher, visible to admin | 2 |
| Placement / internship tracker | For vocational courses: companies, drives, offers; strong sales proof point | 3 |
| Alumni referral program | Referral codes on admission; discount for referrer; tracked as a lead source | 3 |
| Data import for go-live | Migrate existing students, batches and outstanding dues from spreadsheets with the same import engine as leads | 1 |
| AI assist (opt-in) | Draft announcements, summarise lead history before a call, generate quiz questions from notes; never auto-sends | 3 |
| Public course catalogue and enquiry form | SEO-friendly, server-rendered pages per course and branch that feed leads straight into the CRM | 2 |
| Multi-language UI (English, Malayalam, Hindi) | Parent portal adoption depends on it | 2 |
| PWA with offline attendance | Installable on phones; attendance queued offline and synced | 2 |

## 7. Data model

PostgreSQL 16 is the system of record. Every tenant-owned table carries `institution_id`; branch-scoped tables also carry `branch_id`. Primary keys are UUID v7 (time-ordered, index-friendly). Money is stored as integer paise (`bigint`), never floats. Soft delete (`deleted_at`) on business entities; hard delete only for GDPR/DPDP erasure jobs.

### Core entities

| Domain | Tables | Key relationships and notes |
| --- | --- | --- |
| Identity | `user`, `account`, `session`, `verification` (Better Auth), `user_profile` | One user, many auth methods. Profile holds name, phone, avatar, locale. |
| Access | `role`, `permission`, `role_permission`, `membership` | `membership` = user + role + scope (`institution_id`, optional `branch_id`, optional `batch_id`). A user has many memberships. |
| Organisation | `institution`, `branch`, `room`, `holiday` | Branch belongs to institution. |
| Catalogue | `course`, `course_module`, `course_offering`, `batch`, `batch_teacher` | Offering = course × branch. Batch belongs to offering. |
| Scheduling | `schedule_rule`, `session` | Rules generate sessions; session has teacher, room, status, override fields. |
| People | `student`, `guardian`, `student_guardian`, `staff` | `student_guardian` is many-to-many with relationship type and primary flag. |
| CRM | `lead`, `lead_activity`, `follow_up`, `lead_import_job`, `pipeline_stage` | Lead links to `student` once converted. Activity is append-only. |
| Admissions | `admission`, `admission_step`, `document` | Admission produces an `enrollment`. |
| Enrollment | `enrollment`, `enrollment_transfer` | Student × batch. Holds cached `fee_cleared`, `attendance_pct`. |
| Attendance | `attendance` | Unique (session\_id, enrollment\_id). Partitioned by month. |
| Learning | `material`, `assignment`, `submission`, `exam`, `exam_component`, `mark`, `grade_scheme` | `mark` has draft/published state; unique (exam\_component\_id, enrollment\_id). |
| Finance | `fee_plan`, `fee_plan_version`, `fee_component`, `instalment`, `invoice`, `invoice_line`, `payment`, `payment_allocation`, `discount`, `refund`, `credit_note` | Payment allocates to invoices via allocation rows; ledger-style, never edit a posted amount. |
| Comms | `announcement`, `announcement_audience`, `announcement_read`, `notification`, `notification_preference`, `message_template` | Fan-out written by a background worker. |
| Platform | `audit_log`, `outbox_event`, `file_object`, `job` | Audit is append-only and partitioned by month. |

### Integrity and indexing rules

- Foreign keys everywhere; composite indexes always lead with `institution_id` (and `branch_id` where present) so tenant filters are index-only.
- Row Level Security (RLS) in Postgres as a second line of defence: each request sets `app.institution_id` and RLS policies reject cross-tenant rows even if application code has a bug.
- Unique constraints encode business rules (one attendance per session per enrollment; one active enrollment per student per batch; invoice number unique per branch per financial year).
- Financial tables are append-only with reversing entries; totals on invoices are derived and checked by a constraint trigger.
- High-volume tables (`attendance`, `audit_log`, `notification`) are range-partitioned by month.

## 8. Technical architecture

Build a **modular monolith**, not microservices: one NestJS API and one worker process from the same codebase, one Next.js app, one Postgres, one Redis, inside a pnpm + Turborepo monorepo. Feature modules have hard boundaries so any of them (notifications, payments, reporting) can be extracted later without rewriting. Microservices at this scale would add network latency, distributed transactions across fees and enrollments, and operational cost with no benefit.

&#91;embedded content: system architecture · modular monolith\]

The browser only ever talks to the Next.js origin; the API and worker share one codebase, one database and one Redis, and both can reach external providers.

### 8.1 Stack decisions

| Layer | Choice | Reason |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | Shared packages, cached builds, one PR changes API and UI together |
| Frontend | Next.js (App Router, React Server Components), TypeScript strict | SSR and streaming, route-level code splitting, ISR for public pages |
| Server state | TanStack Query | Caching, dedupe, background refresh, optimistic updates |
| Client state | URL search params (nuqs) for filters and pagination; Zustand only for small UI state | Shareable, SSR-friendly filters; avoids a global store |
| UI | shadcn/ui + Tailwind CSS + class-variance-authority, Radix primitives, Lucide icons | Owned components, accessible, themeable |
| Forms | React Hook Form + Zod resolver | Same schema validates client and server |
| Tables | TanStack Table with server-side pagination, sorting, filtering; TanStack Virtual for long lists | Handles 10k-row views smoothly |
| Motion | Motion (Framer Motion) with `prefers-reduced-motion` respected | Micro-interactions (section 11) |
| Backend | NestJS on Fastify adapter | Fastify is materially faster than Express under load; Nest gives DI and module structure |
| ORM | Drizzle ORM | Thin SQL layer with no query engine overhead, typed schema shared with contracts, first-class Better Auth adapter. Prisma is the alternative if the team prefers it. |
| Validation | Zod (shared) | One schema per DTO, used by API, client and forms |
| Auth | Better Auth, mounted inside NestJS | Google OAuth, email magic link and OTP, phone OTP, sessions, organisation and admin plugins |
| Database | PostgreSQL 16 with PgBouncer | Relational integrity for money and academics; RLS for tenancy |
| Cache, queues | Redis + BullMQ | Permission cache, rate limits, job queues, SSE pub/sub |
| Files | S3-compatible storage (AWS S3 or Cloudflare R2) + CDN, signed URLs | Cheap, scalable, never served through the API |
| Payments | Razorpay behind a `PaymentGateway` interface | Indian rails; swappable |
| Messaging | Email (Resend or SES), WhatsApp Business API, SMS behind a `NotificationChannel` interface | Swappable providers |
| Search | Postgres full-text + `pg_trgm` (v1); Meilisearch if needed later | No extra infrastructure on day one |

### 8.2 End-to-end type safety

A `packages/contracts` package is the single source of truth for the API surface:

1. Zod schemas for every request and response (`createLeadSchema`, `leadListQuerySchema`, `leadSchema`).
2. A **ts-rest** contract per feature that binds method, path, params, body and responses to those schemas.
3. NestJS controllers implement the contract with the ts-rest Nest adapter, so a route that drifts from the contract fails compilation.
4. The frontend uses the ts-rest client wrapped in TanStack Query hooks, so request and response types are inferred, never hand-written.
5. An OpenAPI document is generated from the same contract for external integrators and API docs.

Result: renaming a field in one schema surfaces type errors in the API, the client hooks and the forms in the same build. tRPC was considered and rejected because it does not fit NestJS's controller model cleanly and offers no REST/OpenAPI surface for integrations.

### 8.3 Monorepo layout

```
apps/
  web/                 Next.js app
  api/                 NestJS HTTP API
  worker/              NestJS standalone app: BullMQ consumers, cron, outbox relay
packages/
  contracts/           Zod schemas + ts-rest contracts (shared)
  db/                  Drizzle schema, migrations, seed
  ui/                  shadcn-based design system with variants
  auth/                Better Auth config, permission definitions (shared)
  config/              eslint, tsconfig, tailwind preset
  utils/               money, dates (IST), phone formatting
```

### 8.4 Frontend: feature-based structure

```
apps/web/src/
  app/                          routes only, thin
    (auth)/sign-in/
    (dashboard)/[branch]/leads/page.tsx
    (public)/courses/[slug]/page.tsx
  features/
    leads/
      api/        query keys, queryOptions, mutation hooks
      components/ LeadTable, LeadKanban, ImportWizard
      hooks/      useLeadFilters
      schemas/    re-exports from contracts + form-only schemas
      server/     server-side prefetch helpers
      index.ts    public API of the feature
    attendance/ fees/ admissions/ academics/ announcements/ ...
  shared/         layout shell, providers, permission guard components
```

Rules enforced by ESLint (`eslint-plugin-boundaries`): a route imports only from a feature's `index.ts`; features never import each other's internals; feature code imports UI only from `@repo/ui`, never directly from Radix or raw styled HTML. This is what keeps the codebase modular as it grows.

### 8.5 Rendering and data fetching

- **Public pages** (course catalogue, enquiry form, certificate verification): static generation with incremental revalidation, cached at the CDN.
- **Authenticated pages:** server components check the session, then prefetch the page's primary queries on the server with TanStack Query and pass them through `HydrationBoundary`. The client hydrates with no loading flash and no duplicate request. Secondary panels stream in with `Suspense` boundaries and skeletons.
- **Mutations** go through TanStack Query (`useMutation`) to the API, with optimistic updates for low-risk actions (marking attendance, moving a lead stage) and pessimistic flows for money.
- **Next.js fetch cache is not used for per-user data.** Caching per-user responses in two layers (Next and TanStack) causes stale-data bugs; TanStack Query is the only client-side cache for authenticated data.
- **Same-origin API.** Next.js rewrites `/api/*` to the NestJS service. Cookies stay first-party, there is no CORS surface, and Better Auth session cookies work without cross-domain configuration.

### 8.6 Caching strategy

Query keys come from a factory per feature (`leadKeys.list(filters)`, `leadKeys.detail(id)`) so invalidation is precise.

| Data | staleTime | Invalidated by |
| --- | --- | --- |
| Reference data (branches, courses, roles, fee plans) | 30 min | Admin mutation on that entity |
| Batch timetable, roster | 5 min | Session or enrollment change |
| Lead lists, dues lists | 30 s | Mutation + SSE event |
| Attendance for today's session | 0 (always refetch on focus) | Optimistic update + SSE |
| Notifications count | Live via SSE | SSE push |
| Current user and permissions | Session lifetime | Role change event forces refetch |

Server side: Redis caches the user's resolved permissions (5 min, evicted on role change), reference data, and dashboard aggregates (60 s). HTTP responses for reference data carry `ETag` so revalidation is a 304. Dashboard counts come from materialised views refreshed by the worker, not from live aggregation on each page load.

### 8.7 Backend: module design and SOLID

Each NestJS feature module follows the same layers:

- **Controller** (thin): implements the ts-rest contract, applies guards, maps to service calls. No business logic.
- **Service / use case**: one class per use case for complex flows (`ApproveAdmissionUseCase`, `RecordPaymentUseCase`), keeping each class single-purpose (S).
- **Repository interface + Drizzle implementation**: services depend on the interface via an injection token, not on Drizzle (D). Tests swap in an in-memory implementation (L).
- **Ports for external systems**: `PaymentGateway`, `NotificationChannel`, `FileStorage`, `MessageTemplateRenderer`. Adding a new provider (for example SMS) means adding a class, not editing existing ones (O).
- **Small, role-specific interfaces** (I): `FeeClearanceReader` is separate from `InvoiceWriter`, so the content module depends only on what it reads.
- **Domain events through a transactional outbox**: `PaymentRecorded`, `AdmissionApproved`, `MarksPublished` are written in the same transaction as the change, then relayed by the worker to queues. This keeps modules decoupled and guarantees that a recorded payment always triggers receipt generation and clearance recompute.
- **Cross-cutting**: global `ZodValidationPipe`, exception filter mapping domain errors to typed API errors, request-scoped context (user, active role, institution, branch, request ID), logging interceptor.

## 9. Security, authentication and compliance

Security is enforced on the API for every request; the frontend only hides what a user cannot use, it never decides access.

### 9.1 Authentication (Better Auth)

- **Methods:** Google OAuth, email magic link, email OTP, phone OTP (WhatsApp first, SMS fallback). Password login is optional and off by default for students and parents.
- **Invite-only.** Accounts are created by admission approval or staff invite. Google sign-in succeeds only if the verified email matches an invited user; unknown emails are rejected, not auto-registered.
- **Sessions:** database-backed sessions with a Redis secondary store for fast lookup; HttpOnly, Secure, SameSite=Lax cookies; 7-day rolling expiry for students and parents, 12 hours for staff; idle timeout 30 minutes for finance and admin roles.
- **2FA (TOTP)** mandatory for Super Admin and Finance Manager, optional for others.
- **Device and session list** per user with remote sign-out; all sessions revoked on role change or deactivation.
- **Account linking:** one user can link Google and phone, so parents who change phones do not lose access.

### 9.2 Authorization

- A `PermissionGuard` on every route reads required permissions declared with a decorator (`@Can('attendance:update')`).
- A `ScopeGuard` / policy layer checks the target resource against the user's active membership scope (branch, batch, own record, linked child). Scope checks are pushed into repository queries (`WHERE branch_id = ANY($scopes)`) so lists cannot leak rows.
- Postgres RLS by `institution_id` as defence in depth.
- IDs are UUIDs; no sequential IDs in URLs, which prevents enumeration.

### 9.3 Application security

- **Input:** Zod validation on every body, query and param; payload size limits; file uploads restricted by MIME sniffing (not extension), size caps, virus scan (ClamAV in the worker) before a file becomes visible.
- **Output:** response schemas strip unknown fields, so internal columns never leak.
- **Headers:** strict Content-Security-Policy with nonces, HSTS, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy.
- **CSRF:** SameSite cookies plus Better Auth's origin checks; state-changing routes reject requests without the expected origin.
- **Rate limiting** (Redis, sliding window): OTP and magic link requests (5 per hour per identifier), login, public enquiry form, bulk imports, exports.
- **Payments:** Razorpay webhook signature verification, idempotency keys on every payment write, amount always computed server-side from the invoice, never trusted from the client.
- **Secrets** in a secret manager, never in the repo; key rotation runbook.
- **Dependencies:** Renovate, `pnpm audit` and SAST (Semgrep or CodeQL) in CI; OWASP ASVS Level 2 as the checklist; external penetration test before launch.

### 9.4 Privacy and compliance (India)

- **DPDP Act 2023:** consent captured at admission with purpose listed; verifiable parental consent for students under 18; data export and erasure requests handled through an admin workflow; data retention policy (for example leads purged 24 months after last activity unless converted).
- **PII protection:** phone, email and ID document numbers encrypted at application level for sensitive fields; masked in lists and logs (`98•••••210`).
- **Exports** of personal data are permission-gated, watermarked with the exporter's name, and logged.
- **GST:** compliant invoice format, HSN/SAC codes, sequential numbering per financial year.
- **Backups:** point-in-time recovery with 30-day retention, encrypted at rest; quarterly restore drill. Data hosted in an Indian region (for example AWS ap-south-1).

## 10. Performance and scalability

Performance is treated as a feature with a budget that CI enforces, not a later optimisation pass. Design target: 50 branches, 50,000 active students, 1,500 concurrent users, with headroom to 10× by adding API replicas and a read replica.

### 10.1 Budgets

| Metric | Budget | How it is checked |
| --- | --- | --- |
| Largest Contentful Paint (4G, mid-range Android) | Under 2.0 s | Lighthouse CI on key routes per PR |
| Interaction to Next Paint | Under 200 ms | Real-user monitoring (web-vitals) |
| Cumulative Layout Shift | Under 0.05 | Lighthouse CI; skeletons sized to content |
| Initial JS per authenticated route | Under 180 KB gzip | `@next/bundle-analyzer` budget check |
| API p95 latency, reads | Under 150 ms | k6 load test in CI against seeded data |
| API p95 latency, writes | Under 300 ms | k6 |
| Bulk import of 10,000 leads | Under 60 s end to end | Worker benchmark |
| Database queries per request | 5 or fewer for list and detail endpoints | Query counter in test logs fails on N+1 |

### 10.2 Frontend techniques

- Server components by default; `"use client"` only at interactive leaves, which keeps JS small.
- Server-side prefetch and hydration (section 8.5) so first paint has data.
- Route-level code splitting; heavy widgets (charts, rich text editor, Excel grid, PDF viewer) loaded with `next/dynamic` only when opened.
- Prefetch on hover and intent for table rows and nav links (`queryClient.prefetchQuery`), so detail pages open instantly.
- Virtualised tables beyond 100 rows; server-side pagination with cursor (keyset) pagination, not offset, for large lists.
- Debounced search (250 ms) with `keepPreviousData` so tables do not flash.
- `next/image` and `next/font` with subsetting; icons tree-shaken.

### 10.3 Backend techniques

- Fastify adapter, JSON serialization with response schemas (faster than generic serialization).
- Keyset pagination and covering indexes on every list endpoint; `EXPLAIN ANALYZE` reviewed for each new query in PR.
- Batch loading to avoid N+1 (Drizzle relational queries or explicit `IN` loads).
- PgBouncer in transaction mode; connection pool sized per replica.
- Read replica for reports and dashboards once write load needs it; reporting queries never hit the primary at peak.
- Redis caching for permissions, reference data and aggregates (section 8.6).
- Everything slow goes to BullMQ: imports, exports, PDF generation (receipts, report cards), notification fan-out, reminders, materialised view refresh. The API returns a job ID; the UI shows progress via SSE.
- Compression (Brotli) and HTTP keep-alive at the load balancer.

### 10.4 Scaling path

1. **Launch:** 2 API replicas, 1 worker, managed Postgres (primary + standby), managed Redis.
2. **Growth:** horizontal API autoscaling on CPU and p95 latency; add read replica; partition high-volume tables (already designed).
3. **Large scale:** extract notifications and reporting into their own services fed by the outbox; consider a dedicated analytics store (ClickHouse) for reports.

The API is stateless (sessions in DB and Redis, files in object storage), so any replica can serve any request.

## 11. UX, design system and micro-interactions

The product should feel calm and fast: dense where staff work all day, simple and reassuring for parents. "Premium" comes from speed, consistency and small, purposeful motion, not from decoration.

### 11.1 Design system rules (`packages/ui`)

- **shadcn/ui is the only component source.** Components are added with the shadcn CLI into `packages/ui`, then extended with `cva` variants. Feature code never styles a raw `<button>` or `<div>` as a component, and never creates a one-off component that duplicates a primitive.
- **Variants over overrides.** Need a destructive, subtle, or icon-only button? Add a `variant` or `size` to `Button`, not a `className` override at the call site. Arbitrary Tailwind values are banned in feature code by lint (`no-arbitrary-value` via eslint-plugin-tailwindcss).
- **Composed patterns** built only from primitives: `DataTable`, `PageHeader`, `StatCard`, `EmptyState`, `FormField`, `ConfirmDialog`, `FilterBar`, `StatusBadge` (variants per domain status: paid, overdue, present, absent, draft, published).
- **Tokens:** CSS variables for colour, radius, spacing, shadow and motion duration; light and dark themes; institution brand colour applied as the primary token at runtime.
- **Storybook** for every primitive and variant, with visual regression tests (Chromatic or Playwright snapshots).

Example variant definition:

```ts
export const statusBadgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    status: {
      paid: 'bg-success/10 text-success',
      overdue: 'bg-destructive/10 text-destructive',
      partial: 'bg-warning/10 text-warning',
      draft: 'bg-muted text-muted-foreground',
    },
  },
  defaultVariants: { status: 'draft' },
});
```

### 11.2 Micro-interactions

| Moment | Interaction | Duration |
| --- | --- | --- |
| Mark attendance | Row toggles with a soft colour fill and a subtle scale tap; counter at the top animates (present 28 → 29) | 150 ms |
| Lead stage change | Kanban card drags with spring physics; column count ticks; optimistic move with undo toast | 200 ms |
| Payment success | Checkmark draws on, receipt card slides up, fee status badge morphs from Overdue to Paid | 400 ms |
| Save in forms | Button shows inline spinner, then a check for 1 s; no full-page loaders | 150 ms |
| Locked content | Lock icon wiggles once on click, then opens the pay sheet | 250 ms |
| Page navigation | Content fades and shifts 4 px; skeletons match final layout exactly | 120 ms |
| Numbers on dashboards | Count-up on first load only, never on refetch | 600 ms |
| Bulk import | Live progress bar with rows processed and errors found | live |
| Destructive actions | Undo toast for 6 s instead of a confirm dialog where reversible | 6 s |

Rules: motion under 300 ms for feedback; every animation respects `prefers-reduced-motion`; motion never blocks input; no animation on data that refetches in the background.

### 11.3 Layout and responsiveness

- **Staff (desktop-first, responsive):** collapsible sidebar, branch and role switcher in the header, command palette, dense tables with saved views, keyboard shortcuts for frequent actions.
- **Teachers (mobile-first for attendance):** bottom navigation on phones, today's sessions as the home screen, one-hand attendance marking.
- **Students and parents (mobile-first):** card-based dashboard, large tap targets (44 px minimum), Pay Now always reachable, child switcher for parents.
- **Breakpoints:** 360, 768, 1024, 1280 px tested; tables collapse to cards below 768 px.

### 11.4 Accessibility

WCAG 2.2 AA: keyboard navigable everywhere (Radix primitives), visible focus rings, 4.5:1 contrast, labelled form errors announced to screen readers, axe checks in CI.

## 12. Quality, DevOps and observability

### 12.1 Non-functional requirements

| Area | Requirement |
| --- | --- |
| Availability | 99.9% monthly for API and web; payment webhooks retried for 72 hours |
| Recovery | RPO 5 minutes (PITR), RTO 1 hour |
| Time zone | All timestamps stored UTC, displayed IST by default, per-branch override |
| Localisation | i18n-ready strings from day one (next-intl); English at launch |
| Browser support | Last 2 versions of Chrome, Edge, Safari, Firefox; Android Chrome on 3 GB RAM devices |
| Audit | Every write audited; audit retained 7 years for finance records |

### 12.2 Testing strategy

- **Unit (Vitest):** domain logic such as fee clearance, instalment generation, late fees, payment allocation, grading. These are pure functions with 95%+ coverage because they handle money.
- **Integration (Vitest + Testcontainers Postgres):** repositories, guards and scope filtering against a real database, including RLS tests that try cross-tenant access.
- **Contract:** the shared ts-rest contracts make type drift a compile error; response schemas validated in tests.
- **E2E (Playwright):** critical journeys per role: import leads, convert to admission, approve, pay online (Razorpay test mode), mark attendance, publish marks, parent sees result.
- **Load (k6):** nightly run against seeded data at target concurrency; regressions over 10% fail the build.
- **Accessibility and visual:** axe in Playwright, Storybook snapshots.

### 12.3 CI/CD

- GitHub Actions with Turborepo remote cache: lint, typecheck, unit, integration, build, bundle budget, Lighthouse CI, E2E on preview.
- Preview environment per pull request (web + API + seeded database branch).
- Database migrations with Drizzle Kit, reviewed in PR, applied by the pipeline before deploy; expand-and-contract pattern for zero-downtime changes.
- Deploy: containers on AWS (ECS Fargate) or a managed platform in the Mumbai region; blue-green or rolling deploys; feature flags for risky releases.

### 12.4 Observability

- OpenTelemetry traces from Next.js server through NestJS to Postgres and Redis, with request ID propagated to logs.
- Structured JSON logs (pino) with PII redaction.
- Error tracking with Sentry (frontend and backend, source maps uploaded).
- Dashboards and alerts: API p95, error rate, queue depth and age, failed webhooks, failed notifications, DB CPU and slow queries.
- Business alerts: payment webhook failures, reminder jobs not run, sudden drop in attendance marking.

## 13. Release plan and open questions

Ship in four phases over roughly 7 months with a team of 2 frontend, 2 backend, 1 full-stack lead, 1 designer and 1 QA. The MVP goes live at one pilot branch before rollout, because fee and attendance data errors are expensive to fix after parents start using the system. Durations are estimates to validate in sprint planning.

&#91;embedded content: roadmap · 4 phases, 3 gates\]

Everything marked P0 in section 5 ships in Phase 1; P1 items land in Phase 1 or early Phase 2, and the additional features in section 6 follow their listed phase.

### Open questions

- [ ] Is GST registration per branch or one GSTIN for the institution? This changes invoice numbering and reports.
- [ ] Which fee clearance policy is the default: fully paid, or current instalment paid?
- [ ] Do any courses have students under 18? If yes, parental consent flow is P0.
- [ ] Is an existing WhatsApp Business account and approved template set available?
- [ ] Payment gateway: Razorpay assumed; confirm, or is there an existing contract with another provider?
- [ ] Do teachers work across branches on the same day (affects travel buffer in scheduling)?
- [ ] What data must be migrated at go-live (students, outstanding dues, historical marks)?
- [ ] Should the platform be built multi-tenant from day one for resale to other institutions? The data model supports it; onboarding and billing would add roughly 6 weeks.
- [ ] Branding: one brand for all branches, or per-branch sub-brands?
