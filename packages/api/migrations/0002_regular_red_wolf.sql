CREATE TABLE `author_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pen_name` text NOT NULL,
	`bio` text,
	`social` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_id` text,
	`admin_note` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `author_requests_user_idx` ON `author_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `author_requests_status_idx` ON `author_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `post_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text NOT NULL,
	`lang` text DEFAULT 'zh' NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`cover` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`reviewer_id` text,
	`review_note` text,
	`published_path` text,
	`published_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `post_drafts_user_idx` ON `post_drafts` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `post_drafts_review_idx` ON `post_drafts` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `comments` ADD `edited_at` integer;--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`author_type`,`author_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `friend_applications` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `friend_apps_user_idx` ON `friend_applications` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `bio` text;--> statement-breakpoint
ALTER TABLE `users` ADD `website` text;--> statement-breakpoint
ALTER TABLE `users` ADD `can_publish` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `can_author` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `author_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `reactions_user_idx` ON `reactions` (`user_id`,`kind`,`created_at`);