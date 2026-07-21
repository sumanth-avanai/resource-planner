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
- **Project Status** — money widgets removed (Budget Breakdown €, "Revenue Over Time" burn-up chart, invoiced figures). Health/risk/satisfaction, next steps, and day-based budget stay.
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

## DONE vs. TO-DO when you push to Replit

**Done & verified (typecheck clean, `dev:mock` boots):**
- Frontend (`artifacts/time-tracker`) — all panels, money removal, PM grouping, absence UI, rebrand.
- Mock layer — `db.json` + `mock-api.ts` (money-free, serves `pmNames`).
- Drizzle schema (`lib/db`) — money removed, day budgets kept.

**To finish on Replit (the real backend — intentionally deferred so you could see the UI first):**

1. **`artifacts/api-server/src` still references the removed fields/tables** and won't compile until updated. Files, by amount of work:
   - `routes/billing.ts` (delete the file + its import/mount in `routes/index.ts`)
   - `routes/projectRoles.ts` (remove `dayRate`)
   - `routes/projectStatus.ts` (remove `budgetStatus` + revenue)
   - `lib/budget-reconciliation.ts` (+ its test) — drop invoiced/revenue, keep day math
   - `routes/reports.ts`, `routes/timeEntries.ts`, `routes/projects.ts`, `routes/pivot.ts`, `routes/dashboard.ts`, `routes/resourceBookings.ts` — remove `invoic*` / `isBillable` / `budgetStatus` references
   Mirror exactly what was already done in `mock-api.ts` (it's the reference implementation for the money-free responses).
2. **Add `pmNames` to the real `GET /api/employees`** (and `/api/employees/:id`) — derive it server-side the same way `pmNamesForEmployee()` does in `mock-api.ts` (union of projects via role assignments + bookings + time entries → distinct `project.pmName`). The three panels rely on this field.
3. **OpenAPI + codegen:** update `lib/api-spec/openapi.yaml` to drop the money fields, then regenerate: `pnpm --filter @workspace/api-spec run codegen`. ⚠️ Pin orval to **8.5.2** (the version the committed client was built with) — 8.5.3 produces a duplicate `UpdateTimeEntryBody` export that breaks `lib/api-zod`. The generated client was intentionally left untouched for this reason.
4. **Database:** `pnpm --filter @workspace/db run push` then `pnpm seed`. You can seed from `db.json` shapes.
5. **Employee self-service time off:** the employee portal's "Time off" dialog lets employees **add** (`POST /api/vacations`) and **remove** (`DELETE /api/vacations/:id`) their own absences; it lists existing time off with a remove button. In mock these are open; on the real backend both routes sit behind `requireAppAuth` (admin only), so employees would get 401. Allow employees to manage their own absences — e.g. add employee-token-scoped endpoints (`POST`/`DELETE /api/employee-timesheet/:employeeId/absence[/:id]`) or permit `/api/vacations` for the authenticated employee token, scoped to their own `employeeId` (and reject deleting another employee's record).

Suggested Replit sequence: `pnpm install` → fix api-server (steps 1–2) → codegen (step 3) → `pnpm run typecheck` (whole repo) → `db:push` → `seed` → run.

---

## Known minor leftovers (cosmetic, non-blocking)
- `replit.md` still describes the original AvaTrack (billing, day rates). Update it after the backend rewire.
- A couple of internal code comments in `mock-api.ts` mention "invoiced" in explanatory text; no behaviour attached.
