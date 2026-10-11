# Exatech Institution Management Platform — engineering guide

One system from enquiry to completion: leads → admissions → fees → timetable → attendance → marks → fee-gated notes, for 8 roles scoped by branch/batch.

**Source of truth for requirements & UI**
- `docs/design/exatech-prd.html` — the PRD (v1.0). Business rules in §12 are non-negotiable.
- `docs/design/exatech-platform.prototype.html` — the clickable prototype. **Every screen must match its markup, copy, layout and states.** Search it for `data-screen-label="…"` to find a screen. (The trailing script is truncated; behaviour comes from the PRD.)
- `docs/design/institution-management-platform.prd.md` — the longer source PRD (finance scenarios, data model, NFRs).

## Stack

pnpm + Turborepo monorepo. TypeScript strict everywhere.

| Path | What |
| --- | --- |
| `packages/domain` | Pure business rules (money in paise, IST dates, fee clearance, allocation, late fee, numbering, timetable conflicts, marks/grades, attendance, lead rules). Unit-tested with vitest. **Use these, never re-implement.** |
| `packages/db` | Drizzle schema (72 tables), migrations, seed. `import * as s from '@exatech/db'` gives tables + drizzle operators (`eq`, `and`, `sql`, …). |
| `packages/contracts` | Zod route contracts shared by API and web (`route({method, path, query?, body?, response})`), permissions, screens/nav, domain events. |
| `packages/ui` | shadcn-style components (Radix + cva) in the Industry "blueprint" design system. Feature code styles only through these + Tailwind tokens. |
| `apps/api` | NestJS 11 on Fastify. `src/core` = platform; `src/modules/<context>` = bounded contexts. Better Auth at `/api/auth/*`. |
| `apps/web` | Next.js 15 App Router. Same-origin: Next rewrites `/api/*` to the API. |

Infra: Postgres 16, Redis (BullMQ, cache, rate limits, SSE pub/sub), MinIO (S3) for files, Mailpit for email in dev. WhatsApp/Razorpay/Google run through adapters with dev sandboxes (no credentials needed).

## Running

```bash
pnpm install
pnpm setup:local          # build packages, create DB, migrate, seed, generate seeded files
pnpm dev                  # packages (watch) + API :4300 (+ worker loops) + web :3300
```
Open http://localhost:3300 — the sign-in page lists **demo personas** (DEMO_MODE). Mail: http://localhost:8025. WhatsApp/SMS outbox: http://localhost:3300/dev/outbox.

### Isolated environment (parallel work)
Every agent/worktree uses its own DB, ports, Redis prefix and bucket so nothing collides:
```bash
export EXA=<name> API_PORT=43NN WEB_PORT=33NN
export DATABASE_URL=postgres://localhost:5432/exatech_$EXA REDIS_PREFIX=exa_$EXA S3_BUCKET=exatech-$EXA
export WEB_ORIGIN=http://localhost:$WEB_PORT API_URL=http://localhost:$API_PORT WEB_URL=http://localhost:$WEB_PORT DEMO_MODE=true
pnpm install && pnpm setup:local
(cd apps/api && node dist/main.js > /tmp/exa-$EXA-api.log 2>&1 &)        # rebuild with `pnpm --filter @exatech/api build` after API changes, then restart
(cd apps/web && npx next dev --port $WEB_PORT > /tmp/exa-$EXA-web.log 2>&1 &)
```
`pnpm --filter @exatech/db seed` resets demo data any time (it truncates everything). Seed dates are relative to today (IST).

### Demo personas (seed)
Deepu S Nath (Super Admin, `deepu@exatech.test`) · Priya Varghese (Branch Admin TVM + Teacher DA-C, `priya@`) · Meera Pillai (Sales, `meera@`) · Sanjay Kumar (Sales Manager TVM + Teacher FS-B/FS-C, `sanjay@`) · Joseph Mathew (Finance TVM·EKM + Branch Admin EKM, `joseph@`) · Rema Nair (cashier, `rema@`) · Nithin Raj (Teacher DM-A Search·SEO / DM-B Paid media, `nithin@`) · Anjali Menon (Student DM-A, TVM-DM-2027-00142, instalment 2 ₹15,000 overdue → fee-gated notes **locked**, `anjali.menon@example.test`) · Suresh Menon (Parent of Anjali + Rohan, `suresh.menon@example.test`). Rohan Menon (FS-B, TVM-FS-2027-00098) ₹15,000 overdue 10 days, attendance ~69%, 2 assignments missed. Admissions queue: Aiswarya Suresh (FS-C, 22% → waiting Super Admin), Divya Pillai (DM-B, ready for Branch Admin), Kiran Thomas & Neha George (Finance queue), Ashwin Mohan (returned to Sales).

