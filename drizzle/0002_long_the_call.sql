CREATE TABLE `expense_imports` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`manifest_key` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`expected_count` integer NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`report_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_key` text NOT NULL,
	`description` text NOT NULL,
	`search_description` text NOT NULL,
	`amount_cents` integer,
	`kind` text NOT NULL,
	`date_start` text NOT NULL,
	`date_end` text NOT NULL,
	`date_precision` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`import_batch_id` text,
	`source_sheet` text,
	`source_row` integer,
	`source_mode` text,
	`source_raw` text,
	`review_issues` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_expenses_request_key` ON `expenses` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_expenses_source_row` ON `expenses` (`import_batch_id`,`source_sheet`,`source_row`);--> statement-breakpoint
CREATE INDEX `idx_expenses_date` ON `expenses` (`date_start`);--> statement-breakpoint
CREATE INDEX `idx_expenses_kind_date` ON `expenses` (`kind`,`date_start`);
--> statement-breakpoint
PRAGMA optimize;
