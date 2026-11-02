CREATE TABLE `account_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_id` text,
	`review_note` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `account_deletions_status_idx` ON `account_deletions` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `broadcast_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`post_id` text,
	`post_path` text,
	`scheduled_at` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `broadcast_jobs_status_idx` ON `broadcast_jobs` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `comment_likes` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`user_id` text,
	`fingerprint` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_likes_unique_idx` ON `comment_likes` (`comment_id`,`user_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `comment_likes_comment_idx` ON `comment_likes` (`comment_id`);--> statement-breakpoint
ALTER TABLE `author_requests` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `author_requests` ADD `website` text;--> statement-breakpoint
ALTER TABLE `author_requests` ADD `donate_images` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `ip_hash` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `country` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `city` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `browser` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `os` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `device` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `featured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `owner_key` text;--> statement-breakpoint
ALTER TABLE `users` ADD `account_slug` text;--> statement-breakpoint
ALTER TABLE `users` ADD `user_group` text DEFAULT 'friend' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `visits` ADD `ip_hash` text;