CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`action` text NOT NULL,
	`target` text,
	`detail` text,
	`ip` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_time_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `friend_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`avatar` text,
	`rss_url` text,
	`email` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_id` text,
	`review_note` text,
	`ip` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`reviewed_at` integer,
	`published_friend_id` text,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `friend_apps_status_idx` ON `friend_applications` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `friend_apps_url_idx` ON `friend_applications` (`url`);--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`note` text,
	`created_by` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_codes_code_idx` ON `invite_codes` (`code`);--> statement-breakpoint
CREATE INDEX `invite_codes_status_idx` ON `invite_codes` (`status`);--> statement-breakpoint
ALTER TABLE `comments` ADD `spam_score` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `spam_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `invited_by` text;