/**
 * theme.svelte.ts — 宿主页面到底是浅色还是深色，外加「实心色 + 字色」的配对
 *
 * 组件自己写死的那些颜色（白底、灰底、深黑字）在 Hugo 站上是致命的：
 * 主题把 data-theme 挂在 <html> 上，深色有三种来源——
 *   1. data-theme="dark"（用户手动切到深色）
 *   2. data-theme="auto"/缺省 + 系统 prefers-color-scheme: dark
 *   3. 用户点了「跟随系统」再手动选浅色（data-theme="light"，此时系统偏好不算）
 *
 * 光靠属性猜不准：主题的深色变量块写在 [data-theme=dark] 和
 * [data-theme=auto] + prefers-color-scheme:dark 两处，访客没点过换肤时 <html> 上
 * 根本没有 data-theme —— 系统是深色但页面还是白底，这时候组件跟着系统变深就成了
 * 白底白字。所以这里直接量宿主算出来的 --text / --bg，谁亮谁就是底色那一个。
 * 量不到颜色时才退回「属性 + 系统偏好」那套猜法。
 */

type Doc = Document & { documentElement: HTMLElement };

function currentTheme(): string {
  if (typeof document === 'undefined') return '';
  return ((document as Doc).documentElement.dataset.theme || 'auto').trim().toLowerCase();
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

type RGB = [number, number, number];

const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** 只认 #hex / rgb() / rgba()；颜色名之类的写法一律当作读不到，宁可不改也不改错 */
function parseColor(raw: string | null | undefined): RGB | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const h = HEX6.exec(v) || HEX3.exec(v);
  if (h) {
    const parts = h.slice(1).map((s) => (s.length === 1 ? parseInt(s + s, 16) : parseInt(s, 16)));
    return [parts[0], parts[1], parts[2]];
  }
  const m = /rgba?\(([^)]+)\)/i.exec(v);
  if (m) {
    const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (n.length >= 3 && n.slice(0, 3).every((x) => Number.isFinite(x))) return [n[0], n[1], n[2]];
  }
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as RGB;
}

function hex([r, g, b]: RGB): string {
  const to = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
/** 实心强调色按钮上的字色：纯黑太硬，取一个接近黑的深灰 */
const NEAR_BLACK: RGB = [15, 15, 15];
const DARK_BG: RGB = [35, 35, 35];
const ACCENT_DARK: RGB = [122, 162, 255];
const ACCENT_LIGHT: RGB = [0, 112, 243];

/** 宿主正文色与页面底色谁亮谁暗 —— 量得出就直接判，量不到返回 null 让调用方退回猜 */
function measuredDark(host: HTMLElement): boolean | null {
  const cs = getComputedStyle(host);
  const fg = parseColor(cs.getPropertyValue('--text'));
  const bg = parseColor(cs.getPropertyValue('--bg')) ?? parseColor(cs.getPropertyValue('--card-bg'));
  if (!fg || !bg) return null;
  return luminance(fg) > luminance(bg);
}

/** 显式浅色算浅色，显式深色算深色，其余按宿主实际配色（量不到才跟系统） */
export function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false;
  const t = currentTheme();
  if (t === 'dark') return true;
  if (t === 'light') return false;
  const m = measuredDark(document.documentElement);
  return m === null ? prefersDark() : m;
}

/**
 * 表情/链接这类「用主题强调色写字」的地方要够 4.5:1，
 * 而实心按钮上的字色必须和实心色配对 —— 主题在 data-theme=auto 的深色块里
 * 没有重写 --logo-accent-text，直接继承过来的深绿在深底上几乎看不见，
 * 所以这里量一遍，不够就把强调色往白（或黑）方向推，再按亮度决定字色。
 */
function accentPair(cs: CSSStyleDeclaration, dark: boolean): { accent: string; on: string } {
  const bg = parseColor(cs.getPropertyValue('--card-bg')) ?? parseColor(cs.getPropertyValue('--bg')) ?? (dark ? DARK_BG : WHITE);
  const raw = parseColor(cs.getPropertyValue('--logo-accent-text')) ?? (dark ? ACCENT_DARK : ACCENT_LIGHT);
  let accent = raw;
  if (contrast(accent, bg) < 4.5) {
    const toward = luminance(bg) > 0.5 ? BLACK : WHITE;
    for (let t = 0.1; t <= 1; t += 0.1) {
      accent = mix(raw, toward, t);
      if (contrast(accent, bg) >= 4.5) break;
    }
  }
  return { accent: hex(accent), on: hex(luminance(accent) > 0.45 ? NEAR_BLACK : WHITE) };
}

class HostTheme {
  dark = $state(isDarkMode());
  #watching = false;
  /** 已经挂过强调色的宿主元素：换肤时逐个重算 */
  #targets = new Set<HTMLElement>();

  /** 挂监听：data-theme 变化 + 系统偏好变化，重复调用只生效一次 */
  watch() {
    if (this.#watching || typeof window === 'undefined' || typeof document === 'undefined') return;
    this.#watching = true;
    const sync = () => {
      this.dark = isDarkMode();
      for (const el of this.#targets) this.paint(el);
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', sync);
    // 主题脚本换肤时也会派发这个事件（没有也不影响，MutationObserver 已经覆盖）
    window.addEventListener('zero:theme', sync);
  }

  /** 在元素上写 --zc-accent / --zc-on-accent 的内联值，后代继承到的就是一对读得清的颜色 */
  paint(el: HTMLElement) {
    this.#targets.add(el);
    this.watch();
    const pair = accentPair(getComputedStyle(el), this.dark);
    el.style.setProperty('--zc-accent', pair.accent);
    el.style.setProperty('--zc-on-accent', pair.on);
  }

  unpaint(el: HTMLElement) {
    this.#targets.delete(el);
  }
}

export const hostTheme = new HostTheme();

/** Svelte action：<section class="zc" use:hostAccent> / <div class="zm" use:hostAccent> */
export function hostAccent(node: HTMLElement) {
  hostTheme.paint(node);
  return {
    destroy() {
      hostTheme.unpaint(node);
    },
  };
}
