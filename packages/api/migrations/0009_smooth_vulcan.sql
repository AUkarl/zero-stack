ALTER TABLE `friends` ADD `last_ok_at` integer;
-- 已有的检测时间拿来当「最近一次成功访问」的初值：状态是 active 的站按最后一次检查算，
-- 否则新列一上线，所有老站都会因为 last_ok_at 为空而不参与 30 天判定。
UPDATE `friends` SET `last_ok_at` = `last_checked_at` WHERE `status` = 'active' AND `last_ok_at` IS NULL;
