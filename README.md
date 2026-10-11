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
cd apps/web && npx playwright test                 # end-to-end journeys per role (needs pnpm dev + fresh seed)
```

## Configuration

Copy `.env.example` to `apps/api/.env`. Optional integrations activate when their keys are present (`GOOGLE_CLIENT_*`, `RAZORPAY_*`, `WHATSAPP_*`, `RESEND_API_KEY`). `DEMO_MODE` must be off in production (the API refuses to start otherwise).
