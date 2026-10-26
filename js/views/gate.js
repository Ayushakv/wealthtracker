import { confirmDialog } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { passcodeFields, passcodeProblem } from './settings.js';

// Full-screen views shown before the app proper: first run, locked, storage error.

export const welcomeView = {
  render() {
    return html`
      <div class="gate">
        <div class="gate-mark">${icon('rupee', 'icon-xl')}</div>
        <h1>WealthTracker</h1>
        <p class="muted">Your net worth across bank, land, mutual funds, PPF, NPS, bonds, P2P and insurance — kept on this device only.</p>
        <ul class="points">
          <li>${icon('shield')}<span><strong>Private.</strong> No account, no server. Nothing leaves this device except AMFI scheme codes sent to mfapi.in for NAVs.</span></li>
          <li>${icon('lock')}<span><strong>Encrypted.</strong> Set a passcode and everything stored is encrypted with it.</span></li>
          <li>${icon('install')}<span><strong>Works offline.</strong> Add it to your Home Screen and it opens like an app.</span></li>
        </ul>
        <form class="gate-form" data-form="setup">
          <input type="text" name="username" autocomplete="username" value="WealthTracker" hidden>
          ${passcodeFields({ needsCurrent: false, needsNew: true })}
          <p class="muted small" data-problem aria-live="polite">If you forget the passcode, the data can’t be recovered — export backups from Settings.</p>
          <button class="btn btn-primary btn-block" data-ok>Encrypt with Passcode</button>
          <button type="button" class="btn btn-block btn-quiet" data-action="setup-plain">Continue without a passcode</button>
        </form>
        <p class="muted small">Have a backup from the iPhone app? Import it from Settings once you’re in.</p>
      </div>`;
  },

  mount(root) {
    const form = root.querySelector('form');
    form.addEventListener('input', () => {
      root.querySelector('[data-problem]').textContent = passcodeProblem(form) || 'If you forget the passcode, the data can’t be recovered — export backups from Settings.';
    });
  },

  actions: {
    'setup-plain'(_, { store }) {
      return store.setup(null);
    },
  },

  submits: {
    async setup(form, { store }) {
      if (passcodeProblem(form) || form.next.value !== form.confirm.value) {
        form.reportValidity();
        root(form).querySelector('[data-problem]').textContent = passcodeProblem(form) || 'Passcodes don’t match.';
        return;
      }
      const button = form.querySelector('[data-ok]');
      button.disabled = true;
      button.textContent = 'Encrypting…';
      await store.setup(form.next.value);
    },
  },
};

const root = (el) => el.closest('.gate');

export const lockView = {
  render() {
    return html`
      <div class="gate">
        <div class="gate-mark">${icon('lock', 'icon-xl')}</div>
        <h1>WealthTracker is locked</h1>
        <form class="gate-form" data-form="unlock">
          <input type="text" name="username" autocomplete="username" value="WealthTracker" hidden>
          <label class="field stacked"><span>Passcode</span><input type="password" name="passcode" autocomplete="current-password" required autofocus></label>
          <p class="neg small" data-error aria-live="assertive"></p>
          <button class="btn btn-primary btn-block" data-ok>Unlock</button>
          <button type="button" class="btn btn-block btn-quiet" data-action="forgot">Forgot passcode?</button>
        </form>
      </div>`;
  },

  mount(root) {
    root.querySelector('[name="passcode"]').focus();
  },

  actions: {
    async forgot(_, { store }) {
      const ok = await confirmDialog({
        title: 'Erase this device’s data?',
        message: 'Without the passcode the data can’t be decrypted. You can erase it and start over, then import a backup file.',
        confirmLabel: 'Erase and Start Over',
        destructive: true,
      });
      if (ok) await store.eraseEverything();
    },
  },

  submits: {
    async unlock(form, { store }) {
      const button = form.querySelector('[data-ok]');
      const error = form.querySelector('[data-error]');
      if (!form.passcode.value) return;
      button.disabled = true;
      button.textContent = 'Unlocking…';
      error.textContent = '';
      try {
        await store.unlock(form.passcode.value);
      } catch (e) {
        error.textContent = e.name === 'WrongPasscodeError' ? 'Wrong passcode.' : e.message;
        button.disabled = false;
        button.textContent = 'Unlock';
        form.passcode.select();
      }
    },
  },
};

export const errorView = {
  render({ store }) {
    return html`
      <div class="gate">
        <div class="gate-mark">${icon('warning', 'icon-xl')}</div>
        <h1>Storage unavailable</h1>
        <p class="muted">This browser won’t let WealthTracker save data${store.error ? html` (<code>${store.error}</code>)` : ''}. Private browsing modes often block it — try a normal window.</p>
      </div>`;
  },
};
