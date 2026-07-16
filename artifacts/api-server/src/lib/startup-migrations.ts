/**
 * Startup migrations — idempotent DB fixes that run once on server boot.
 * Safe to run repeatedly.
 */
import { db, employeesTable, timeEntriesTable, projectsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PROJECT_COLORS } from "@workspace/api-zod";
import { logger } from "./logger";

export async function runStartupMigrations(): Promise<void> {
  await migrateHoursPerWeekToHoursPerDay();
  await addPastReleasedAtColumn();
  await fixWorkingDaysMasks();
  await deleteZeroHourEntries();
  await backfillProjectColors();
  await createNotificationQueueTable();
  await migrateNotificationQueueAddBookingId();
}

/**
 * Task #74: hoursPerWeek → hoursPerDay column migration.
 *
 * If `hours_per_week` still exists (environment not yet schema-pushed),
 * add `hours_per_day`, backfill from `hours_per_week` using ÷5 rounding,
 * then drop the old column.  If `hours_per_week` is already gone this is a
 * complete no-op — safe to run on every boot.
 */
async function migrateHoursPerWeekToHoursPerDay(): Promise<void> {
  try {
    const result = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'resource_bookings'
          AND column_name  = 'hours_per_week'
      ) AS exists
    `);

    const rows = Array.isArray(result) ? result : (result as { rows: { exists: boolean }[] }).rows;
    if (!rows[0]?.exists) return;

    logger.info("startup-migration: backfilling hours_per_day from hours_per_week");

    await db.execute(sql`
      ALTER TABLE resource_bookings
        ADD COLUMN IF NOT EXISTS hours_per_day REAL;

      UPDATE resource_bookings
        SET hours_per_day = ROUND(CAST(hours_per_week / 5.0 AS NUMERIC), 2)
        WHERE hours_per_day IS NULL;

      ALTER TABLE resource_bookings
        ALTER COLUMN hours_per_day SET NOT NULL;

      ALTER TABLE resource_bookings
        DROP COLUMN IF EXISTS hours_per_week;
    `);

    logger.info("startup-migration: hours_per_day backfill complete");
  } catch (err) {
    logger.error({ err }, "startup-migration: migrateHoursPerWeekToHoursPerDay failed");
  }
}

/**
 * Add past_released_at TIMESTAMPTZ column to resource_bookings if missing.
 * Idempotent — safe to run on every boot.
 */
async function addPastReleasedAtColumn(): Promise<void> {
  try {
    const result = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name  = 'resource_bookings'
          AND column_name = 'past_released_at'
      ) AS exists
    `);

    const rows = Array.isArray(result) ? result : (result as { rows: { exists: boolean }[] }).rows;
    if (rows[0]?.exists) return;

    logger.info("startup-migration: adding past_released_at column to resource_bookings");

    await db.execute(sql`
      ALTER TABLE resource_bookings
        ADD COLUMN IF NOT EXISTS past_released_at TIMESTAMPTZ
    `);

    logger.info("startup-migration: past_released_at column added to resource_bookings");
  } catch (err) {
    logger.error({ err }, "startup-migration: addPastReleasedAtColumn failed");
  }
}

/**
 * Fix employees whose working_days_mask is "0,1,1,1,1,1,0" (old Tue–Sat default)
 * and update them to "1,1,1,1,1,0,0" (correct Mon–Fri).
 */
async function fixWorkingDaysMasks(): Promise<void> {
  try {
    const result = await db
      .update(employeesTable)
      .set({ workingDaysMask: "1,1,1,1,1,0,0" })
      .where(eq(employeesTable.workingDaysMask, "0,1,1,1,1,1,0"))
      .returning({ id: employeesTable.id, name: employeesTable.name });

    if (result.length > 0) {
      logger.info(
        { fixed: result.map((r) => `${r.id}:${r.name}`) },
        `startup-migration: fixed ${result.length} employee working-day mask(s)`
      );
    }
  } catch (err) {
    logger.error({ err }, "startup-migration: fixWorkingDaysMasks failed");
  }
}

/**
 * Delete any time_entries rows where hours = 0. These should never exist
 * (the bulkUpsert endpoint deletes them), but a cleanup pass is harmless.
 */
async function deleteZeroHourEntries(): Promise<void> {
  try {
    const result = await db
      .delete(timeEntriesTable)
      .where(sql`${timeEntriesTable.hours} = 0`)
      .returning({ id: timeEntriesTable.id });

    if (result.length > 0) {
      logger.info(
        { count: result.length },
        `startup-migration: deleted ${result.length} zero-hour time entr(ies)`
      );
    }
  } catch (err) {
    logger.error({ err }, "startup-migration: deleteZeroHourEntries failed");
  }
}

/**
 * Create the notification_queue table if it does not already exist.
 * Each row is keyed by (employee_email, project_name, booking_id) so that
 * two separate bookings for the same employee+project each get their own
 * queue entry and their own debounced notification.
 * Rows are upserted on booking CREATE/UPDATE (with a 30-minute delay) and
 * deleted on booking DELETE (if not yet sent).
 */