## Architecture rules

- **Modular monolith.** One API + one worker (same codebase). Bounded contexts in `apps/api/src/modules/*`. A module owns its controllers/services and the tables it is the system of record for. It may *read* any table; it writes other contexts' tables only through events (or the documented exceptions below).
- **Events** (`core/events/event-bus.ts`): `await events.emit(tx, 'AdmissionApproved', payload)` inside your transaction. In-transaction subscribers (`events.onTx(type, fn)`) keep data consistent (they commit/rollback together). Async subscribers (`events.onAsync(type, 'unique-name', fn)`) run in the worker via the transactional outbox for side effects (notifications, WhatsApp, PDFs) — must be idempotent. Register subscribers in a service's `onModuleInit`.
- **Role × scope on the server for every query.** Use `@Can('perm:key')` on every endpoint and scope every list with `inBranchScope(table.branchId)` / `ScopeService` (teacher batches, student enrollment, parent children). The UI only hides what the server already refuses.
- **Money** is integer paise (`@exatech/domain` `rupees()`, `formatINR()`, `formatINRCompact()`). Never floats. Business amounts round to whole rupees.
- **Dates**: calendar dates are `YYYY-MM-DD` strings in IST (`todayIST()`, `addDays()`, `formatDayMonth()`…); instants are `Date`/ISO strings. Display IST.
- **Append-only**: `ledger_entry` and `audit_log` reject UPDATE/DELETE (DB trigger). Finance never deletes: void/reverse with a reason.
- **Audit every write**: `await audit.log(tx, { action, kind, entityType, entityId, entityLabel, summary: 'before → after', branchId })` in the same transaction.
- **Gap-free numbering**: `numbering.next(tx, branchId, 'receipt', fy)` + `formatNumber(pattern, …)`.
- **Notifications**: `await notify.notify(tx, { userIds, category, title, body, link, whatsapp?: {body}, email?: {subject, body} })`. Realtime query invalidation after commit: `notify.invalidate(tx, branchId, [['finance'], ['students']])` / `notify.invalidateUsers(tx, userIds, keys)`.
- Documented cross-context writes: the **Portal** module (BFF for students/parents) writes student-owned rows (submissions, announcement reads/acks, parent messages, PTM requests). Timetable (Academics) and attendance (Teaching) both write `class_session` (different columns). Exam status: Teaching (draft→submitted, recall) and Academics (publish/return).

### API patterns (copy `src/core/audit/audit.controller.ts`)
```ts
@Controller()                                   // no prefix — contract paths are absolute
export class LeadsController {
  constructor(private readonly db: Db, private readonly leads: LeadsService) {}

  @Endpoint(salesContract.createLead)           // binds method+path, validates response
  @Can('sales:leads.create')                    // any-of permission check
  async create(@Input() { body }: Args<typeof salesContract.createLead>) {   // body/query parsed by zod
    return this.leads.create(body);             // thin controller, logic in services
  }
}
```
- Transactions: `await this.db.tx(async (tx) => { … })` (never `db.db.transaction` — `afterCommit` hooks depend on it).
- Errors: throw `invalid('Room 2 is taken by UX-A 14:00–16:00', { room: '…' })`, `forbidden()`, `notFound('Batch')`, `conflict()` from `core/errors`. Messages are shown verbatim in the UI — make them specific.
- Context: `ctx()` → `{ userId, userName, roleKey, permissions, selectedBranchId, membershipBranchIds, readOnly, … }`; `branchScope()`, `assertInScope(branchId)`, `assertBranchAccess(branchId)`.
- Raw SQL params: pass `Date` as `.toISOString()` (postgres-js cannot bind Date in raw `sql\`\``). Drizzle query builder handles Dates fine.
- Files: `FilesService.store(tx, {buffer, filename, purpose, ownerUserId})` (validates by magic bytes), `signedUrl(fileId, 300)`. PDFs: `DocumentKit` (`core/documents/document-kit.ts`) — header, keyValues, table, barcode (Code 128), qr, watermark, footer; ₹ renders correctly.
- Jobs: `QueueService.add('imports'|'reminders'|'documents'|'maintenance', name, data)` and register processors with `queue.process(name, fn)` in `onModuleInit`.
- Register controllers/providers in your module file (`modules/<name>/<name>.module.ts`). Core services are global — just inject them.
- After API changes: `pnpm --filter @exatech/api build` (tsc, must be clean) and restart `node dist/main.js`.

### Contracts
Put your module's schemas in `packages/contracts/src/modules/<module>.ts` and add one `export *` line to `packages/contracts/src/index.ts`. Rebuild: `pnpm --filter @exatech/contracts build`. Response schemas use `zInstant` for timestamps (handlers may return `Date`), `zPaise` for money, `zDate` for calendar dates. Prefer computing display-ready fields on the server (labels, tag variants as enums) so screens stay thin.

