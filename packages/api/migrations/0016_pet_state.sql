CREATE TABLE `pet_state` (
	`id` text PRIMARY KEY NOT NULL,
	`mood` text DEFAULT '平静' NOT NULL,
	`energy` real DEFAULT 84 NOT NULL,
	`satiety` real DEFAULT 76 NOT NULL,
	`boredom` real DEFAULT 16 NOT NULL,
	`interactions` integer DEFAULT 0 NOT NULL,
	`pets` integer DEFAULT 0 NOT NULL,
	`asleep` integer DEFAULT 0 NOT NULL,
	`asleep_since` integer DEFAULT 0 NOT NULL,
	`last_interaction` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
