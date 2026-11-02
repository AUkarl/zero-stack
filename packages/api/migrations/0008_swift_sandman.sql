CREATE TABLE `visitor_keys` (
	`ip_hash` text PRIMARY KEY NOT NULL,
	`first_seen` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
-- 从访问明细回填老访客，否则切换注册的瞬间每个回访的人都会被重新算成一个新访客
INSERT OR IGNORE INTO `visitor_keys` (`ip_hash`, `first_seen`)
SELECT `ip_hash`, min(`created_at`) FROM `visits` WHERE `ip_hash` IS NOT NULL AND `ip_hash` <> '' GROUP BY `ip_hash`;
