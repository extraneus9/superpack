// Themed context menus with submenus and keyboard navigation.
import { el, IS_MAC } from './util.js';

// On a Mac the menus speak Finder: same actions, Mac names and ⌘ ⌥ ⇧ keys
const MAC_WORDS = {
  'Open in Windows Explorer': 'Open in Finder', 'Show in Windows Explorer': 'Show in Finder', Properties: 'Get Info',
  Delete: 'Move to Trash', 'This PC': 'Computer', 'Open in Terminal': 'Open in Terminal',
};
const macLabel = (t) => (IS_MAC && MAC_WORDS[t]) || t;
const macKey = (k) => {
  if (!IS_MAC || !k) return k;
  if (k === 'Alt+Enter') return '⌘I';
  if (k === 'Del') return '⌘⌫';
  if (k === 'F2') return '↩';
  return k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
};
import { icon } from './icons.js';

const root = () => document.getElementById('menus');
let stack = [];
let onCloseCb = null;

export function closeMenus() {
  stack.forEach((m) => m.remove());
  stack = [];
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', keys, true);
  window.removeEventListener('blur', closeMenus);
  window.removeEventListener('resize', closeMenus);
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
}

export const menuOpen = () => stack.length > 0;

function outside(e) {
  if (stack.some((m) => m.contains(e.target))) return;
  closeMenus();
}

function keys(e) {
  const menu = stack[stack.length - 1];
  if (!menu) return;
  const items = [...menu.querySelectorAll('.menu-item:not(.disabled)')];
  let i = items.findIndex((x) => x.classList.contains('hl'));
  const hl = (n) => { items.forEach((x) => x.classList.remove('hl')); if (items[n]) items[n].classList.add('hl'); };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (stack.length > 1) { stack.pop().remove(); } else closeMenus(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); hl(i < 0 ? 0 : (i + 1) % items.length); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); hl(i <= 0 ? items.length - 1 : i - 1); return; }
  if (e.key === 'ArrowLeft' && stack.length > 1) { e.preventDefault(); e.stopPropagation(); stack.pop().remove(); return; }
  if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && i >= 0) {
    e.preventDefault(); e.stopPropagation();
    items[i].dispatchEvent(new MouseEvent(e.key === 'ArrowRight' ? 'mouseenter' : 'click', { bubbles: true }));
    if (e.key === 'ArrowRight') {
      const sub = stack[stack.length - 1];
      const first = sub && sub !== menu && sub.querySelector('.menu-item:not(.disabled)');
      if (first) first.classList.add('hl');
    }
    return;
  }
  // accelerator: first letter
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    const ch = e.key.toLowerCase();
    const n = items.findIndex((x, k) => k > i && (x.textContent || '').trim().toLowerCase().startsWith(ch));
    const m = n >= 0 ? n : items.findIndex((x) => (x.textContent || '').trim().toLowerCase().startsWith(ch));
    if (m >= 0) { e.preventDefault(); e.stopPropagation(); hl(m); }
  }
}

function place(menu, x, y, anchorRect) {
  root().append(menu);
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (anchorRect) {
    left = anchorRect.right - 4;
    top = anchorRect.top - 4;
    if (left + r.width > vw - 6) left = anchorRect.left - r.width + 4;
  } else {
    if (left + r.width > vw - 6) left = Math.max(6, x - r.width);
  }
  if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function build(items, level) {
  const menu = el('div', { class: 'menu', role: 'menu' });
  let hoverTimer = null;
  for (const it of items) {
    if (!it) continue;
    if (it === '-' || it.sep) { menu.append(el('div', { class: 'menu-sep' })); continue; }
    if (it.head) { menu.append(el('div', { class: 'menu-head', text: it.head })); continue; }
    if (it.element) { menu.append(typeof it.element === 'function' ? it.element() : it.element); continue; }
    const row = el('div', { class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : ''), role: 'menuitem' },
      el('span', { class: 'mi-icon', html: it.swatch ? `<i class="status-swatch" style="background:${it.swatch}"></i>` : it.checked ? icon('check') : it.icon ? icon(it.icon) : '' }),
      el('span', { class: 'mi-label', text: macLabel(it.label) }),
      it.key ? el('span', { class: 'mi-key', text: macKey(it.key) }) : null,
      it.submenu ? el('span', { class: 'mi-sub', html: icon('chevron', 12) }) : null,
    );
    row.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      [...menu.children].forEach((c) => c.classList.remove('hl'));
      row.classList.add('hl');
      while (stack.length > level + 1) stack.pop().remove();
      if (it.submenu && !it.disabled) {
        hoverTimer = setTimeout(() => {
          while (stack.length > level + 1) stack.pop().remove();
          const sub = build(typeof it.submenu === 'function' ? it.submenu() : it.submenu, level + 1);
          stack.push(sub);
          place(sub, 0, 0, row.getBoundingClientRect());
        }, 120);
      }
    });
    row.addEventListener('click', (e) => {
      if (it.disabled) return;
      if (it.submenu) { row.dispatchEvent(new MouseEvent('mouseenter')); return; }
      e.stopPropagation();
      closeMenus();
      if (it.action) setTimeout(() => it.action(e), 0);
    });
    menu.append(row);
  }
  return menu;
}

export function showMenu(items, x, y, { onClose } = {}) {
  closeMenus();
  onCloseCb = onClose || null;
  const menu = build(items, 0);
  stack.push(menu);
  place(menu, x, y);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', keys, true);
    window.addEventListener('blur', closeMenus);
    window.addEventListener('resize', closeMenus);
  }, 0);
  return menu;
}

export function showMenuAt(items, anchor) {
  const r = anchor.getBoundingClientRect();
  return showMenu(items, r.left, r.bottom + 4);
}
