# Exatech Institution Management Platform

One system from enquiry to completion — leads, admissions, fees, timetables, attendance, assignments, marks and fee-gated learning material — for eight roles, each scoped to its branch and batch.

Built from the Exatech PRD (`docs/design/exatech-prd.html`) and the clickable prototype (`docs/design/exatech-platform.prototype.html`).

## Quick start

Prerequisites: Node ≥ 22.12, pnpm 10, PostgreSQL 16, Redis, MinIO (S3) and Mailpit — via Homebrew services or `docker compose up -d` (see `docker-compose.yml`).

```bash
pnpm install
pnpm setup:local   # builds packages, creates the DB, migrates, seeds demo data, generates seeded files
pnpm dev           # API on :4300 (with worker loops), web on :3300
```

Open http://localhost:3300 and pick a demo persona on the sign-in page (DEMO_MODE). Email goes to Mailpit (http://localhost:8025); WhatsApp/SMS go to the dev outbox (http://localhost:3300/dev/outbox).

| Persona | Role | Lands on |
| --- | --- | --- |
| Deepu S Nath | Super Admin (institution) | Overview |
| Priya Varghese | Branch Administrator, Trivandrum (+ Teacher DA-C) | Branch operations |
| Meera Pillai | Salesperson (own leads) | Pipeline |
| Sanjay Kumar | Sales Manager, Trivandrum (+ Teacher FS-B) | Funnel |
| Joseph Mathew | Finance Manager, Trivandrum · Kochi | Finance dashboard |
| Nithin Raj | Teacher DM-A · DM-B | Today (mobile) |
| Anjali Menon | Student DM-A | Home (mobile) |
| Suresh Menon | Parent of Anjali and Rohan | Home (mobile) |

## What it does

45 screens across eight roles, all backed by the API (no mock data):

- **Super Admin** — institution overview, branches & rooms, staff & teachers (invite, memberships = role × scope, leave), roles & permissions matrix, settings (brand theme with contrast check, numbering patterns, 2FA and session policy), audit log, read-only impersonation.
- **Branch Administrator** — branch operations (today's sessions, at-risk students, leave approvals, ad-hoc sessions, parent message moderation and PTM requests), courses & batches, timetable with room/teacher clash detection and substitutes, admissions approval (with waitlist when a batch is full), students (profile drawer, ID cards with barcode, batch transfer with pro-rated adjustment, CSV import), notes & material visibility, marks publishing, announcements with acknowledgement.
- **Sales / Sales Manager** — funnel, pipeline (drag between stages with undo), leads with dedupe, follow-ups, lead import wizard, assignment rules (round robin), targets & leaderboard, the five-step admission wizard.
- **Finance / Cashier** — dashboard, collection desk (split tenders, cheques), student fee accounts and statements, invoices & receipts (GST, PDFs with QR verification), dues & follow-up, day book & closing, reconciliation, finance settings; discount/waiver/refund approvals.
- **Teacher** (phone) — today, attendance (offline queue, QR self check-in, 48 h edit window), cover another class, marks entry & exams, assignments with late penalty, notes upload with visibility, leave, parent messages and PTM requests.
- **Student / Parent** (phone) — fee-gated notes, pay online (Razorpay or the sandbox gateway), receipts, work submissions, marks & report card PDF, timetable with ICS export; parents switch children, pay for several at once, see alerts, message the class teacher (moderated) and request PTM slots.

## Architecture

```
apps/
  web/        Next.js 15 (App Router, RSC prefetch + TanStack Query hydration, Tailwind 4, Radix)
  api/        NestJS 11 on Fastify — modular monolith; same codebase runs the worker (outbox relay,
              message dispatcher, BullMQ jobs). Better Auth mounted at /api/auth.
packages/
  domain/     Pure business rules (money, IST dates, fee clearance, allocation, late fee, numbering,
              timetable conflicts, marks, attendance, lead assignment) — unit tested
  db/         Drizzle schema (72 tables), migrations, realistic seed
  contracts/  Zod route contracts shared by API and web, permission catalogue, screens/nav, events
  ui/         Design system components (Industry "blueprint" style, prototype green theme)
```

- **Access = role × scope**, enforced by a global API guard on every request (session → membership → permissions → branch/batch/own/child scope). The UI only hides what the server refuses.
- **Invite-only identity**: Google, email magic link or phone OTP; mandatory TOTP 2FA for Super Admin and Finance; staff sessions 12 h with 30-min idle timeout; read-only, 15-minute, audited impersonation.
- **Events**: modules integrate through domain events — in-transaction subscribers for consistency, a transactional outbox for side effects (notifications, WhatsApp/email, PDFs).
- **Finance**: integer paise, append-only ledger (DB trigger), gap-free document numbering per branch per FY, idempotent payments and webhooks, fee clearance cached on the enrollment and recomputed on every payment.
- **Realtime**: Server-Sent Events push notifications and query invalidations.
- **Integrations** behind ports with dev sandboxes: Razorpay (sandbox gateway when unconfigured), WhatsApp Business (dev outbox), email (SMTP/Mailpit or Resend), S3 (MinIO).

See `CLAUDE.md` for engineering conventions.

## Tests

```bash
pnpm --filter @exatech/domain test                 # business-rule unit tests
cd apps/web && npx playwright test                 # 79 end-to-end tests, incl. a crawl of every screen for every persona
```

The Playwright specs reseed the database themselves (each spec starts from the demo seed), so they need a running API and web (`pnpm dev`, or a production build: `cd apps/web && npx next build && npx next start --port 3300`). `pnpm db:seed` resets the demo data by hand.

## Performance budget

First-load JS is under the PRD's 180 kB (gzip) on every route except `/sales/pipeline` (214 kB — the spring-physics card drag). `node apps/web/scripts/check-bundle.mjs <next build output>` enforces it; CI runs it after `next build`.

## Configuration

Copy `.env.example` to `apps/api/.env`. Optional integrations activate when their keys are present (`GOOGLE_CLIENT_*`, `RAZORPAY_*`, `WHATSAPP_*`, `RESEND_API_KEY`). `DEMO_MODE` must be off in production (the API refuses to start otherwise).

## Not yet verified / known gaps

- **Live integrations** are written against the providers' APIs but exercised only through their dev stand-ins: Razorpay (sandbox gateway + signed webhook), Google sign-in, WhatsApp Business (dev outbox) and Resend. Configure real keys and run a payment, a Google sign-in and a WhatsApp template end to end before go-live.
- **CI** (`.github/workflows/ci.yml`) has not been run on GitHub yet; the same steps pass locally.
- **QR check-in geofencing** is not implemented: the rotating code proves presence in the room, location is not checked.

