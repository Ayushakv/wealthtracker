import { inrCompact, percent } from '../core/format.js';
import { html } from './html.js';

const R = 90;
const r = R * 0.62;
const f = (n) => n.toFixed(3);

function point(radius, angle) {
  // 0 rad at 12 o'clock, clockwise.
  return [radius * Math.sin(angle), -radius * Math.cos(angle)];
}

function sectorPath(a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = point(R, a0);
  const [x1, y1] = point(R, a1);
  const [x2, y2] = point(r, a1);
  const [x3, y3] = point(r, a0);
  return `M${f(x0)} ${f(y0)}A${R} ${R} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${f(r)} ${f(r)} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/** A full ring can't be one arc, so draw it as two halves with an even-odd hole. */
const RING = `M0 ${-R}A${R} ${R} 0 1 1 0 ${R}A${R} ${R} 0 1 1 0 ${-R}ZM0 ${f(-r)}A${f(r)} ${f(r)} 0 1 0 0 ${f(r)}A${f(r)} ${f(r)} 0 1 0 0 ${f(-r)}Z`;

/**
 * Allocation donut. Slices are buttons: tap/hover to focus one, the centre shows its value.
 * The legend below lists every slice with value and share, so nothing relies on colour alone.
 */
export function donut(slices) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  let angle = 0;
  const paths = slices.map((s) => {
    const sweep = s.fraction * 2 * Math.PI;
    const d = slices.length === 1 ? RING : sectorPath(angle, angle + sweep);
    angle += sweep;
    const label = `${s.label}: ${inrCompact(s.value)}, ${percent(s.fraction)}`;
    return html`<path class="slice s${s.series}" d="${d}" fill-rule="evenodd" data-slice="${s.key}" role="button" tabindex="0" aria-label="${label}"><title>${label}</title></path>`;
  });

  return html`
    <div class="donut" data-total="${inrCompact(total)}">
      <svg viewBox="-100 -100 200 200" role="group" aria-label="Allocation by asset class">${paths}</svg>
      <div class="donut-center" aria-live="polite">
        <span class="donut-label">Net Worth</span>
        <strong class="donut-value">${inrCompact(total)}</strong>
        <span class="donut-share"></span>
      </div>
    </div>
    <ul class="legend">
      ${slices.map(
        (s) => html`<li data-slice="${s.key}">
          <span class="swatch s${s.series}" aria-hidden="true"></span>
          <span class="legend-label">${s.label}</span>
          <span class="num">${inrCompact(s.value)}</span>
          <span class="num muted legend-share">${percent(s.fraction)}</span>
        </li>`,
      )}
    </ul>`;
}

/** Wires focus behaviour: hover previews, tap/click pins, tapping again or elsewhere clears. */
export function mountDonut(card, slices) {
  if (!card) return;
  const byKey = new Map(slices.map((s) => [s.key, s]));
  const center = card.querySelector('.donut-center');
  const total = card.querySelector('.donut').dataset.total;
  let pinned = null;

  const show = (key) => {
    const s = key ? byKey.get(key) : null;
    card.classList.toggle('has-focus', !!s);
    for (const el of card.querySelectorAll('[data-slice]')) el.classList.toggle('focused', el.dataset.slice === key);
    center.querySelector('.donut-label').textContent = s ? s.label : 'Net Worth';
    center.querySelector('.donut-value').textContent = s ? inrCompact(s.value) : total;
    center.querySelector('.donut-share').textContent = s ? percent(s.fraction) : '';
  };

  const keyOf = (e) => e.target.closest('[data-slice]')?.dataset.slice ?? null;
  card.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'mouse' && !pinned) show(keyOf(e));
  });
  card.addEventListener('pointerleave', () => show(pinned));
  card.addEventListener('click', (e) => {
    const key = keyOf(e);
    pinned = key && key !== pinned ? key : null;
    show(pinned);
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && keyOf(e)) {
      e.preventDefault();
      e.target.click();
    }
  });
  card.addEventListener('focusin', (e) => {
    if (!pinned) show(keyOf(e));
  });
  card.addEventListener('focusout', () => show(pinned));
}
