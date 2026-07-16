# AvaTrack — Internal Time Tracker

## Overview

A lightweight internal time-tracking web app for small agencies, branded as **AvaTrack** with Avanai colors (purple #8B5CF6 / cyan #06B6D4 gradient). Feels like a premium SaaS tool (Linear/Vercel aesthetic), not a heavy ERP. Inspired by Productive/MOCO but much simpler.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind (at `/`)
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run seed` — seed demo data
- `pnpm --filter @workspace/time-tracker run dev:mock` — frontend only, all `/api/*` served in-browser from `src/mocks/db.json` (no backend/DB needed; for UI/UX work). Dev-only: gated on `VITE_MOCK=1`, dead code in production builds.
- `pnpm --filter @workspace/api-server exec vitest run` — backend unit tests (incl. budget reconciliation)

## Features

### Admin Area (`/`)
- **Dashboard** — weekly summary: total/billable hours, per-employee utilization cards
- **Timesheet** — select any employee, spreadsheet-style grid (projects × Mon-Sun), explicit Save button (Ctrl+S), capacity warnings
- **Clients** — create/edit/archive with active toggle
- **Projects** — linked to clients, billable flag, budget hours
- **Employees** — weekly capacity, working days mask, contract start/end dates, personal link management + PIN reset
- **Holidays** — manage holiday calendars (DE-BASE-2026 preloaded)
- **Vacations** — absence/vacation management per employee (vacation, sick, unpaid leave, other); filterable by employee; correctly deducted from utilization
- **Reports** — Pivot/flat reporting with 9 date presets, multi-select filters, metric selector, CSV export
- **Project Roles (T&M)** — Per-project role management (name, day rate €/day, budgeted days, assigned employees); role selection in Timesheet "Add Project" flow; Budget tab with booked vs. budgeted per role; Allocations tab with planned vs. booked per employee per role
- **Billing** — Revenue tracking per project: logged vs invoiced vs unbilled per role/employee; period presets (this/last month, quarter, all time, custom); 5 KPI cards; collapsible role/employee table with colour-coded unbilled amounts; "Mark all as invoiced" modal with optional invoice reference; CSV export
- **Resource Planner** — day-cell timeline: fixed 64px row height per employee (never content-driven); per-day proportional fill (booked ÷ daily capacity) with role name overlaid; max 2 concurrent lanes per day, 3rd+ booking shows a "+N" badge with hover breakdown; absences render inline as neutral gray icon cells (star/sun/thermometer/X); employees with no bookings show an "Available" row; at month/quarter/year zoom bars bridge weekends and multi-day absences merge into one block (week zoom keeps true day cells); searchable client-grouped project FilterPanel with active-count badge; booking modal with live role-budget check and past-plan release
- **Shared UI components** (`artifacts/time-tracker/src/components/shared/`) — 16 reusable components from the avanai CI redesign (Button, StatusPill, IconChip, BudgetBar, KpiCard, DataTable, FilterPanel, EntityPicker, PeriodPicker, ColumnVisibilityMenu, ConfirmModal, SearchInput, SharedTooltip, EmptyState, AbsenceCell, TimelineEntry). Dev gallery at `/gallery.html` in `dev:mock` (excluded from production build). Design tokens (brand + semantic status colors) live in `src/index.css` under `@theme`.

### Employee Personal Links (`/u/:token`)
- PIN-protected personal URL per employee (route no longer requires admin session)
- Shows only own timesheet after PIN verified (stored in sessionStorage)
- **Role-filtered**: employees see only their assigned project roles via `PortalTimesheetGrid`
- Legacy entries (time logged before role assignment) shown with a "legacy" badge
- Projects are collapsible; a "Planned" column shows hours from active resource bookings
- Save validates assignments server-side (403 for unassigned roles); grandfathers existing entries

## Demo Credentials
- **Max Mustermann** (40h, Mon-Fri, since 2024-01-01) — PIN: `1234`
- **Anna Beispiel** (20h, Mon-Fri, since 2025-06-01) — PIN: `5678`
- **Paul Teilzeit** (32h, Mon-Thu, 2026-01-15 to 2026-12-31) — PIN: `9999`

Employee personal link tokens can be found via `/api/employees` or the Employees admin page.

---

## Business Logic & Formulae

### Utilization & Availability

**Source:** `artifacts/api-server/src/lib/utilization.ts`, `artifacts/api-server/src/lib/employee-availability.ts`

**Daily capacity:**
```
dailyCapacity = weeklyCapacityHours / activeDaysPerWeek
```
where `activeDaysPerWeek` = count of `1` bits in `workingDaysMask`.

**Available hours loop** — iterate every calendar day in `[startDate, endDate]` (UTC midnight):

1. Skip if day is before `contractStartDate` (if set).
2. Skip if day is after `contractEndDate` (if set).
3. Skip if `workingDaysMask[isoDayIndex]` is `0` (non-working day).
4. Skip if day is in the employee's `holidayDates` set (public holiday).
5. Skip if day is in the `vacationDateSet` (absence/vacation).
6. Otherwise: `availableHours += dailyCapacity`.

Final result is rounded to 2 decimal places: `Math.round(availableHours * 100) / 100`.

**Billable utilization:**
```
billableUtilization (%) = round(billableHours / availableHours × 1000) / 10
```
(Result is a percentage with one decimal place, e.g. `85.3`.)

**Overall utilization:**
```
overallUtilization (%) = round(totalBookedHours / availableHours × 1000) / 10
```

**Employee active-during check** (`wasEmployeeActiveDuring`):
- Returns `false` if `contractStartDate > periodEnd` (contract not yet started).
- Returns `false` if `contractEndDate < periodStart` (contract already ended).
- `null` contract boundaries = no restriction on that side.

**Weighted team target** (Reports pivot — client-side, `reports.tsx`): the team row shows a weighted-average utilization target calculated as:
```
teamUtilTarget = Σ(utilizationTarget × targetHours) / Σ(targetHours)
```
Only employees whose `utilizationTarget` is non-null contribute to this average. `targetHours` (`row.target`) is the employee's capacity-adjusted available hours in the selected period. Returns `null` if no employee has a target set.

**Shared availability fetch** (`fetchEmpAvailabilityMap`): fetches holidays grouped by calendar code (avoids N+1 queries) and vacations overlapping the period in a single batch query. Returns `Map<employeeId, { holidayDates, vacationDateSet, compDayDateSet }>`. `compDayDateSet` is always empty (placeholder for future compensatory-leave table).

---

### Billing & Revenue

**Source:** `artifacts/api-server/src/routes/billing.ts`

**Hours-to-days constant:** 8 hours = 1 day (hardcoded divisor throughout).

**Revenue formulae (all amounts rounded via `round2 = Math.round(n * 100) / 100`):**
```
loggedDays     = loggedHours / 8
revenue        = round2(loggedHours / 8 × dayRate)
invoiced       = round2(invoicedHours / 8 × dayRate)
invest         = round2(investHours / 8 × dayRate)
unbilled       = round2(revenue − invoiced − invest)
budget         = round2(budgetedDays × dayRate)           (null if budgetedDays is null)
remaining      = round2(budget − logged)                  (null if budget is null)
```

**`invoicedHours` aggregation (backward-compat rule):**
```sql
SUM(CASE
  WHEN billing_status = 'invoiced' THEN hours
  WHEN billing_status IS NULL AND invoiced_at IS NOT NULL THEN hours
  ELSE 0
END)
```
Entries stamped via the legacy `mark-invoiced` endpoint (which set `invoiced_at` but not `billing_status`) are counted as invoiced.

**`investHours` aggregation:**
```sql
SUM(CASE WHEN billing_status = 'invest' THEN hours ELSE 0 END)
```

**Employee billing status badge** (dominant status, shown per-employee row):
- `"invoiced"` if `invoicedHours > 0` AND `investHours == 0`
- `"invest"` if `investHours > 0` AND `invoicedHours == 0`
- `null` otherwise (mixed or nothing)

**Aggregation order:** revenue is accumulated raw (pre-`round2`) at the role level before rolling up to project/client/grand totals; `round2` is applied only at output time to each level. This avoids rounding drift.

---

### Budget Reconciliation (role budgets)

**Source:** `artifacts/api-server/src/lib/budget-reconciliation.ts` (unit tests: `budget-reconciliation.test.ts`, 33 scenarios). Consumed by `routes/projectRoles.ts` (budget-status, `/projects/:id/budget`, `/projects/:id/allocations`) and mirrored in the frontend mock (`src/mocks/mock-api.ts`).

**Core identity (always holds):**
```
Budget = Logged + Reserved + Unplanned
```

**Buckets:**
```
Logged (C)     = Σ all logged hours ÷ 8            (delivered work — invoiced or not)
Reserved (R)   = Σ max(planned − logged, 0)        per day, days ≥ today only
                 ("Re-plannable" in the UI: committed future work, movable)
Stale plan (S) = Σ max(planned − logged, 0)        per day, days < today
                 (warning flag ONLY — never counted as consumption)
Unplanned (U)  = Budget − Logged − Reserved        (THE number to book against;
                                                    negative ⇔ genuine over-commitment)
Free           = Budget − Logged                   (burn indicator, ignores future plan)
Remaining      = Budget − Invoiced                 (finance view: not yet billed)
```

**Key rules:**
- **Invoiced is a billing overlay** — it never moves capacity figures. Invoicing an entry changes `Invoiced`/`Remaining` only, never `Unplanned`. (The pre-2026-07 model subtracted invoiced instead of logged, which made unbilled work look like open capacity and produced phantom negatives — do not regress to it.)
- **Per-day netting** — planned vs logged hours are netted per calendar day across all bookings of the role, so overlapping bookings and moved work never double-count.
- **Stale plan** — booked days before today that were never delivered stop counting against the budget automatically and are surfaced as `stalePlanDays` (amber "⚠ Stale plan" in Budget tab, Allocations, booking modal, planner tooltip). The PM resolves them by releasing or re-planning.
- **Release semantics (`past_released_at`)** — the write-off is frozen at the **release date**, not a rolling "today": only days strictly before the release date stay forgiven; days missed after a release resurface as stale. Re-releasing stamps a new date (each write-off is a deliberate, dated decision). Applies in `calcRoleBudgetReconciliation`, `calcEffectiveBookingBudgetDays`, and `GET /resource-bookings/:id/past-undelivered`.
- **Tentative bookings** are excluded from all budget math.
- Over-logging a booked day floors undelivered at 0 (never negative reserved).

**UI mapping (project roles sheet → Budget tab):** four-segment bars per role — Invoiced (green) + Logged-not-invoiced (amber) + Re-plannable (blue) + Unplanned (gray); when consumption + commitments exceed the budget the bar fills completely with a red "over by Xd" overflow segment and a budget-boundary tick. Column headers carry info (ⓘ) tooltips defining each metric.

---

### Resource Bookings

**Source:** `artifacts/api-server/src/routes/resourceBookings.ts`, `artifacts/api-server/src/lib/booking-hours.ts`

**Two booking modes:**

| Mode | Trigger | Storage |
|------|---------|---------|
| **Flat** | `hoursPerDay` provided, `weekdayHours` null | `hoursPerDay` stored directly |
| **Weekday** | `weekdayHours` map provided (`{"1":h,"2":h,...,"5":h}`) | both stored; `hoursPerDay` derived |

**`resolveHoursPerDay`** when `weekdayHours` is present:
```
hoursPerDay = Σ(weekdayHours values) / 5
```
This derived value is stored in `hoursPerDay` for quick queries.

**Planned-hours calculation** (portal & budget endpoints) — for the overlap of a booking with a target period:

- **Weekday mode:** iterate each day in the overlap; for each day that is in the employee's working mask AND not a holiday AND not a vacation, add `weekdayHours[dayOfWeek]` (ISO weekday key `"1"`–`"5"` where `"0"` = Sunday and is never included).
- **Flat mode:** `workingDaysInOverlap × hoursPerDay`, where `workingDaysInOverlap` excludes holidays and vacations from the employee's mask.

**`calcBookingHours`** (used in budget/allocations endpoints) returns `{ totalHours, budgetDays }` where:
```
budgetDays = totalHours / 8
```

**Notification queue side-effect** — on every `POST /resource-bookings` or `PUT /resource-bookings/:id`, an upsert is made to `notification_queue` with `send_after = NOW() + INTERVAL '30 minutes'` and `sent = false`. The conflict key is `(employee_email, project_name, booking_id)`. On `DELETE /resource-bookings/:id`, unsent notification queue rows for that booking are deleted.

**Validation:**
- `startDate` must be ≤ `endDate`.
- Either `hoursPerDay` or `weekdayHours` must be provided (not both null).
- `weekdayHours` keys must be `"1"` through `"5"` only.
- Each `weekdayHours` value: `0 ≤ value ≤ 24`.

---

## Entity Constraints

### `clients`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `name` | text | NOT NULL | — | |
| `active` | boolean | NOT NULL | `true` | soft-delete toggle |
| `notes` | text | NULL | — | |
| `created_at` | timestamptz | NOT NULL | now() | |

No FK references to other tables. No cascade behaviour.

---

### `employees`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `name` | text | NOT NULL | — | |
| `email` | text | NULL | — | used for notification queue |
| `weekly_capacity_hours` | real | NOT NULL | `40` | |
| `working_days_mask` | text | NOT NULL | `"1,1,1,1,1,0,0"` | Mon–Sun, comma-separated |
| `holiday_calendar_code` | text | NULL | — | FK-like (no DB constraint) to `holiday_calendars.code` |
| `contract_start_date` | date | NULL | — | first day of employment |
| `contract_end_date` | date | NULL | — | last day of employment; null = no end |
| `utilization_target` | integer | NULL | — | Zod: 0–100 |
| `personal_access_token` | text | NOT NULL | — | base64url 24-byte random; unique per employee |
| `personal_access_pin_hash` | text | NOT NULL | — | SHA-256 hex of PIN (see Authentication section for upgrade path) |
| `active` | boolean | NOT NULL | `true` | |
| `created_at` | timestamptz | NOT NULL | now() | |

---

### `projects`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `client_id` | integer | NOT NULL | — | FK → `clients.id` (no cascade; DB will error on client delete if projects exist) |
| `name` | text | NOT NULL | — | |
| `code` | text | NULL | — | optional short code |
| `active` | boolean | NOT NULL | `true` | |
| `is_billable` | boolean | NOT NULL | `true` | affects utilization reporting |
| `budget_hours` | real | NULL | — | overall project budget (informational) |
| `start_date` | date | NULL | — | |
| `end_date` | date | NULL | — | |
| `color` | text | NULL | — | hex color string; fallback via `resolveProjectColor` palette |
| `pm_name` | text | NULL | — | project manager name |
| `general_status` | varchar(20) | NULL | — | see Project Health section |
| `budget_status` | varchar(20) | NULL | — | |
| `risk_level` | varchar(20) | NULL | — | see Project Health section |
| `client_satisfaction` | varchar(20) | NULL | — | see Project Health section |
| `created_at` | timestamptz | NOT NULL | now() | |

---

### `project_roles`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `project_id` | integer | NOT NULL | — | FK → `projects.id` **ON DELETE CASCADE** |
| `name` | text | NOT NULL | — | Zod: `min(1)` |
| `day_rate` | real | NOT NULL | `0` | Zod: `min(0)` |
| `budgeted_days` | real | NULL | — | Zod: `min(0)` |
| `budgeted_hours` | real | NULL | — | Zod: `min(0)`; derived: `budgetedDays × 8` if not set |
| `created_at` | timestamptz | NOT NULL | now() | |
| `updated_at` | timestamptz | NOT NULL | now() | auto-updated |

Index: `project_roles_project_idx` on `(project_id)`.

Cascade effects:
- `DELETE project_roles` → cascades to `project_role_assignments` (ON DELETE CASCADE).
- `DELETE project_roles` → sets `time_entries.project_role_id = NULL` (ON DELETE SET NULL).
- `DELETE project_roles` → sets `resource_bookings.project_role_id = NULL` (ON DELETE SET NULL).

---

### `project_role_assignments`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `project_role_id` | integer | NOT NULL | — | FK → `project_roles.id` **ON DELETE CASCADE** |
| `employee_id` | integer | NOT NULL | — | FK → `employees.id` **ON DELETE CASCADE** |
| `created_at` | timestamptz | NOT NULL | now() | |

Unique constraint: `(project_role_id, employee_id)`.

---

### `time_entries`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `employee_id` | integer | NOT NULL | — | FK → `employees.id` (no cascade) |
| `project_id` | integer | NOT NULL | — | FK → `projects.id` (no cascade) |
| `project_role_id` | integer | NULL | — | FK → `project_roles.id` **ON DELETE SET NULL** |
| `entry_date` | date | NOT NULL | — | |
| `hours` | real | NOT NULL | — | valid range: `0 ≤ hours ≤ 24` (portal endpoint) |
| `note` | text | NULL | — | portal: max 1000 chars |
| `invoiced_at` | timestamptz | NULL | — | |
| `invoice_reference` | varchar(100) | NULL | — | max 100 chars |
| `billing_status` | varchar(20) | NULL | — | `'invoiced'` \| `'invest'` \| null |
| `created_at` | timestamptz | NOT NULL | now() | |
| `updated_at` | timestamptz | NOT NULL | now() | auto-updated |

Index: `time_entries_emp_date_idx` on `(employee_id, entry_date)`.

---

### `resource_bookings`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `employee_id` | integer | NOT NULL | — | FK → `employees.id` **ON DELETE CASCADE** |
| `project_id` | integer | NOT NULL | — | FK → `projects.id` **ON DELETE CASCADE** |
| `project_role_id` | integer | NULL | — | FK → `project_roles.id` **ON DELETE SET NULL** |
| `start_date` | date | NOT NULL | — | must be ≤ `end_date` |
| `end_date` | date | NOT NULL | — | |
| `hours_per_day` | real | NOT NULL | — | flat rate or derived from `weekday_hours` |
| `weekday_hours` | jsonb | NULL | — | `Record<"1"\|"2"\|"3"\|"4"\|"5", number>` |
| `notes` | text | NULL | — | |
| `status` | varchar | NULL | — | `'confirmed'` \| `'tentative'` \| null; tentative bookings are excluded from budget math |
| `past_released_at` | timestamptz | NULL | — | past-plan write-off timestamp; cutoff is the **release date** (see Budget Reconciliation) |
| `created_at` | timestamptz | NOT NULL | now() | |
| `updated_at` | timestamptz | NOT NULL | now() | auto-updated |

Indexes: `resource_bookings_employee_idx` on `(employee_id)`, `resource_bookings_dates_idx` on `(start_date, end_date)`.

---

### `employee_vacations`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `employee_id` | integer | NOT NULL | — | FK → `employees.id` **ON DELETE CASCADE** |
| `start_date` | date | NOT NULL | — | must be ≤ `end_date` |
| `end_date` | date | NOT NULL | — | |
| `vacation_type` | text | NOT NULL | `'vacation'` | enum: `vacation` \| `sick` \| `unpaid_leave` \| `other` |
| `note` | text | NULL | — | |
| `created_at` | timestamptz | NOT NULL | now() | |

---

### `holiday_calendars`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `code` | text | NOT NULL UNIQUE | — | e.g. `"DE-BASE-2026"` |
| `name` | text | NOT NULL | — | |
| `created_at` | timestamptz | NOT NULL | now() | |

### `holidays`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `calendar_id` | integer | NOT NULL | — | FK → `holiday_calendars.id` **ON DELETE CASCADE** |
| `date` | date | NOT NULL | — | |
| `name` | text | NOT NULL | — | |

---

### `project_health_updates`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | serial PK | — | auto | |
| `project_id` | integer | NOT NULL | — | FK → `projects.id` **ON DELETE CASCADE** |
| `general_status` | varchar(20) | NOT NULL | — | enum: `planned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` |
| `budget_status` | varchar(20) | NULL | — | |
| `risk_level` | varchar(20) | NOT NULL | — | enum: `low` \| `medium` \| `high` |
| `client_satisfaction` | varchar(20) | NULL | — | enum: `happy` \| `neutral` \| `critical` |
| `comment` | text | NULL | — | |
| `created_at` | timestamptz | NOT NULL | now() | |

Append-only — never updated.

---

### `saved_reports`
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | varchar(36) PK | — | `crypto.randomUUID()` | UUID string |
| `name` | text | NOT NULL | — | |
| `config` | text | NOT NULL | — | JSON-encoded report configuration |
| `created_at` | timestamptz | NOT NULL | now() | |
| `updated_at` | timestamptz | NOT NULL | now() | |

---

## Timesheet Validation Rules

**Source:** `artifacts/api-server/src/routes/employeeTimesheet.ts`

### Access control
- Admin session (`req.session.appAuthenticated = true`) bypasses token check.
- Otherwise, `?token=` query param must match the employee's `personalAccessToken`.
- Unauthorized: HTTP 401.

### Save (POST) validation — per entry
1. **Hours range:** `0 ≤ hours ≤ 24`. The Zod body schema (`z.number().min(0).max(24)`) validates the whole entries array upfront — any entry with hours outside this range causes the entire POST to fail with HTTP 400. A secondary runtime guard (`if (hours < 0 || hours > 24) continue`) is present but is dead code because Zod fires first.
2. **Deletion:** `hours === 0` always allowed regardless of role assignment (deletes the DB row if it exists).
3. **Grandfather clause:** if an entry with `(employeeId, projectId, projectRoleId, entryDate)` already exists in the DB, it is allowed to be updated even if the role is no longer assigned.
4. **New entry — null role:** new entries with `projectRoleId = null` are rejected (403) unless grandfathered. Legacy no-role entries can only be updated, not created.
5. **New entry — unassigned role:** if `projectRoleId` is not in the employee's `project_role_assignments`, returns HTTP 403.
6. **Role-project mismatch:** if `projectRoleId` is assigned but belongs to a different `projectId` than submitted, returns HTTP 403.

### Upsert behaviour
- If an existing row matches on `(employeeId, projectId, projectRoleId, entryDate)`: update `hours` and `note`.
- If no existing row and `hours > 0`: insert a new row.
- If no existing row and `hours == 0`: no-op (nothing to delete).

---

## Project Health & Status

**Source:** `artifacts/api-server/src/routes/projectStatus.ts`

### Allowed enum values
| Field | Values |
|-------|--------|
| `generalStatus` | `planned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` |
| `riskLevel` | `low` \| `medium` \| `high` |
| `clientSatisfaction` | `happy` \| `neutral` \| `critical` |
| `budgetStatus` | free-form varchar(20) |

### Budget progress formula
```
budgetTotal    = Σ(budgetedDays × dayRate)    for all project roles with budgetedDays set
budgetConsumed = Σ((hours / 8) × dayRate)     for all time_entries with a linked role
budgetProgress = budgetConsumed / budgetTotal × 100
```
(Computed as a subquery in the project-status list/detail endpoints.)

### Health update behaviour
Posting a health update (`POST /api/project-status/:id/health-updates`) runs inside a DB transaction that:
1. Inserts a new row into `project_health_updates` (append-only audit log).
2. Updates `projects.general_status`, `projects.risk_level`, and `projects.client_satisfaction` to reflect the new status.
`budgetStatus` is stored only on the health-update row, not patched to `projects`.

---

## Authentication & Access Control

### Admin session (app-password gate)
- `POST /api/auth/app/login` — validates `password` against `APP_ACCESS_PASSWORD` env var; sets `req.session.appAuthenticated = true`. Cookie name: `zeit.sid`. Rate limited: 10 attempts per 15 minutes (failed only).
- `POST /api/auth/app/logout` — destroys session, clears cookie.
- `GET /api/auth/app/me` — returns `{ authenticated: true/false }`.

### Admin-only routes
All routes are admin-only by default via `requireAppAuth` middleware, **except**:
- `/healthz` (public)
- `/auth/app/login`, `/auth/app/logout`, `/auth/app/me` (public)
- Paths starting with `/auth/employee/` (public)
- Paths starting with `/employee-timesheet/` (public, validated by token instead)

### Employee portal token flow
1. Employee visits `/u/:token` (frontend route).
2. Frontend calls `GET /api/auth/employee/token/:token` to fetch employee info (name, capacity, mask).
3. Frontend prompts for PIN.
4. Frontend calls `POST /api/auth/employee/verify` with `{ token, pin }`.
5. Server verifies `SHA-256(pin) === personalAccessPinHash`.
6. On success: server returns employee profile (excluding pin hash). Frontend stores verified state in `sessionStorage` for the tab session.
7. All subsequent portal API calls include `?token=` query param.

### PIN hashing
- Algorithm: **SHA-256** (via Node.js `crypto.createHash('sha256')`), stored as a hex string in `personal_access_pin_hash`.
- Implementation note: the code comment in `crypto.ts` explicitly acknowledges that SHA-256 is used for simplicity in this lightweight internal tool and recommends **bcrypt or scrypt** for production hardening (brute-force resistance). The hashing function is isolated in `artifacts/api-server/src/lib/crypto.ts` — replacing the algorithm only requires changing `hashPin` and `verifyPin` there.

### Access token generation
- `randomBytes(24).toString('base64url')` — 32-character URL-safe string.

---

## Working Days Mask Reference

**Format:** comma-separated string of 7 values, e.g. `"1,1,1,1,1,0,0"`.

| Index | Day |
|-------|-----|
| 0 | Monday |
| 1 | Tuesday |
| 2 | Wednesday |
| 3 | Thursday |
| 4 | Friday |
| 5 | Saturday |
| 6 | Sunday |

**ISO conversion from `getUTCDay()`:**
```
getUTCDay() returns: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
isoDayIndex = (getUTCDay() === 0) ? 6 : getUTCDay() - 1
```

**Where the mask is used:**
- `calculateAvailableHours()` — to skip non-working days.
- Resource booking planned-hours calculation — to determine which days in a booking range are bookable.
- Employee portal timesheet pre-fill — to count working days in a booking overlap.
- Resource Planner overbooking detection — to check whether a booking day exceeds daily capacity.

---

## UI Rules & Visual Constraints

### Reports (utilization colour scale)
```
0%          → grey / no colour
1% – 69%    → yellow / amber (under-utilised warning)
70% – 100%  → green (healthy)
> 100%      → red (over-capacity)
```
If an employee has `utilizationTarget` set, the threshold shifts: below target = amber, at or above target = green. The column header shows the employee's target percentage.

### Timesheet (admin grid)
- **Locked cells:** cells on public holidays, vacation/absence days, or days outside the employee's contract period are visually locked and not editable.
- **Over-capacity row highlight:** if total hours in a row exceeds the employee's daily capacity, the row is highlighted (capacity warning).
- **Dirty guard:** unsaved changes trigger a browser `beforeunload` prompt. `Ctrl+S` triggers save.
- **Copy-last-week:** copies the previous week's project structure (which projects/roles appear in the grid) but not the actual hours. Hours start at zero for the new week.

### Resource Planner (day-cell timeline — `src/pages/resource-planner-timeline.tsx`)
- **Fixed row height:** every employee row is exactly 64px, never content-driven. Concurrent bookings split a day cell into max 2 equal lanes; a 3rd+ concurrent booking shows a small "+N" badge (hover reveals the full breakdown) without changing row height.
- **Day-cell rendering:** a day with 0 booked hours breaks the bar; consecutive booked days merge into one rounded run with per-day proportional fill (booked ÷ daily capacity). Partial days show one right-aligned "Xh free" chip per run (runs ≥ 90px); overbooked days get a red bottom strip and a "-Xh" chip.
- **Coarse-zoom continuity (`bridgeGaps`, month/quarter/year):** booking bars bridge weekends (rendered solid); multi-day absences merge into one continuous block spanning weekends inside their range. Real gaps (separate bookings, part-time off-days, absences inside a booking) still break bars. Week zoom keeps true per-day cells.
- **Absences:** inline neutral-gray cells with icons (holiday=star, vacation=sun, sick=thermometer, unpaid=X) — never stripes or color overlays; click to edit. Employees with no bookings in the window show an "Available" label at full row height.
- **Bars show only the role name** (fallback: project name when the booking has no role); client/project/dates/rate live in the tooltip, which also shows `used / budgeted` (= logged + re-plannable) and an amber stale-plan warning when applicable.
- **Project filter:** searchable, client-grouped FilterPanel with active-count badge; unchecking hides segments — people stay visible.
- **Budget validation (booking modal):** live check against `GET /api/project-roles/:id/budget-status`; consumption bar = Logged + Re-plannable with a red overshoot zone past the budget line; info popover states `Budget = Logged + Re-plannable + Unplanned` and shows a Stale row when > 0. Past-plan release button writes off undelivered days as of the release date.
- **Tentative bookings** render with a dashed border and reduced opacity; released bookings render dimmed.
- **Project-colour bars:** bookings are rendered with the project's colour (or palette fallback from `resolveProjectColor`).

### Billing page
- **Unbilled amount > 0:** yellow/amber highlight on the row.
- **Fully invoiced (unbilled = 0, invoiced > 0):** green.
- **Remaining budget < 5% of total budget:** red warning.

### Project Status page
- `generalStatus` colour: `planned`=grey, `in_progress`=blue, `on_hold`=amber, `completed`=green, `cancelled`=red.
- `riskLevel` colour: `low`=green, `medium`=amber, `high`=red.
- `clientSatisfaction` colour: `happy`=green, `neutral`=amber, `critical`=red.

---

## Complete API Endpoint Reference

All routes are prefixed with `/api`. Admin session required unless noted.

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/app/login` | Public | Login with `{ password }`. Sets session cookie. |
| POST | `/auth/app/logout` | Public | Destroys session. |
| GET | `/auth/app/me` | Public | Returns `{ authenticated }`. |
| POST | `/auth/employee/verify` | Public | Verify employee PIN: `{ token, pin }`. Returns employee profile. |
| GET | `/auth/employee/token/:token` | Public | Fetch employee profile by access token. |

### Clients (in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/clients` | Admin | List all clients. |
| POST | `/clients` | Admin | Create client. |
| GET | `/clients/:id` | Admin | Get client by id. |
| PATCH | `/clients/:id` | Admin | Update client (partial). |
| DELETE | `/clients/:id` | Admin | Delete client (errors if projects exist). |

### Employees (in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/employees` | Admin | List active employees. |
| POST | `/employees` | Admin | Create employee. |
| GET | `/employees/:id` | Admin | Get employee by id. |
| PATCH | `/employees/:id` | Admin | Update employee fields (partial). |
| DELETE | `/employees/:id` | Admin | Delete employee. |
| POST | `/employees/:id/reset-pin` | Admin | Regenerate PIN and access token. |

### Projects (in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/projects` | Admin | List projects. |
| POST | `/projects` | Admin | Create project. |
| GET | `/projects/:id` | Admin | Get project by id. |
| PATCH | `/projects/:id` | Admin | Update project (partial). |
| DELETE | `/projects/:id` | Admin | Delete project. |

### Holiday Calendars (in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/holiday-calendars` | Admin | List calendars. |
| POST | `/holiday-calendars` | Admin | Create calendar. |
| GET | `/holiday-calendars/:id/holidays` | Admin | Get holidays for a calendar. |
| POST | `/holiday-calendars/:id/holidays` | Admin | Add holiday to calendar. |
| DELETE | `/holidays/:id` | Admin | Remove holiday by holiday id. |

### Time Entries (in OpenAPI spec)

| Method | Path | Auth | Query / Body | Notes |
|--------|------|------|-------------|-------|
| GET | `/time-entries` | Admin | `?employeeId, projectId, startDate, endDate` | Returns enriched entries with project/role names. |
| POST | `/time-entries` | Admin | `{ employeeId, projectId, projectRoleId?, entryDate, hours, note? }` | |
| POST | `/time-entries/bulk` | Admin | `{ entries[] }` | Bulk upsert. Must appear before `/:id` route. |
| GET | `/time-entries/:id` | Admin | — | |
| PATCH | `/time-entries/:id` | Admin | Partial fields: `hours`, `note`, `projectRoleId` | |
| DELETE | `/time-entries/:id` | Admin | — | |

### Resource Bookings (not in OpenAPI spec)

| Method | Path | Auth | Query / Body | Notes |
|--------|------|------|-------------|-------|
| GET | `/resource-bookings` | Admin | `?employeeId, startDate, endDate` | Date filter: bookings whose range overlaps `[startDate,endDate]`. |
| POST | `/resource-bookings` | Admin | `{ employeeId, projectId, projectRoleId?, startDate, endDate, hoursPerDay?, weekdayHours?, notes?, status? }` | Either `hoursPerDay` or `weekdayHours` required. Side-effect: notification queue upsert. |
| PUT | `/resource-bookings/:id` | Admin | Same as POST | Full replace. Side-effect: notification queue upsert. |
| DELETE | `/resource-bookings/:id` | Admin | — | Returns `{ success: true }`. Side-effect: removes unsent notification queue row. |
| GET | `/resource-bookings/:id/past-undelivered` | Admin | — | `{ pastUndeliveredDays }` — undelivered days before today; for released bookings, counts only days from the release date on. |
| POST | `/resource-bookings/:id/release-past` | Admin | — | Stamps `past_released_at = now()` (write-off frozen at that date). Returns the updated booking. |
| POST | `/resource-bookings/:id/unrelease` | Admin | — | Clears `past_released_at`. Returns the updated booking. |
| POST | `/resource-bookings/release-past-bulk` | Admin | `{ projectId?, employeeId?, dryRun? }` | Bulk-release past undelivered plan; returns `{ released[] }`. |

### Project Roles (not in OpenAPI spec)

| Method | Path | Auth | Body | Notes |
|--------|------|------|------|-------|
| GET | `/projects/:id/roles` | Admin | — | Returns roles enriched with `assignedEmployees[]`. |
| POST | `/projects/:id/roles` | Admin | `{ name, dayRate, budgetedDays?, budgetedHours?, assignedEmployeeIds? }` | |
| PUT | `/project-roles/:id` | Admin | Partial of above | `assignedEmployeeIds` replaces all assignments if provided. |
| DELETE | `/project-roles/:id` | Admin | — | Cascades to assignments; sets time entry + booking role FK to null. |
| GET | `/project-roles/:id/budget-status` | Admin | `?excludeBookingId, ?employeeId` | Returns `{ budgetedDays, plannedDays, loggedDays, invoicedDays, reservedDays, stalePlanDays, unplannedDays, freeDays, remainingBudgetDays, loggedNotInvoicedDays, employeeLoggedDays, employeeInvoicedDays, bookings[] }` (see Budget Reconciliation). |
| GET | `/projects/:id/budget` | Admin | — | Budget tab: per-role reconciliation buckets (`invoicedDays/reservedDays/stalePlanDays/unplannedDays/freeDays/…`) + logged (`bookedHours/bookedDays/bookedValue`) with totals. |
| GET | `/projects/:id/allocations` | Admin | — | Allocations tab: per-employee per-role planned vs booked summary + reconciliation buckets per role. |

### Billing (not in OpenAPI spec)

| Method | Path | Auth | Query / Body | Notes |
|--------|------|------|-------------|-------|
| GET | `/billing` | Admin | `?startDate, ?endDate` | All projects grouped by client → project → role → employee. |
| GET | `/projects/:id/billing` | Admin | `?startDate, ?endDate` | Single project: logged/invoiced/invest/unbilled per role + employee. |
| GET | `/projects/:id/billing/history` | Admin | — | Invoice history grouped by reference or timestamp. |
| POST | `/time-entries/mark-invoiced` | Admin | `{ projectId, startDate?, endDate?, invoiceReference? }` | **Legacy.** Stamps all unbilled (non-invest) entries for a project as `billing_status='invoiced'`. |
| POST | `/time-entries/update-billing-status` | Admin | `{ projectId, items[{roleId, employeeId?}], status:'invoiced'\|'invest'\|null, startDate?, endDate?, invoiceReference? }` | Bulk update per role+employee. |

### Vacation / Absence (not in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/vacations` | Admin | `?employeeId` — filter by employee. Ordered by `startDate` DESC. |
| POST | `/vacations` | Admin | `{ employeeId, startDate, endDate, vacationType?, note? }`. `vacationType` defaults to `"vacation"`. |
| PATCH | `/vacations/:id` | Admin | Partial: `startDate`, `endDate`, `vacationType`, `note`. Validates `endDate >= startDate` after merge. |
| DELETE | `/vacations/:id` | Admin | Returns 204. |

### Employee Timesheet Portal (not in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/employee-timesheet/:employeeId/week/:weekStart` | Token or Admin | Returns `{ employee, week, availableProjects, prefilled[], vacations[], holidays[] }`. `weekStart` must be `YYYY-MM-DD`. |
| POST | `/employee-timesheet/:employeeId/week/:weekStart` | Token or Admin | Body: `{ entries[{ projectId, projectRoleId?, entryDate, hours, note? }] }`. Validates role assignment. |

### Project Status / Health (not in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/project-status` | Admin | Overview: all projects with latest health, budget total/consumed. |
| GET | `/project-status/:id` | Admin | Detail: project + full health update history. |
| POST | `/project-status/:id/health-updates` | Admin | `{ generalStatus, riskLevel, budgetStatus?, clientSatisfaction?, comment? }`. Transactional: inserts health row + patches project status fields. |

### Reports (in OpenAPI spec)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/reports/utilization` | Admin | `?startDate, ?endDate, ?employeeId`. Per-employee available/billable/total hours + utilization percentages. |
| GET | `/reports/projects` | Admin | `?startDate, ?endDate`. Per-project total/billable/non-billable hours. |
| GET | `/reports/clients` | Admin | `?startDate, ?endDate`. Per-client totals. |
| GET | `/reports/pivot` | Admin | Pivot report (employee × project matrix). |

### Dashboard

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/dashboard/summary` | Admin | Current-week summary: total/billable hours, per-employee utilization. |

### Saved Reports

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/saved-reports` | Admin | List saved report configurations. |
| POST | `/saved-reports` | Admin | `{ name, config }` — config is a JSON string. |
| DELETE | `/saved-reports/:id` | Admin | Returns 204. |

### Misc

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/healthz` | Public | Health check. Returns `{ ok: true }`. |

---

## Database Schema

- `clients` — clients table
- `projects` — projects (belongs to client, billable flag)
- `employees` — employees with capacity, working days mask, contract dates, hashed PIN, access token
- `employee_vacations` — absence entries (vacation/sick/unpaid_leave/other) per employee with date ranges
- `holiday_calendars` — calendar registry (DE-BASE-2026 seeded)
- `holidays` — individual holiday dates per calendar
- `time_entries` — time entries (employee, project, optional `project_role_id`, date, hours, note, `invoiced_at` timestamptz nullable, `invoice_reference` varchar(100) nullable, `billing_status` varchar(20) nullable — 'invoiced'|'invest'|null)
- `project_roles` — T&M roles per project (name, day_rate, budgeted_days, budgeted_hours)
- `project_role_assignments` — many-to-many: employee assigned to a project role
- `resource_bookings` — planned resource allocations (flat or weekday-mode hours)
- `project_health_updates` — append-only health update log per project
- `saved_reports` — saved report filter/config snapshots (UUID PK)

## Architecture

```
artifacts/
  api-server/      # Express 5 backend
    src/routes/    # clients, projects, employees, holidays, timeEntries, reports, pivot, vacations, dashboard, auth, billing, resourceBookings, projectRoles, projectStatus, savedReports, employeeTimesheet
    src/lib/       # utilization.ts, employee-availability.ts, booking-hours.ts, budget-reconciliation.ts (+tests), crypto.ts
  time-tracker/    # React + Vite frontend
    src/pages/     # Dashboard, Timesheet, Clients, Projects, Employees, Holidays, Vacations, Reports, Billing, EmployeePortal, ResourcePlanner (+resource-planner-timeline.tsx day-cell renderer), ProjectStatus
    src/components/shared/  # 16 reusable avanai-CI components (see Features)
    src/mocks/     # dev-only mock API: db.json fixtures + fetch interceptor (VITE_MOCK=1 / `dev:mock` only)
    gallery.html + src/gallery-main.tsx  # dev-only component gallery (not in production build)
    vite.config.mock.ts  # mock-mode Vite config (defaults PORT/BASE_PATH, sets VITE_MOCK=1)
lib/
  api-spec/        # openapi.yaml (source of truth)
  api-client-react/ # Generated React Query hooks
  api-zod/         # Generated Zod schemas (used by server)
  db/              # Drizzle schema + client
scripts/
  src/seed.ts      # Demo data seeder
```

## Important Notes

- API server imports `zod/v4` — NOT plain `zod` (esbuild won't resolve plain "zod")
- `calculateAvailableHours()` signature: (startDate, endDate, mask, weeklyHrs, holidayDates, vacationSet, contractStart?, contractEnd?)
- `fetchEmpAvailabilityMap()` in `employee-availability.ts` — shared helper for dashboard/reports/pivot to fetch holidays+vacations in one pass
- Working days mask stored as "1,1,1,1,1,0,0" (Mon=index 0, Sun=index 6); use `getUTCDay()` for weekday detection
- PINs are SHA-256 hashed; access tokens are base64url random 24 bytes
- `round2` = `Math.round(n * 100) / 100` — used throughout billing for 2-decimal-place precision
- `resolveProjectColor(projectId, color)` in `@workspace/api-zod` — returns the stored color or a deterministic palette fallback based on project ID
- Never use `console.log` in server code — use `req.log` in route handlers and the singleton `logger` elsewhere
- All dates are handled as UTC midnight; never use local-time Date methods (`getDay()` etc.) — always use `getUTC*` variants
- **Budget identity is `Budget = Logged + Reserved + Unplanned`** (never invoiced-based) and the past-plan release cutoff is the **release date**, not "today" — see the Budget Reconciliation section. Any change to `budget-reconciliation.ts` must keep its 33 unit tests green.
- The frontend mock (`src/mocks/`) mirrors backend route shapes AND the budget reconciliation model — when either changes, update the mock for parity (`pnpm --filter @workspace/time-tracker run dev:mock` should always demo current behaviour)
- Design tokens (avanai CI brand + semantic status colors) are Tailwind v4 `@theme` entries in `artifacts/time-tracker/src/index.css` — there is no `tailwind.config.js`