### Web patterns (copy `src/app/(app)/audit/page.tsx` + `src/features/audit`)
- Route file (`src/app/(app)/<path>/page.tsx`) is thin: server prefetch of the primary query(s) then render the feature screen:
  ```tsx
  export default function Page() {
    return <Prefetch queries={[q(salesContract.pipeline, { query: {} })]}><PipelineScreen /></Prefetch>;
  }
  ```
- Feature code lives in `src/features/<feature>/{components,hooks,…}` with an `index.ts` public API.
- Data: `useApi(contract, { params, query })` and `useApiMutation(contract, { invalidate: [['sales']], success: 'Lead created' })`. Query keys are path segments (`['api','sales','leads',…]`) — invalidate by prefix. Money/marks: invalidate, never optimistic. Attendance taps / visibility toggles may be optimistic.
- Me/permissions: `useMe()`, `useCan('finance:payment.collect')`, `useBranch()`. Detail panels: `useDrawer().open('student' | 'teacher' | 'branch' | 'exam', id)`; drawer components use `<DrawerLayout kicker title sub tag>`.
- UI kit (`@exatech/ui`): `Page`, `PageHeader`, `Grid`, `Card` (blueprint corners by default; `tone` = white|line|tint|surface|ink|accent|dashed; `pad`), `CardButton`, `CardHead`, `Kicker`, `CardTitle`, `CardBody`, `CardMeta`, `Stat`, `Bar`, `Button` (`variant` primary|secondary|ghost|ink|white, `size` sm|md|lg|xl|icon, `blueprint` for the main CTA, `loading`), `Tag` (accent|neutral|outline|ink|solid|plain), `Input`, `Textarea`, `Select` (native), `Field` (label+error, auto-associated), `Seg`, `Checkbox`, `Radio`, `Table/TH/TD/TR/TableScroll/Sub/Mono`, `Dialog` (kicker/title/footer), `Sheet`, `Popover`, `Icon` (prototype icon set), `toast()` (with `undo`), `Issue` (Blocked/Needed/OK lines), `Row`, `LinkButton`, `EmptyState`, `Skeleton`.
- Tokens: `text-ink`, `bg-surface`, `border-divider`, `bg-accent`, `text-accent-700`, `bg-accent-100`, `text-neutral-600`, `font-heading`, `font-mono`, `tabular`. Overdue/attention states use **ink** (dark), not red — as in the prototype.
- Staff screens are desktop-first (sidebar collapses < 900 px; tables scroll horizontally with `TableScroll minWidth`). Portal screens (teacher/student/parent) are mobile-first inside a 480 px column with bottom nav; touch targets ≥ 44 px (`size="lg"`/`min-h-11`).
- Every blocking validation states its reason inline (`<Issue kind="blocked">…`). Disabled buttons need a visible reason nearby.
- No `any`, no hard-coded demo data in UI: everything comes from the API. Empty, loading (skeletons sized to content) and error states for every list.

## Quality bar (definition of done for a screen/flow)
1. Matches the prototype screen (layout, copy, columns, actions, states) and the PRD rules.
2. API endpoints have `@Can`, branch/scope filtering, zod-validated input, audit rows for writes, notifications/events where the PRD says so.
3. `pnpm --filter @exatech/api build` and `cd apps/web && npx tsc --noEmit` are clean.
4. Playwright spec `apps/web/e2e/<module>.spec.ts` covers the main journeys **and passes** against your running stack (`cd apps/web && WEB_URL=… npx playwright test e2e/<module>.spec.ts`). Use `loginAs(page, persona)` from `e2e/fixtures.ts`; the auto `guard` fixture fails on console/page errors. Tests must be re-runnable: reseed (`pnpm --filter @exatech/db seed`) before a run if a test mutates data, or make assertions robust to repeats.
5. Screenshots checked by eye (`node apps/web/scripts/shot.mjs <email> <path> out.png [w h]`).

## Gotchas
- zsh: never name a shell variable `path` (it is tied to `PATH`).
- `@exatech/db`, `@exatech/contracts`, `@exatech/domain` are consumed from `dist/` — rebuild them after edits (`pnpm --filter <pkg> build`).
- Drizzle uses `casing: 'snake_case'`; TS field names are camelCase.
- `numeric({mode:'number'})` columns come back as numbers; raw `sql` counts come back as strings — wrap with `Number()`.
- Next.js 15: `params`/`searchParams` in pages are Promises.
- The API runs worker loops in-process in dev (EMBED_WORKER default); async event handlers run there.
