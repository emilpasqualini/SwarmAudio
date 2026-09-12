//
//  dom.ts
//  HIVE (client)
//
//  The one DOM helper, same shape as SCSS_web's. No framework: each page is
//  two or three views and a socket, and hand-written DOM keeps the bundle
//  small enough that a phone on a bad Wi-Fi still loads it in a second.
//

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style') node.setAttribute('style', String(value));
    else node.setAttribute(key, String(value));
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

/** Slot n → its CSS colour variable. */
export const slotColour = (slot: number): string => `var(--slot-${((slot - 1) % 10 + 10) % 10})`;

/** Writes a signed value into a `.sbar`: zero in the middle, ±range fills to the edge. */
export function setSigned(bar: HTMLElement, value: number, range: number): void {
  const fill = bar.firstElementChild as HTMLElement | null;
  if (!fill) return;
  const v = Math.max(-1, Math.min(1, value / range)) * 50;
  if (v >= 0) { fill.style.left = '50%'; fill.style.width = `${v}%`; }
  else { fill.style.left = `${50 + v}%`; fill.style.width = `${-v}%`; }
}

export function signedBar(extraClass = ''): HTMLElement {
  return el('div', { class: `sbar ${extraClass}`.trim() }, el('span'));
}
