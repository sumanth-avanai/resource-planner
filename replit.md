# Resource Planner

A lightweight internal **resource planning & time-tracking** web app for small teams, forked from an app called *AvaTrack* and reworked to be **money-free**: no billing, invoicing, day rates, or revenue. Budgets are expressed in **days** (8h = 1 day); time is logged in **hours**. Avanai colors (purple #8B5CF6 / cyan #06B6D4). Feels like a premium SaaS tool (Linear/Vercel aesthetic), not a heavy ERP.

> Full change log + rationale from the AvaTrack → Resource Planner migration is in **`HANDOVER.md`**.

## Stack

- **Monorepo**: pnpm workspaces · **Node 24** · **TypeScript 5.9**
- **Frontend**: React + Vite + Tailwind (`artifacts/time-tracker`, served at `/`)
- **API**: Express 5 (`artifacts/api-server`)
- **DB**: PostgreSQL + Drizzle ORM (`lib/db`)
- **Validation / contract**: Zod (`zod/v4`, `drizzle-zod`) + OpenAPI → **Orval** codegen (`lib/api-spec` → `lib/api-zod` + `lib/api-client-react`)
- **Seed**: `scripts/src/seed.ts` (loads demo data from the mock `db.json`)

## Key commands

- **Local UI, no backend/DB (recommended for design/QA):**
  `pnpm install` then `pnpm --filter @workspace/time-tracker run dev:mock`
  → http://localhost:5173 · login with **any** password (mock). All `/api/*` is served in-browser from `artifacts/time-tracker/src/mocks/db.json`. Changes persist to `localStorage`; open `/?resetMock` to reset.
- `pnpm run typecheck` — full typecheck (libs + all artifacts + scripts)
- `pnpm --filter @workspace/api-server exec vitest run` — backend unit tests
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client/zod from `openapi.yaml` (**orval is pinned to 8.5.2**; the zod output uses `indexFiles: false` so the hand-maintained `lib/api-zod/src/index.ts` is preserved)
- `pnpm --filter @workspace/db run push` — push schema to Postgres
- `pnpm --filter @workspace/scripts run seed` — seed demo data (needs `DATABASE_URL`)

## Deploying on Replit (real backend)

1. `pnpm install`
2. Set env: `DATABASE_URL` (Replit Postgres) and `APP_ACCESS_PASSWORD` (admin login).
3. `pnpm --filter @workspace/db run push` (create tables)
4. `pnpm --filter @workspace/scripts run seed` (load demo data)
5. `pnpm run typecheck` (sanity), then run the app (frontend on the configured port; api-server serves `/api/*`).

Optional employee-onboarding webhook env (used by `POST /employees`): `N8N_EMPLOYEE_WEBHOOK_URL`, `N8N_WEBHOOK_USER`, `N8N_WEBHOOK_PASS`.

## Features

### Admin area (`/`)
- **Home** — weekly summary: total logged hours, per-employee utilization.
- **Timesheet** — two views (toggle):
  - **Team view** (default): roster grouped by PM — the PM shown once in a single tall, row-spanning cell with their team members in rows beside it (weekly capacity in days + hours logged that week).
  - **All entries**: the spreadsheet-style editable time-entry grid with filters and bulk edit.
- **Resource Planner** — day-cell timeline, employee rows **grouped under PM headers**. Absences (Vacation / Sick / Unpaid leave / Other) are fully editable: the ＋ menu per row or a click on the timeline opens an absence dialog; existing absences are click-to-edit/delete; they render inline and reduce availability.
- **Projects** — linked to clients; **budget in days**, PM (select from employees), status, color, active. Per-project **Roles** (name, budgeted days, assigned employees; booked-vs-budgeted in days). No billable flag, no day rate.
- **Employees** — "By PM" grouping (default) with an "All employees" toggle; capacity, working-days mask, contract dates, personal-link + PIN management.
- **Reports** — pivot/flat reporting (hours, days, utilization); CSV export. No billable/revenue metrics.

### PM → teams (derived, many-to-many)
A PM is simply an employee named on a project (`projects.pmName`). An employee belongs to a PM's team if they work on that PM's project (via role assignment, resource booking, or logged time). The API returns `pmNames: string[]` per employee (`GET /api/employees`), derived server-side (`pmNamesByEmployee` in `routes/employees.ts`; mirrored by `pmNamesForEmployee` in the mock). Employees on no PM's project appear under **Unassigned**. No separate PM table.

### Employee personal portal (`/u/:token`)
- PIN-protected personal URL per employee; shows only their own timesheet (role-filtered).
- **Time off**: employees add/remove their own Vacation/Sick/Unpaid/Other from a "Time off" dialog. These use **token-scoped** endpoints (`GET/POST/DELETE /api/employee-timesheet/:employeeId/vacations[/:id]?token=…`) so no admin session is required and an employee can only touch their own records. (The admin `/api/vacations` routes remain session-gated for the Resource Planner.)
- Notes: a cell can hold a note with **0 hours** and it persists (note-only entries are kept, not dropped).

## Data model (Drizzle, `lib/db/src/schema`)

Money-free. Tables: `clients`, `employees`, `projects`, `project_roles`, `project_role_assignments`, `resource_bookings`, `time_entries`, `employee_vacations`, `holiday_calendars`, `holidays`, `saved_reports`.

- Budgets in days: `projects.budgetHours` (rendered as days), `project_roles.budgetedDays` / `budgetedHours`.
- Absences: `employee_vacations.vacationType` ∈ {`vacation`, `sick`, `unpaid_leave`, `other`}.
- Removed vs. AvaTrack: the `invoices`/`invoice_items` tables, `projects.isBillable`, `projects.budgetStatus`, `project_roles.dayRate`, `time_entries.invoicedAt/invoiceReference/billingStatus`. The **Project Status** panel and its `project_health_updates` table were also removed entirely (page, routes, nav, api-server route, OpenAPI paths/schemas).

## Auth

- **Admin**: single app password (`APP_ACCESS_PASSWORD`), session cookie. In mock mode any password works.
- **Employee portal**: per-employee `personalAccessToken` + PIN (hashed as `personalAccessPinHash`, SHA-256). Demo PINs are in `db.json` as `personalAccessPin` (e.g. Anna Berger / `tok-anna-3f9a` / `1234`); the seed hashes them into `personalAccessPinHash`.

## Utilization & availability (unchanged, hours-based)

`dailyCapacity = weeklyCapacityHours / activeWorkingDays`. Available hours iterate calendar days in range, skipping non-working days (mask), days outside contract, public holidays, and absences. `utilization % = bookedHours / availableHours × 100`.
