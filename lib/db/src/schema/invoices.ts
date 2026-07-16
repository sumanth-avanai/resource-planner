import { pgTable, serial, integer, real, varchar, timestamp, date } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { projectRolesTable } from "./projectRoles";
import { employeesTable } from "./employees";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  totalAmount: real("total_amount").notNull(),
  reference: varchar("reference", { length: 100 }),
});

export const invoiceItemsTable = pgTable("invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  roleId: integer("role_id").references(() => projectRolesTable.id, { onDelete: "set null" }),
  employeeId: integer("employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
});

export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceItem = typeof invoiceItemsTable.$inferSelect;
