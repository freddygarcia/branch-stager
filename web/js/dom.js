// Small DOM and text helpers.

export const $ = (id) => document.getElementById(id);

/** A new element: el('a', { href, class, onclick }, ...children). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

/** "1 file", "2 files". */
export const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at, now = Date.now()) {
  const min = Math.round((now - at) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return count(Math.round(h / 24), 'day ago', 'days ago');
}

/** 20261115-1642 */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}
