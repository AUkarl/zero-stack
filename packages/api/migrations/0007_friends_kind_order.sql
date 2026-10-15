ALTER TABLE `friends` ADD `kind` text DEFAULT 'friend' NOT NULL;--> statement-breakpoint
ALTER TABLE `friends` ADD `sort_order` integer DEFAULT 0 NOT NULL;