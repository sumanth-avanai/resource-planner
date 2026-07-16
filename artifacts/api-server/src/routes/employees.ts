import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";
import {
  ListEmployeesQueryParams,
  CreateEmployeeBody,
  GetEmployeeParams,
  UpdateEmployeeParams,
  UpdateEmployeeBody,
  DeleteEmployeeParams,
  ResetEmployeePinParams,
  ResetEmployeePinBody,
} from "@workspace/api-zod";
import { hashPin, generateToken } from "../lib/crypto";

const router: IRouter = Router();

function formatEmployee(emp: typeof employeesTable.$inferSelect) {
  return {
    ...emp,
    workingDaysMask: emp.workingDaysMask.split(",").map(Number),
    personalAccessPinHash: undefined, // never expose hash
  };
}

router.get("/employees", async (req, res): Promise<void> => {
  const query = ListEmployeesQueryParams.safeParse(req.query);
  const includeInactive = query.success ? query.data.includeInactive : false;

  const employees = await db
    .select()
    .from(employeesTable)
    .where(includeInactive ? undefined : eq(employeesTable.active, true))
    .orderBy(employeesTable.name);

  res.json(employees.map(formatEmployee));
});

router.post("/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const token = generateToken();
  const pinHash = hashPin(parsed.data.pin);

  const [emp] = await db
    .insert(employeesTable)
    .values({
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      weeklyCapacityHours: parsed.data.weeklyCapacityHours,
      workingDaysMask: (parsed.data.workingDaysMask ?? [1, 1, 1, 1, 1, 0, 0]).join(","),
      holidayCalendarCode: parsed.data.holidayCalendarCode ?? null,
      contractStartDate:  parsed.data.contractStartDate  ? parsed.data.contractStartDate.toISOString().split("T")[0] : null,
      contractEndDate:    parsed.data.contractEndDate    ? parsed.data.contractEndDate.toISOString().split("T")[0]   : null,
      utilizationTarget:  parsed.data.utilizationTarget  ?? null,
      personalAccessToken: token,
      personalAccessPinHash: pinHash,
      active: parsed.data.active ?? true,
    })
    .returning();

  void (async () => {
    const n8nEmployeeUrl = process.env.N8N_EMPLOYEE_WEBHOOK_URL;
    const n8nUser = process.env.N8N_WEBHOOK_USER;
    const n8nPass = process.env.N8N_WEBHOOK_PASS;
    if (!n8nEmployeeUrl || !n8nUser || !n8nPass) {
      req.log.error("n8n employee webhook not configured: N8N_EMPLOYEE_WEBHOOK_URL, N8N_WEBHOOK_USER, or N8N_WEBHOOK_PASS is missing");
      return;
    }
    try {
      const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0];
      const personalLink = `https://${domain}/u/${emp.personalAccessToken}`;
      const authHeader = "Basic " + Buffer.from(`${n8nUser}:${n8nPass}`).toString("base64");
      const response = await fetch(n8nEmployeeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          name: parsed.data.name,
          email: parsed.data.email ?? null,
          pin: parsed.data.pin,
          personal_link: personalLink,
        }),
      });
      if (!response.ok) {
        req.log.error({ status: response.status }, "n8n employee webhook returned non-2xx");
      }
    } catch (err) {
      req.log.error({ err }, "n8n employee webhook failed");
    }
  })();

  res.status(201).json(formatEmployee(emp));
});

router.get("/employees/:id", async (req, res): Promise<void> => {
  const params = GetEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [emp] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, params.data.id));

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  res.json(formatEmployee(emp));
});

router.patch("/employees/:id", async (req, res): Promise<void> => {
  const params = UpdateEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.workingDaysMask) {
    updateData.workingDaysMask = parsed.data.workingDaysMask.join(",");
  }
  if ("contractStartDate" in parsed.data) updateData.contractStartDate = parsed.data.contractStartDate ? parsed.data.contractStartDate.toISOString().split("T")[0] : null;
  if ("contractEndDate"   in parsed.data) updateData.contractEndDate   = parsed.data.contractEndDate   ? parsed.data.contractEndDate.toISOString().split("T")[0]   : null;

  const [emp] = await db
    .update(employeesTable)
    .set(updateData)
    .where(eq(employeesTable.id, params.data.id))
    .returning();

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  res.json(formatEmployee(emp));
});

router.delete("/employees/:id", async (req, res): Promise<void> => {
  const params = DeleteEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [emp] = await db
    .delete(employeesTable)
    .where(eq(employeesTable.id, params.data.id))
    .returning();

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/employees/:id/reset-pin", async (req, res): Promise<void> => {
  const params = ResetEmployeePinParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = ResetEmployeePinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const token = generateToken();
  const pinHash = hashPin(parsed.data.pin);

  const [emp] = await db
    .update(employeesTable)
    .set({ personalAccessToken: token, personalAccessPinHash: pinHash })
    .where(eq(employeesTable.id, params.data.id))
    .returning();

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  res.json(formatEmployee(emp));
});

export default router;
