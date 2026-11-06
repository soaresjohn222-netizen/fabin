CREATE TABLE `restore_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_hash` text NOT NULL,
	`manifest_json` text NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_restore_source` ON `restore_jobs` (`source_hash`);--> statement-breakpoint
CREATE TABLE `restore_rows` (
	`job_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key` text NOT NULL,
	`row_json` text NOT NULL,
	`row_hash` text NOT NULL,
	PRIMARY KEY(`job_id`, `table_name`, `row_key`),
	FOREIGN KEY (`job_id`) REFERENCES `restore_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
