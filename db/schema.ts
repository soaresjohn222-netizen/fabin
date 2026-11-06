import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const adminCredentials=sqliteTable("admin_credentials",{
  id:integer("id").primaryKey(),username:text("username").notNull(),passwordHash:text("password_hash").notNull(),createdAt:text("created_at").notNull(),
});

export const restoreJobs=sqliteTable("restore_jobs",{
  id:text("id").primaryKey(),sourceHash:text("source_hash").notNull(),manifestJson:text("manifest_json").notNull(),status:text("status").notNull().default("staging"),createdAt:text("created_at").notNull(),completedAt:text("completed_at"),
},t=>[uniqueIndex("idx_restore_source").on(t.sourceHash)]);
export const restoreRows=sqliteTable("restore_rows",{
  jobId:text("job_id").notNull().references(()=>restoreJobs.id),tableName:text("table_name").notNull(),rowKey:text("row_key").notNull(),rowJson:text("row_json").notNull(),rowHash:text("row_hash").notNull(),
},t=>[primaryKey({columns:[t.jobId,t.tableName,t.rowKey]})]);

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(), name: text("name").notNull(), searchName: text("search_name").notNull(),
  phone: text("phone").notNull().default(""), notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [index("idx_customers_search_name").on(t.searchName)]);
export const motorcycles = sqliteTable("motorcycles", {
  id: text("id").primaryKey(), plate: text("plate"), model: text("model").notNull(),
  customerId: text("customer_id").notNull().references(() => customers.id),
  notes: text("notes").notNull().default(""), sourceSort: text("source_sort"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("idx_motorcycles_plate").on(t.plate), index("idx_motorcycles_customer").on(t.customerId)]);
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(), filename: text("filename").notNull(), fileHash: text("file_hash").notNull(),
  objectKey: text("object_key").notNull(), rowCount: integer("row_count").notNull().default(0),
  status: text("status").notNull().default("awaiting_review"), manifestKey: text("manifest_key"), manifestHash: text("manifest_hash"), expectedCount: integer("expected_count"), reportJson: text("report_json"), completedAt: text("completed_at"), createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("idx_import_batches_hash").on(t.fileHash)]);
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }), requestKey: text("request_key").notNull(),
  customerId: text("customer_id").notNull().references(() => customers.id),
  motorcycleId: text("motorcycle_id").notNull().references(() => motorcycles.id),
  serviceDate: text("service_date").notNull(), serviceDateEnd: text("service_date_end"), datePrecision: text("date_precision").notNull().default("day"), dateOriginal: text("date_original"), legacyJson: text("legacy_json"), reviewIssues: text("review_issues").notNull().default("[]"), totalKnown: integer("total_known").notNull().default(1), odometer: integer("odometer"),
  status: text("status").notNull().default("open"), service: text("service").notNull(),
  itemsJson: text("items_json").notNull().default("[]"), totalCents: integer("total_cents").notNull().default(0),
  notes: text("notes").notNull().default(""), customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull().default(""), plate: text("plate"), model: text("model").notNull(),
  importBatchId: text("import_batch_id").references(() => importBatches.id),
  sourceSheet: text("source_sheet"), sourceRow: integer("source_row"), sourceRaw: text("source_raw"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
  revision: integer("revision").notNull().default(1),
}, t => [uniqueIndex("idx_orders_request_key").on(t.requestKey), index("idx_orders_date").on(t.serviceDate),
  index("idx_orders_customer_date").on(t.customerId,t.serviceDate), index("idx_orders_motorcycle_date").on(t.motorcycleId,t.serviceDate),
  uniqueIndex("idx_orders_source_row").on(t.importBatchId,t.sourceSheet,t.sourceRow)]);
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  action: text("action").notNull(), beforeJson: text("before_json"), afterJson: text("after_json").notNull(), createdAt: text("created_at").notNull(),
}, t => [index("idx_audit_entity").on(t.entityType,t.entityId)]);
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(), credentialVersion: text("credential_version").notNull(),
  expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(),
},t=>[index("idx_sessions_expiry").on(t.expiresAt)]);
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull(),
});

export const expenseImports=sqliteTable("expense_imports",{
  batchId:text("batch_id").primaryKey().references(()=>importBatches.id),manifestKey:text("manifest_key").notNull(),manifestHash:text("manifest_hash").notNull(),expectedCount:integer("expected_count").notNull(),rowCount:integer("row_count").notNull().default(0),status:text("status").notNull().default("ready"),reportJson:text("report_json").notNull(),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
});
export const expenses=sqliteTable("expenses",{
  id:integer("id").primaryKey({autoIncrement:true}),requestKey:text("request_key").notNull(),description:text("description").notNull(),searchDescription:text("search_description").notNull(),amountCents:integer("amount_cents"),kind:text("kind").notNull(),dateStart:text("date_start").notNull(),dateEnd:text("date_end").notNull(),datePrecision:text("date_precision").notNull(),notes:text("notes").notNull().default(""),status:text("status").notNull().default("active"),importBatchId:text("import_batch_id").references(()=>importBatches.id),sourceSheet:text("source_sheet"),sourceRow:integer("source_row"),sourceMode:text("source_mode"),sourceRaw:text("source_raw"),reviewIssues:text("review_issues").notNull().default("[]"),revision:integer("revision").notNull().default(1),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[uniqueIndex("idx_expenses_request_key").on(t.requestKey),uniqueIndex("idx_expenses_source_row").on(t.importBatchId,t.sourceSheet,t.sourceRow),index("idx_expenses_date").on(t.dateStart),index("idx_expenses_kind_date").on(t.kind,t.dateStart)]);
