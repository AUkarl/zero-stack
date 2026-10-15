CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'credential' NOT NULL,
	`provider_account_id` text,
	`access_token` text,
	`refresh_token` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `commenters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`email_md5` text,
	`link` text,
	`user_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `commenters_user_idx` ON `commenters` (`user_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_slug` text NOT NULL,
	`parent_id` text,
	`depth` integer DEFAULT 1 NOT NULL,
	`root_id` text,
	`author_type` text DEFAULT 'commenter' NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`author_email` text,
	`author_link` text,
	`content` text NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL,
	`ip` text,
	`user_agent` text,
	`is_legacy` integer DEFAULT false NOT NULL,
	`legacy_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_post_idx` ON `comments` (`post_slug`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_parent_idx` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE INDEX `comments_root_idx` ON `comments` (`root_id`);--> statement-breakpoint
CREATE TABLE `email_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`post_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `email_logs_post_idx` ON `email_logs` (`post_id`,`status`);--> statement-breakpoint
CREATE TABLE `friend_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`friend_id` text NOT NULL,
	`title` text NOT NULL,
	`link` text NOT NULL,
	`summary` text,
	`pub_date` integer,
	`fetched_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`friend_id`) REFERENCES `friends`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friend_posts_link_idx` ON `friend_posts` (`friend_id`,`link`);--> statement-breakpoint
CREATE INDEX `friend_posts_date_idx` ON `friend_posts` (`pub_date`);--> statement-breakpoint
CREATE TABLE `friends` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`avatar` text,
	`rss_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`cooldown_until` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friends_url_idx` ON `friends` (`url`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`started_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `job_runs_name_idx` ON `job_runs` (`name`,`started_at`);--> statement-breakpoint
CREATE TABLE `moments` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`media` text DEFAULT '[]' NOT NULL,
	`location` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_url` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`scheduled_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `moments_created_idx` ON `moments` (`created_at`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_slug` text NOT NULL,
	`kind` text DEFAULT 'like' NOT NULL,
	`user_id` text,
	`fingerprint` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_unique_idx` ON `reactions` (`target_slug`,`kind`,`user_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `reactions_target_idx` ON `reactions` (`target_slug`,`kind`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `site_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`value_type` text DEFAULT 'string' NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ip` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`confirmed_at` integer,
	`unsubscribed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_idx` ON `subscribers` (`email`);--> statement-breakpoint
CREATE INDEX `subscribers_status_idx` ON `subscribers` (`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`password_hash` text,
	`image` text,
	`role` text DEFAULT 'reader' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`identifier` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visits` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`referrer` text,
	`country` text,
	`device` text,
	`browser` text,
	`os` text,
	`duration` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visits_created_idx` ON `visits` (`created_at`);--> statement-breakpoint
CREATE INDEX `visits_session_idx` ON `visits` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `visits_path_idx` ON `visits` (`path`);