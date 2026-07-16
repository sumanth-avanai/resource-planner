/**
 * One-time data migration — run with:
 *   pnpm --filter @workspace/scripts run fix-working-days
 *
 * What it does:
 *  1. Updates any employees whose working_days_mask is "0,1,1,1,1,1,0"
 *     (Tue–Sat) to "1,1,1,1,1,0,0" (Mon–Fri).
 *  2. Moves any time entries booked on a Saturday to the Monday of the
 *     same ISO week.  If a Monday entry already exists for the same
 *     employee + project it sums the hours and deletes the Saturday row;
 *     otherwise it simply updates the date in place.
 */

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ── 1. Fix employee working-days masks ─────────────────────────────────
    const empResult = await client.query<{ id: number; name: string }>(
      `UPDATE employees
         SET working_days_mask = '1,1,1,1,1,0,0'
       WHERE working_days_mask = '0,1,1,1,1,1,0'
       RETURNING id, name`
    );
    console.log(
      empResult.rowCount
        ? `  Fixed ${empResult.rowCount} employee(s): ${empResult.rows.map((r) => r.name).join(", ")}`
        : "  No employees needed a mask fix."
    );

    // ── 2. Find all Saturday time entries ──────────────────────────────────
    // In PostgreSQL EXTRACT(DOW ...) returns 0=Sunday … 6=Saturday
    const satRows = await client.query<{
      id: number;
      employee_id: number;
      project_id: number;
      entry_date: string;
      hours: number;
      note: string | null;
    }>(
      `SELECT id, employee_id, project_id, entry_date, hours, note
         FROM time_entries
        WHERE EXTRACT(DOW FROM entry_date::date) = 6
        ORDER BY entry_date`
    );

    if (satRows.rowCount === 0) {
      console.log("  No Saturday time entries found.");
    } else {
      console.log(`  Found ${satRows.rowCount} Saturday time entry/entries to migrate.`);

      let moved = 0;
      let merged = 0;

      for (const row of satRows.rows) {
        // Monday of the same ISO week = Saturday − 5 days
        const mondayDate = new Date(row.entry_date);
        mondayDate.setUTCDate(mondayDate.getUTCDate() - 5);
        const mondayStr = mondayDate.toISOString().slice(0, 10);

        // Check if a Monday entry already exists for same employee + project
        const existing = await client.query<{ id: number; hours: number }>(
          `SELECT id, hours FROM time_entries
            WHERE employee_id = $1
              AND project_id  = $2
              AND entry_date  = $3`,
          [row.employee_id, row.project_id, mondayStr]
        );

        if (existing.rowCount && existing.rowCount > 0) {
          // Sum hours into the existing Monday row, then delete the Saturday row
          const newHours = existing.rows[0].hours + row.hours;
          await client.query(
            `UPDATE time_entries SET hours = $1 WHERE id = $2`,
            [newHours, existing.rows[0].id]
          );
          await client.query(`DELETE FROM time_entries WHERE id = $1`, [row.id]);
          console.log(
            `    Merged Sat ${row.entry_date} → Mon ${mondayStr} ` +
              `(emp ${row.employee_id}, proj ${row.project_id}): ` +
              `${existing.rows[0].hours} + ${row.hours} = ${newHours} hrs`
          );
          merged++;
        } else {
          // Simply move the date to Monday
          await client.query(
            `UPDATE time_entries SET entry_date = $1 WHERE id = $2`,
            [mondayStr, row.id]
          );
          console.log(
            `    Moved Sat ${row.entry_date} → Mon ${mondayStr} ` +
              `(emp ${row.employee_id}, proj ${row.project_id}, ${row.hours} hrs)`
          );
          moved++;
        }
      }

      console.log(
        `  Saturday migration complete: ${moved} moved, ${merged} merged.`
      );
    }

    await client.query("COMMIT");
    console.log("Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed — rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
