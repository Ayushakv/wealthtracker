import { html, setHTML } from './html.js';
import { icon } from './icons.js';

/**
 * Shows a modal <dialog> built from `body` (an html`` fragment containing one <form method="dialog">).
 * When a submit button other than value="cancel" closes it, resolves with `collect(form, buttonValue)`;
 * resolves null when cancelled or dismissed. `onMount(dialog, form)` can wire live behaviour.
 */
export function showDialog(body, { onMount, collect = (_, value) => value, className = '' } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  setHTML(dialog, body);
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  let result = null;
  form.addEventListener('submit', (e) => {
    const value = e.submitter?.value ?? 'ok';
    if (value !== 'cancel') result = collect(form, value);
  });
  onMount?.(dialog, form);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(result);
      dialog.remove();
    });
    // Tap on the backdrop dismisses.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
  });
}

export async function confirmDialog({ title, message, confirmLabel = 'OK', destructive = false }) {
  return (await showDialog(html`
    <form method="dialog" class="sheet">
      <h2>${title}</h2>
      ${message ? html`<p class="muted">${message}</p>` : ''}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}">${confirmLabel}</button>
      </div>
    </form>`)) === 'ok';
}

let toastTimer;
/** Brief status message. `action` = { label, run } adds a button; pass duration: Infinity to keep it up. */
export function toast(message, { action, kind = 'info', duration = 3500 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  setHTML(el, html`${icon(kind === 'error' ? 'warning' : 'check')}<span>${message}</span>${action ? html`<button class="btn btn-small">${action.label}</button>` : ''}`);
  el.className = `toast show ${kind}`;
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      el.classList.remove('show');
      action.run();
    }, { once: true });
  }
  clearTimeout(toastTimer);
  if (Number.isFinite(duration)) toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.remove('show');
}

const isTouch = () => globalThis.matchMedia?.('(pointer: coarse)').matches;

/**
 * Hands a generated file to the user: the share sheet on phones (Save to Files, AirDrop, Calendar…),
 * a normal download elsewhere. Resolves false if the user cancelled the share sheet.
 */
export async function deliverFile(text, filename, type) {
  const file = new File([text], filename, { type });
  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // Fall through to a download if sharing isn't allowed here.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** Opens the system file picker and resolves with the chosen File, or null. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** Opens the system file picker and resolves with the chosen file's text, or null. */
export async function pickTextFile(accept) {
  const file = await pickFile(accept);
  return file ? file.text() : null;
}

/** Parses "1,50,000", "₹ 2.5" etc. Blank or invalid → null. */
export function parseNumber(s) {
  const t = String(s ?? '').replace(/[₹,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
