import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, holidayCalendarsTable, holidaysTable } from "@workspace/db";
import {
  ListHolidaysParams,
  ListHolidaysQueryParams,
  CreateHolidayParams,
  CreateHolidayBody,
  DeleteHolidayParams,
  CreateHolidayCalendarBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/holiday-calendars", async (_req, res): Promise<void> => {
  const calendars = await db
    .select()
    .from(holidayCalendarsTable)
    .orderBy(holidayCalendarsTable.name);
  res.json(calendars);
});

router.post("/holiday-calendars", async (req, res): Promise<void> => {
  const parsed = CreateHolidayCalendarBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [cal] = await db
    .insert(holidayCalendarsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(cal);
});

router.get("/holiday-calendars/:id/holidays", async (req, res): Promise<void> => {
  const params = ListHolidaysParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const query = ListHolidaysQueryParams.safeParse(req.query);

  let conditions = [eq(holidaysTable.calendarId, params.data.id)];
  // Year filter is informational; since date is stored as string "YYYY-MM-DD",
  // we use LIKE filtering via JS after fetch for simplicity
  const holidays = await db
    .select()
    .from(holidaysTable)
    .where(eq(holidaysTable.calendarId, params.data.id))
    .orderBy(holidaysTable.date);

  const year = query.success ? query.data.year : undefined;
  const filtered = year
    ? holidays.filter((h) => h.date.startsWith(String(year)))
    : holidays;

  res.json(filtered);
});

router.post("/holiday-calendars/:id/holidays", async (req, res): Promise<void> => {
  const params = CreateHolidayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateHolidayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [holiday] = await db
    .insert(holidaysTable)
    .values({ calendarId: params.data.id, name: parsed.data.name, date: parsed.data.date.toISOString().split("T")[0] })
    .returning();

  res.status(201).json(holiday);
});

router.delete("/holidays/:id", async (req, res): Promise<void> => {
  const params = DeleteHolidayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [holiday] = await db
    .delete(holidaysTable)
    .where(eq(holidaysTable.id, params.data.id))
    .returning();

  if (!holiday) {
    res.status(404).json({ error: "Holiday not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
