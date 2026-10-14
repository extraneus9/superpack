// Toasts and simple confirm dialogs.
import { el } from './util.js';

const toasts = new Map();

export function toast(text, kind = 'info', { id, ms, action } = {}) {
  const host = document.getElementById('toasts');
  let t = id && toasts.get(id);
  if (!t) {
    t = el('div', { class: 'toast' }, el('i', { class: 't-dot' }), el('span', { class: 't-text' }));
    host.append(t);
    if (id) toasts.set(id, t);
    t.addEventListener('click', () => dismiss(t, id));
  }
  t.className = `toast ${kind}`;
  t.querySelector('.t-dot').replaceWith(el('i', { class: kind === 'busy' ? 't-dot spinner' : 't-dot' }));
  t.querySelector('.t-text').textContent = text;
  const oldBtn = t.querySelector('.t-action');
  if (oldBtn) oldBtn.remove();
  if (action) {
    const b = el('button', { class: 'btn primary t-action', text: action.label });
    b.addEventListener('click', (e) => { e.stopPropagation(); action.onClick(); });
    t.append(b);
  }
  clearTimeout(t._timer);
  if (kind !== 'busy' && !action) t._timer = setTimeout(() => dismiss(t, id), ms || (kind === 'err' ? 7000 : 3500));
  return t;
}

function dismiss(t, id) {
  t.remove();
  if (id) toasts.delete(id);
}

export function confirmDialog({ title, text, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const rootEl = document.getElementById('modal-root');
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: ok, onclick: () => close(true) });
    const back = el('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === back) close(false); } },
      el('div', { class: 'dialog', role: 'dialog' },
        el('h3', { text: title }),
        text ? el('p', { text }) : null,
        el('div', { class: 'actions' }, el('button', { class: 'btn', text: cancel, onclick: () => close(false) }), okBtn)));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    document.addEventListener('keydown', onKey, true);
    rootEl.append(back);
    okBtn.focus();
  });
}
