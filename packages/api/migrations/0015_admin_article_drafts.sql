CREATE TABLE `admin_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`front` text DEFAULT '{}' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`sha` text DEFAULT '' NOT NULL,
	`notify` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_drafts_user_path_idx` ON `admin_drafts` (`user_id`,`path`);--> statement-breakpoint
CREATE INDEX `admin_drafts_user_time_idx` ON `admin_drafts` (`user_id`,`updated_at`);