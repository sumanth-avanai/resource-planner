import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, savedReportsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/saved-reports", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(savedReportsTable)
    .orderBy(desc(savedReportsTable.createdAt));
  res.json(rows);
});

router.post("/saved-reports", async (req, res): Promise<void> => {
  const { name, config } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof config !== "string" || !config.trim()) {
    res.status(400).json({ error: "config is required" });
    return;
  }

  const [row] = await db
    .insert(savedReportsTable)
    .values({ name: name.trim(), config })
    .returning();

  res.status(201).json(row);
});

router.delete("/saved-reports/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const [deleted] = await db
    .delete(savedReportsTable)
    .where(eq(savedReportsTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
