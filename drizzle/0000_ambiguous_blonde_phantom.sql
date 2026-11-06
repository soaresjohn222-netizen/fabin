CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_events` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`search_name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_customers_search_name` ON `customers` (`search_name`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`object_key` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'awaiting_review' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_import_batches_hash` ON `import_batches` (`file_hash`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `motorcycles` (
	`id` text PRIMARY KEY NOT NULL,
	`plate` text,
	`model` text NOT NULL,
	`customer_id` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_motorcycles_plate` ON `motorcycles` (`plate`);--> statement-breakpoint
CREATE INDEX `idx_motorcycles_customer` ON `motorcycles` (`customer_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_key` text NOT NULL,
	`customer_id` text NOT NULL,
	`motorcycle_id` text NOT NULL,
	`service_date` text NOT NULL,
	`odometer` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`service` text NOT NULL,
	`items_json` text DEFAULT '[]' NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text DEFAULT '' NOT NULL,
	`plate` text,
	`model` text NOT NULL,
	`import_batch_id` text,
	`source_sheet` text,
	`source_row` integer,
	`source_raw` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`motorcycle_id`) REFERENCES `motorcycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_request_key` ON `orders` (`request_key`);--> statement-breakpoint
CREATE INDEX `idx_orders_date` ON `orders` (`service_date`);--> statement-breakpoint
CREATE INDEX `idx_orders_customer_date` ON `orders` (`customer_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `idx_orders_motorcycle_date` ON `orders` (`motorcycle_id`,`service_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_source_row` ON `orders` (`import_batch_id`,`source_sheet`,`source_row`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`credential_version` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expiry` ON `sessions` (`expires_at`);
--> statement-breakpoint
PRAGMA optimize;
