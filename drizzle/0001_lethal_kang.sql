ALTER TABLE `import_batches` ADD `manifest_key` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `manifest_hash` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `expected_count` integer;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `report_json` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `motorcycles` ADD `source_sort` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `service_date_end` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `date_precision` text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `date_original` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `legacy_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `review_issues` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `total_known` integer DEFAULT 1 NOT NULL;