-- ============================================================
-- 0014：把评论与计数里的文章地址统一成一种写法
-- ------------------------------------------------------------
-- 起因：第三方评论导入（Waline / Twikoo / Artalk / Giscus / CommentBox / 通用 JSON）
-- 以及自家备份的 comments 分区，导入侧曾自己写过一套归一 —— **补尾斜杠**
-- （`/posts/x/`），而读取侧 `canonSlug` 是**去尾斜杠**（`/posts/x`）。
-- 两边刚好相反，于是导进来的评论、连同样导入合并的点赞数与浏览量，
-- 前台与计数接口一条都查不到，只有后台按库里存的原始写法看得见。
--
-- 这里只做一件事：把带尾斜杠的地址削成读取侧的口径。
--   · comments / visits 没有相关唯一索引，直接改；
--   · reactions 的唯一索引含 target_slug，撞车的行是「同一个人对同一篇文章的同一种票」
--     的两份写法，`update or ignore` 跳过后再把剩下的旧写法删掉，不会丢真票；
--   · 只改长度 > 1 且以 / 结尾的值，首页 `/` 不动。
-- ============================================================

update comments
   set post_slug = rtrim(post_slug, '/')
 where length(post_slug) > 1 and post_slug like '%/';

update or ignore reactions
   set target_slug = rtrim(target_slug, '/')
 where length(target_slug) > 1 and target_slug like '%/';

delete from reactions
 where length(target_slug) > 1 and target_slug like '%/';

update visits
   set path = rtrim(path, '/')
 where length(path) > 1 and path like '%/';
