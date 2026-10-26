// Tagged-template HTML with automatic escaping. Interpolated values are escaped unless wrapped in raw()
// or produced by another html`` call; arrays are joined; null/undefined/false render as nothing.

class SafeHTML {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Marks trusted markup (icons, already-built fragments) so it isn't escaped. */
export const raw = (s) => new SafeHTML(String(s));

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof SafeHTML) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHTML(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHTML(out);
}

/** Sets an element's markup from an html`` fragment. */
export function setHTML(el, fragment) {
  el.innerHTML = render(fragment);
}
