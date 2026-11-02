/**
 * toast.svelte.ts — 后台统一的「操作结果」浮层。
 *
 * 为什么要有这一份：以前每个页面把「已保存 / 失败原因」写成页面顶部的一行 <p>，
 * 页面一长就看不见，手机上更要滚回最上面才知道自己那一下点没点成。
 * 现在各页只留自己的状态字符串，用 flash() 把它推到右上角卡片里（自动收、也可点掉）。
 */

export type ToastKind = 'ok' | 'err' | 'warn';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

/** 停留时长：报错留得久一点，成功一闪即可；长文案按字数再补一点时间 */
const TTL: Record<ToastKind, number> = { ok: 3800, warn: 6500, err: 9000 };
const MAX = 4;

let items = $state<ToastItem[]>([]);
let seq = 0;

export const toast = {
  get list(): ToastItem[] {
    return items;
  },
  push(kind: ToastKind, text: string) {
    const msg = String(text ?? '').trim();
    if (!msg) return;
    const id = ++seq;
    items = [...items.slice(-(MAX - 1)), { id, kind, text: msg }];
    const ttl = TTL[kind] + Math.min(4000, Math.max(0, msg.length - 40) * 18);
    setTimeout(() => toast.dismiss(id), ttl);
  },
  ok(text: string) {
    toast.push('ok', text);
  },
  err(text: string) {
    toast.push('err', text);
  },
  warn(text: string) {
    toast.push('warn', text);
  },
  dismiss(id: number) {
    items = items.filter((x) => x.id !== id);
  },
  clear() {
    items = [];
  },
};

/**
 * 在组件初始化时调用：把页面顶部那条结果文案改成浮层。
 *
 * 去重只挡「同一段文字连续出现」：文案清空后再出现算一次新的，
 * 所以连点两次「保存修改」（中间状态被清过）会弹两次。
 */
export function flash(kind: ToastKind, get: () => string | null | undefined) {
  let last = '';
  $effect(() => {
    const v = String(get() ?? '').trim();
    if (!v) {
      last = '';
      return;
    }
    if (v === last) return;
    last = v;
    toast.push(kind, v);
  });
}
