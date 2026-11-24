CREATE TABLE `pet_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`question` text,
	`reply` text,
	`page` text,
	`section` text,
	`mood` text,
	`trigger` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pet_events_created_idx` ON `pet_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `pet_events_kind_idx` ON `pet_events` (`kind`,`created_at`);
