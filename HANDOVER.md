# Resource Planner — Handover

Forked from **AvaTrack** and reworked into a **money-free resource planner**. Same tech stack, so it wires straight back into Replit. This document covers what changed, how to run it locally now, and exactly what to finish when you push back to Replit.

---

## Run it locally right now (mock data, no backend/DB)

```bash
pnpm install
pnpm --filter @workspace/time-tracker run dev:mock
# open http://localhost:5173  → login with ANY non-empty password (mock mode)
```

`dev:mock` serves the whole app in the browser and answers every `/api/*` call from `artifacts/time-tracker/src/mocks/db.json` via `mock-api.ts`. No server, no Postgres. Edit `db.json` to change the demo data. A dev component gallery is at `http://localhost:5173/gallery.html`.

**Mock persistence:** changes you make in mock mode (hours, notes, absences, etc.) are saved to the browser's `localStorage`, so they survive a page refresh — the same way the real Postgres-backed API would. To wipe local changes and reload the fresh demo data from `db.json`, open the app with `?resetMock` (e.g. `http://localhost:5173/?resetMock`) or clear the `resource-planner.mockdb.v1` localStorage key. (This persistence is mock-only; the real backend uses the database.)

### Employee-portal demo logins (`/u/:token`, 4-digit PIN — enforced in mock)

Each employee has a personal timesheet portal. Open the link and enter the PIN:

| Employee | URL | PIN |
| --- | --- | --- |
| Anna Berger | `http://localhost:5173/u/tok-anna-3f9a` | `1234` |
| Jonas Keller | `/u/tok-jonas-8c21` | `1111` |
| Sara Nguyen | `/u/tok-sara-b44d` | `1222` |
| Malik Osei | `/u/tok-malik-71ee` | `1333` |
| Priya Shah | `/u/tok-priya-a90c` | `1444` |
| Lukas Weber | `/u/tok-lukas-5d02` | `1555` |
| Eva Brandt | `/u/tok-eva-e310` | `1666` |
| Tobias Frank | `/u/tok-tobias-91af` | `1777` |
| Mara Vogel | `/u/tok-mara-27cd` | `1888` |
| Deniz Acar | `/u/tok-deniz-b3e8` | `1999` |

PINs live on each employee in `db.json` as `personalAccessPin` and are checked by the mock `POST /api/auth/employee/verify`. On the real backend these map to the hashed `personalAccessPinHash` column (set them during seeding). Admins can also copy any employee's personal link from the Employees page.

---

## What changed (against your requirements)

- **No money anywhere.** Removed the Billing page, all invoicing, day rates (€/day), revenue, budget-status, and `isBillable`. Budgets are now expressed in **days** (8h = 1 day) everywhere; time is still **logged in hours** (capacity/utilisation math unchanged).
- **Billing panel removed** — page, route, sidebar item, and the "Open in Billing" link are gone.
- **Project Status panel removed entirely** — page, routes, sidebar item, api-server route, mock endpoints, OpenAPI paths/schemas, and the `project_health_updates` table are all gone.
- **PM → team is derived, many-to-many, no new table.** A PM is simply an employee named on a project (`projects.pmName`). An employee belongs to a PM's team if they work on that PM's project (via role assignment, booking, or logged time). The mock API returns `pmNames: string[]` per employee. An employee can appear under several PMs; employees on no PM's project fall under **Unassigned**.
- **Employees panel** — "By PM" grouping (default) with an "All employees" toggle. Each PM is a section ("basket"); multi-PM people appear under each.
- **Timesheet panel** — new **Team view** (default): a roster grouped by PM, with the **PM shown once in a single tall (row-spanning) cell** and their team members in rows beside it, each showing weekly capacity (days) and hours logged that week. Toggle to "All entries" for the original editable timesheet.
- **Resource panel** — employee rows are **grouped under PM headers**. Absences are **fully wired**: use the **＋ menu on any employee row → "Absence"** (or click the timeline) to add Vacation / Sick / Unpaid leave / Other; click an existing absence to edit or delete. Absences post to `/api/vacations` and are reflected in the timeline and availability.
- **Login unchanged** (as requested — same as AvaTrack): one app password for admin (`APP_ACCESS_PASSWORD` in real mode; any password in mock), plus per-employee token + PIN for the `/u/:token` employee portal. No SSO — this keeps the handover self-contained and is the easiest to run.
- **Rebranded** AvaTrack → Resource Planner (login, sidebar, page titles, gallery).

---

## Data model (Drizzle) — already updated in `lib/db/src/schema`

Removed: `invoices` table (file deleted + de-exported), `projects.isBillable`, `projects.budgetStatus`, `projectRoles.dayRate`, `timeEntries.invoicedAt / invoiceReference / billingStatus`, `projectHealthUpdates.budgetStatus`.

Kept (day budgets): `projects.budgetHours` (shown as days in UI), `projectRoles.budgetedDays` / `budgetedHours`. Absences already existed in `employee_vacations` (types: `vacation`, `sick`, `unpaid_leave`, `other`).

No new tables — PM teams are derived.

---

## Status: FULL STACK is done & money-free

The whole repo has been migrated and verified — you no longer need to fix the backend before deploying.

**Done & verified** (each package typechecks clean; api-server `vitest` = 65/65 passing; `dev:mock` boots):
- **Frontend** (`artifacts/time-tracker`) — all panels, money removal, PM groupings, absence UI, employee-portal time-off add/remove, rebrand.
- **Mock layer** (`db.json` + `mock-api.ts`) — money-free, serves `pmNames`, localStorage persistence, token-scoped employee vacation endpoints.
- **Drizzle schema** (`lib/db`) — money removed, day budgets kept.
- **API contract** (`lib/api-spec/openapi.yaml` → regenerated `lib/api-zod` + `lib/api-client-react`) — money-free. Orval pinned to **8.5.2**; the zod output sets `indexFiles: false` so `lib/api-zod/src/index.ts` stays hand-maintained (prevents the duplicate-export break on regen).
- **API server** (`artifacts/api-server`) — `billing.ts` deleted + unmounted; money removed from projects, projectRoles, projectStatus, reports, pivot, dashboard, timeEntries, resourceBookings, and `lib/budget-reconciliation.ts` (+ tests). `GET /api/employees` derives `pmNames` server-side (`pmNamesByEmployee`). Token-scoped employee absence endpoints added (`GET/POST/DELETE /api/employee-timesheet/:employeeId/vacations[/:id]?token=…`); note-only (0h + note) timesheet cells are kept.
- **Seed** (`scripts/src/seed.ts`) — rewritten to load `db.json` into Postgres (mask→comma string, PIN→sha256 hash, generates time entries from bookings, resets id sequences).
- **mockup-sandbox** — legacy billing mockup removed.

**To go live on Replit — just wire the DB and run:**
1. `pnpm install`
2. Set env: `DATABASE_URL` (Replit Postgres) + `APP_ACCESS_PASSWORD` (admin login).
3. `pnpm --filter @workspace/db run push`  (create tables)
4. `pnpm --filter @workspace/scripts run seed`  (load demo data)
5. `pnpm run typecheck`  (sanity), then run the app.

The one thing I could NOT do here (no Postgres in the dev environment): actually run `db:push` / `seed` / the live server. Everything is typecheck- + unit-test-verified; the live DB run is the only step left, and it's standard.

---

## Notes
- **Mock persistence** is localStorage-only (survives refresh locally); the real backend uses Postgres. `/?resetMock` clears local data.
- If you ever regenerate the API client, keep orval at **8.5.2** and the `indexFiles: false` config, or `lib/api-zod` will break with duplicate exports.
