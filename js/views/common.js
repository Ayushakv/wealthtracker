import { categoryInfo } from '../core/categories.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';

/** Page title bar with an optional back link and trailing toolbar. */
export function pageHead({ title, back, actions }) {
  return html`
    <div class="page-head">
      ${back ? html`<a class="back" href="${back.href}">${icon('back')}<span>${back.label}</span></a>` : ''}
      <h1>${title}</h1>
      ${actions ? html`<div class="toolbar">${actions}</div>` : ''}
    </div>`;
}

/** Grouped list section, like a SwiftUI Form section. */
export function group({ title, foot, cls = '' }, body) {
  return html`
    <section class="group ${cls}">
      ${title ? html`<h2 class="group-title">${title}</h2>` : ''}
      <div class="group-body">${body}</div>
      ${foot ? html`<p class="group-foot">${foot}</p>` : ''}
    </section>`;
}

/** Label/value row. `value` may be an html`` fragment. */
export const row = (label, value, cls = '') => html`<div class="row ${cls}"><span class="row-label">${label}</span><span class="row-value">${value}</span></div>`;

export const categoryIcon = (raw) => icon(categoryInfo(raw).icon);

export const signClass = (v) => (v >= 0 ? 'pos' : 'neg');

export function emptyState({ iconName, title, text, action }) {
  return html`
    <div class="empty">
      ${icon(iconName, 'icon-xl')}
      <h2>${title}</h2>
      ${text ? html`<p class="muted">${text}</p>` : ''}
      ${action ?? ''}
    </div>`;
}
