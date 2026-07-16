import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";
import { VerifyEmployeePinBody, GetEmployeeByTokenParams } from "@workspace/api-zod";
import { verifyPin } from "../lib/crypto";

const router: IRouter = Router();

router.post("/auth/employee/verify", async (req, res): Promise<void> => {
  const parsed = VerifyEmployeePinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [emp] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.personalAccessToken, parsed.data.token));

  if (!emp) {
    res.status(401).json({ error: "Invalid token or PIN" });
    return;
  }

  if (!verifyPin(parsed.data.pin, emp.personalAccessPinHash)) {
    res.status(401).json({ error: "Invalid token or PIN" });
    return;
  }

  res.json({
    id: emp.id,
    name: emp.name,
    email: emp.email,
    weeklyCapacityHours: emp.weeklyCapacityHours,
    workingDaysMask: emp.workingDaysMask.split(",").map(Number),
    holidayCalendarCode: emp.holidayCalendarCode,
    personalAccessToken: emp.personalAccessToken,
    active: emp.active,
    createdAt: emp.createdAt,
  });
});

router.get("/auth/employee/token/:token", async (req, res): Promise<void> => {
  const params = GetEmployeeByTokenParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [emp] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.personalAccessToken, params.data.token));

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  res.json({
    id: emp.id,
    name: emp.name,
    email: emp.email,
    weeklyCapacityHours: emp.weeklyCapacityHours,
    workingDaysMask: emp.workingDaysMask.split(",").map(Number),
    holidayCalendarCode: emp.holidayCalendarCode,
    contractStartDate: emp.contractStartDate,
    contractEndDate: emp.contractEndDate,
    personalAccessToken: emp.personalAccessToken,
    active: emp.active,
    createdAt: emp.createdAt,
  });
});

export default router;