async function createNotificationQueueTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS notification_queue (
        id               SERIAL PRIMARY KEY,
        booking_id       INTEGER     NOT NULL,
        employee_email   TEXT        NOT NULL,
        employee_name    TEXT        NOT NULL,
        project_name     TEXT        NOT NULL,
        role_name        TEXT,
        start_date       DATE        NOT NULL,
        end_date         DATE        NOT NULL,
        hours_per_day    REAL        NOT NULL,
        send_after       TIMESTAMPTZ NOT NULL,
        sent             BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (employee_email, project_name, booking_id)
      )
    `);
  } catch (err) {
    logger.error({ err }, "startup-migration: createNotificationQueueTable failed");
  }
}

/**
 * Migrate an existing notification_queue table from the old
 * UNIQUE (employee_email, project_name) key to the new per-booking key
 * UNIQUE (employee_email, project_name, booking_id).
 *
 * Fully idempotent — safe to run on every boot regardless of how far a
 * previous run got.  Steps:
 *
 *  1. Skip entirely if the table does not exist yet.
 *  2. Add booking_id column as nullable (ADD COLUMN IF NOT EXISTS is a no-op
 *     when the column already exists).
 *  3. Delete ALL rows whose booking_id is NULL — both sent and unsent.
 *     There is no reliable way to backfill booking_id from historical data,
 *     so all pre-migration rows are cleared.  Sent rows have already been
 *     processed; unsent rows cannot be tied to a real booking without the id.
 *  4. Set booking_id NOT NULL (safe because step 3 removed every NULL row).
 *  5. Drop the old two-column constraint if it still exists.
 *  6. Add the new three-column constraint if it does not exist yet.
 *
 * Steps 5–6 run unconditionally (not guarded by the column-exists check) so
 * that partial migration states — e.g. column added on a previous boot but
 * the process crashed before the constraint swap — are always resolved.
 */
async function migrateNotificationQueueAddBookingId(): Promise<void> {
  try {
    const tableExists = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'notification_queue'
      ) AS exists
    `);
    const tableRows = Array.isArray(tableExists)
      ? tableExists
      : (tableExists as { rows: { exists: boolean }[] }).rows;
    if (!tableRows[0]?.exists) return;

    const colExists = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name  = 'notification_queue'
          AND column_name = 'booking_id'
      ) AS exists
    `);
    const colRows = Array.isArray(colExists)
      ? colExists
      : (colExists as { rows: { exists: boolean }[] }).rows;

    if (!colRows[0]?.exists) {
      logger.info("startup-migration: adding booking_id column to notification_queue");

      await db.execute(sql`
        ALTER TABLE notification_queue
          ADD COLUMN IF NOT EXISTS booking_id INTEGER
      `);

      // Remove every legacy row (sent OR unsent) — booking_id cannot be
      // backfilled and any remaining NULL would block SET NOT NULL below.
      await db.execute(sql`
        DELETE FROM notification_queue WHERE booking_id IS NULL
      `);

      await db.execute(sql`
        ALTER TABLE notification_queue
          ALTER COLUMN booking_id SET NOT NULL
      `);

      logger.info("startup-migration: booking_id column added to notification_queue");
    }

    // Always reconcile constraints, even if the column already existed.
    // This handles the case where a previous boot added the column but
    // crashed before completing the constraint swap.
    await db.execute(sql`
      ALTER TABLE notification_queue
        DROP CONSTRAINT IF EXISTS notification_queue_employee_email_project_name_key
    `);

    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'notification_queue_employee_email_project_name_booking_id_key'
        ) THEN
          ALTER TABLE notification_queue
            ADD CONSTRAINT notification_queue_employee_email_project_name_booking_id_key
            UNIQUE (employee_email, project_name, booking_id);
        END IF;
      END
      $$
    `);

    logger.info("startup-migration: notification_queue constraint reconciliation complete");
  } catch (err) {
    logger.error({ err }, "startup-migration: migrateNotificationQueueAddBookingId failed");
  }
}

/**
 * Assign a palette color (derived from project ID) to every project whose
 * color column is NULL. Uses the same 20-color palette and modulo formula
 * as the Resource Planner's `resolveColor` helper so Gantt bars match.
 */
async function backfillProjectColors(): Promise<void> {
  try {
    const nullColorProjects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(isNull(projectsTable.color));

    if (nullColorProjects.length === 0) return;

    for (const { id } of nullColorProjects) {
      const color = PROJECT_COLORS[id % PROJECT_COLORS.length];
      await db
        .update(projectsTable)
        .set({ color })
        .where(and(eq(projectsTable.id, id), isNull(projectsTable.color)));
    }

    logger.info(
      { count: nullColorProjects.length },
      `startup-migration: backfilled colors for ${nullColorProjects.length} project(s)`
    );
  } catch (err) {
    logger.error({ err }, "startup-migration: backfillProjectColors failed");
  }
}
