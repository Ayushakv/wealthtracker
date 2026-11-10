import { Category } from '../core/categories.js';
import { suggestedFilename } from '../core/backup.js';
import { formatRelative, plainNumber } from '../core/format.js';
import { renewalCalendar } from '../core/ics.js';
import { MIN_PASSCODE_LENGTH } from '../store/crypto.js';
import { MIN_SYNC_PASSPHRASE, TOKEN_URL } from '../store/sync.js';
import { confirmDialog, deliverFile, pickTextFile, showDialog, toast } from '../ui/dom.js';
import { html, setHTML } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { CAS_HELP, importCAS } from './casImport.js';
import { group, pageHead, row } from './common.js';

const isStandalone = () => globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Chrome/Edge/Android hand us an install prompt we can trigger from a button. */
let installPrompt = null;
globalThis.addEventListener?.('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

const button = (action, iconName, label, { disabled = false, cls = '' } = {}) =>
  html`<button class="row row-button ${cls}" data-action="${action}" ${disabled ? 'disabled' : ''}>${icon(iconName)} ${label}</button>`;

function securitySection(store) {
  return group(
    {
      title: 'Security',
      foot: store.encrypted
        ? 'Your data is encrypted on this device with your passcode and locks after 5 minutes in the background. If you forget the passcode, the data can’t be recovered — keep a backup.'
        : 'Anyone who can open this browser can see your portfolio. A passcode encrypts everything stored on this device.',
    },
    [
      row('Passcode', store.encrypted ? html`<span class="pos">${icon('lock')} On</span>` : 'Off'),
      store.encrypted
        ? [button('lock-now', 'lock', 'Lock Now'), button('change-passcode', 'unlock', 'Change Passcode'), button('remove-passcode', 'unlock', 'Turn Off Passcode', { cls: 'danger' })]
        : button('set-passcode', 'lock', 'Turn On Passcode'),
    ],
  );
}

function syncSection(store) {
  const s = store.settings.sync;
  if (!s) {
    return group(
      {
        title: 'Sync',
        foot: 'Keeps the same data on every device and browser you use. An encrypted copy is saved as a secret gist in your own GitHub account; only your sync passphrase can read it.',
      },
      button('sync-setup', 'cloud', 'Set Up Sync'),
    );
  }
  const status = store.isSyncing
    ? 'Syncing…'
    : s.lastError
      ? html`<span class="warn">${icon('warning')} Not synced</span>`
      : s.lastSync
        ? `Synced ${formatRelative(s.lastSync)}`
        : 'Not yet';
  return group(
    {
      title: 'Sync',
      foot: s.lastError
        ? html`<span class="neg">${s.lastError}</span>`
        : 'Changes sync a few seconds after you make them and whenever the app opens. Encrypted with your sync passphrase before leaving this device.',
    },
    [
      row('GitHub account', s.login ?? '—'),
      html`<div class="row"><span class="row-label">Status</span><span class="row-value" data-sync-status>${status}</span></div>`,
      button('sync-now', 'refresh', 'Sync Now', { disabled: store.isSyncing }),
      button('sync-off', 'cloud', 'Turn Off Sync on This Device', { cls: 'danger' }),
    ],
  );
}

/**
 * A dialog whose OK button runs `work(form)` and stays open showing any error, so a wrong token or passphrase can be
 * corrected in place. @returns what `work` returned, or null if cancelled
 */
function workingDialog(body, work, busyLabel, onMount) {
  let outcome = null;
  return showDialog(body, {
    onMount(dialog, form) {
      onMount?.(form);
      const ok = form.querySelector('[data-ok]');
      const error = form.querySelector('[data-error]');
      form.addEventListener('submit', async (e) => {
        if (e.submitter?.value === 'cancel') return;
        e.preventDefault();
        if (!form.reportValidity()) return;
        const label = ok.textContent;
        ok.disabled = true;
        ok.textContent = busyLabel;
        error.textContent = '';
        try {
          outcome = await work(form);
          dialog.close();
        } catch (x) {
          error.textContent = x.message;
          ok.disabled = false;
          ok.textContent = label;
        }
      });
    },
  }).then(() => outcome);
}

function tokenDialog(store) {
  return workingDialog(
    html`<form method="dialog" class="sheet">
      <h2>Set Up Sync</h2>
      <p class="muted">Your data is encrypted on this device, then saved as a secret gist in your GitHub account. Each device needs a GitHub access token that can only manage gists.</p>
      <ol class="steps small">
        <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token on GitHub</a>. “gist” is already ticked; leave everything else unticked.</li>
        <li>Pick an expiry (“No expiration” means you won’t have to do this again), then <strong>Generate token</strong>.</li>
        <li>Copy the token and paste it below.</li>
      </ol>
      <label class="field stacked"><span>Access token</span><input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="ghp_…"></label>
      <p class="neg small" data-error aria-live="assertive"></p>
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>Continue</button>
      </div>
    </form>`,
    (form) => store.probeSync(form.token.value),
    'Checking…',
  );
}

function passphraseDialog(store, probe) {
  const existing = !!probe.envelope;
  const local = store.assets.length;
  return workingDialog(
    html`<form method="dialog" class="sheet">
      <h2>${existing ? 'Enter Sync Passphrase' : 'Create Sync Passphrase'}</h2>
      <p class="muted">${existing
        ? `Found your synced data in ${probe.login}’s GitHub. Enter the sync passphrase you chose when you first set up sync.`
        : `Your data is encrypted with this passphrase before it leaves this device. You’ll enter it once on each device. If you forget it, the synced copy can’t be read, though your data stays on your devices.`}</p>
      <input type="text" name="username" autocomplete="username" value="WealthTracker sync" hidden>
      <label class="field stacked"><span>Sync passphrase</span><input type="password" name="passphrase" autocomplete="${existing ? 'current-password' : 'new-password'}" minlength="${MIN_SYNC_PASSPHRASE}" required placeholder="At least ${MIN_SYNC_PASSPHRASE} characters"></label>
      ${existing ? '' : html`<label class="field stacked"><span>Confirm passphrase</span><input type="password" name="confirm" autocomplete="new-password" required></label>`}
      ${existing && local
        ? html`<div class="segmented" role="radiogroup" aria-label="This device’s data">
            <label><input type="radio" name="mode" value="combine" checked><span>Combine</span></label>
            <label><input type="radio" name="mode" value="replace"><span>Use synced copy</span></label>
          </div>
          <p class="muted small" data-mode-hint>${MODE_HINT.combine(local)}</p>`
        : ''}
      <p class="neg small" data-error aria-live="assertive"></p>
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>Turn On Sync</button>
      </div>
    </form>`,
    (form) => {
      if (form.confirm && form.confirm.value !== form.passphrase.value) throw new Error('Passphrases don’t match.');
      return store.connectSync(probe, form.passphrase.value, { replace: form.mode?.value === 'replace' });
    },
    'Syncing…',
    (form) => form.addEventListener('change', () => {
      const hint = form.querySelector('[data-mode-hint]');
      if (hint) hint.textContent = MODE_HINT[form.mode.value](local);
    }),
  );
}

const plural = (n) => `${n} asset${n === 1 ? '' : 's'}`;
const MODE_HINT = {
  combine: (n) => `Adds this device’s ${plural(n)} to your synced data. Where both have the same asset, the more recently updated one is kept.`,
  replace: (n) => `Replaces the ${plural(n)} on this device with your synced data.`,
};

function installSection() {
  if (isStandalone()) return group({ title: 'App' }, row('Installed', html`<span class="pos">${icon('check')} Running from your Home Screen</span>`));
  const how = isIOS()
    ? html`In Safari, tap ${icon('export')} <strong>Share</strong>, then <strong>Add to Home Screen</strong>. It opens full-screen, works offline, and Safari won’t clear its data.`
    : 'Install it as an app so it opens in its own window and works offline.';
  return group({ title: 'Install', foot: how }, installPrompt ? button('install', 'install', 'Install App') : row('Add to Home Screen', isIOS() ? 'See below' : 'Use your browser’s menu'));
}

export const settingsView = {
  title: 'Settings',

  render({ store }) {
    const policies = store.assets.filter((a) => a.category === Category.insurance && a.policyRenewalDate != null);
    return html`
      ${pageHead({ title: 'Settings' })}
      ${securitySection(store)}
      ${syncSection(store)}
      ${group(
        {
          title: 'Backup',
          foot: 'Backups are plain, unencrypted JSON — the same format as the iPhone app. Store them somewhere private. Importing merges by asset ID, so the same file can be imported more than once without creating duplicates.',
        },
        [button('export', 'export', 'Export Backup (JSON)', { disabled: !store.assets.length }), button('import', 'import', 'Import Backup')],
      )}
      ${group({ title: 'Statements', foot: CAS_HELP }, [
        button('import-cas', 'import', 'Import Mutual Funds or Bonds from CAS (PDF)'),
        button('import-nps', 'import', 'Import NPS Statement (PDF)'),
        button('import-ppf', 'import', 'Import PPF Statement (PDF)'),
      ])}
      ${group({ title: 'Interest Rates' }, html`<a class="row row-link" href="#/settings/rates"><span class="row-label">PPF rate history</span><span class="row-value">${plainNumber(store.rates.currentRate())}% now ${icon('chevron', 'chev')}</span></a>`)}
      ${group(
        { title: 'Reminders', foot: 'Adds each policy’s due date to your calendar with alerts 30, 15 and 3 days before (9 am). Your calendar app delivers them, even when this app is closed. Add again after changing a due date.' },
        button('all-to-calendar', 'calendar', `Add ${policies.length || ''} Renewal Date${policies.length === 1 ? '' : 's'} to Calendar`, { disabled: !policies.length }),
      )}
      ${installSection()}
      ${group({ title: 'Privacy' }, [
        row('Assets stored', String(store.assets.length)),
        row('Storage', `${store.syncOn ? 'This device + GitHub (encrypted)' : 'This device only'}${store.encrypted ? ' · passcode' : ''}`),
        html`<div class="row"><span class="row-label">Browser may clear it</span><span class="row-value" data-persisted>Checking…</span></div>`,
        row('Network', store.syncOn ? 'mfapi.in · GitHub (sync)' : 'mfapi.in (AMFI codes only)'),
      ])}
      ${group({ title: 'Data' }, [
        button('delete-all', 'trash', 'Delete All Assets', { disabled: !store.assets.length, cls: 'danger' }),
        button('erase-everything', 'trash', 'Erase Everything and Start Over', { cls: 'danger' }),
      ])}`;
  },

  mount(root) {
    const el = root.querySelector('[data-persisted]');
    const storage = navigator.storage;
    if (!el) return;
    if (!storage?.persisted) {
      el.textContent = 'Unknown — export backups regularly';
      return;
    }
    storage.persisted().then((p) => {
      setHTML(el, p ? html`<span class="pos">No · protected</span>` : html`<span class="warn">If space runs low${isIOS() && !isStandalone() ? ' or unused 7 days' : ''}</span>`);
    });
  },

  actions: {
    async export(_, { store }) {
      const ok = await deliverFile(store.exportBackup(), suggestedFilename(), 'application/json');
      if (ok) toast('Backup exported.');
    },

    async import(_, { store }) {
      const text = await pickTextFile('.json,application/json');
      if (text == null) return;
      try {
        const n = await store.importBackup(text);
        toast(`Imported ${n} asset${n === 1 ? '' : 's'}.`);
      } catch (e) {
        toast(`Import failed: ${e.message}`, { kind: 'error', duration: 6000 });
      }
    },

    async 'sync-setup'(_, { store }) {
      const probe = await tokenDialog(store);
      if (!probe) return;
      const n = await passphraseDialog(store, probe);
      if (n == null) return;
      toast(probe.envelope ? `Sync is on. ${n} asset${n === 1 ? '' : 's'} on this device.` : 'Sync is on. Set it up on your other devices with the same passphrase.', { duration: 5000 });
    },

    async 'sync-now'(_, { store }) {
      try {
        await store.syncNow({ throws: true });
        toast('Synced.');
      } catch (e) {
        toast(e.message, { kind: 'error', duration: 6000 });
      }
    },

    async 'sync-off'(_, { store }) {
      const ok = await confirmDialog({
        title: 'Turn off sync on this device?',
        message: 'This device stops syncing and forgets the token and passphrase. Your data stays here, and the encrypted copy stays in your GitHub account for your other devices.',
        confirmLabel: 'Turn Off',
        destructive: true,
      });
      if (!ok) return;
      await store.disconnectSync();
      toast('Sync is off on this device.');
    },

    'import-cas': (_, ctx) => importCAS(ctx),
    'import-nps': (_, ctx) => importCAS(ctx),
    'import-ppf': (_, ctx) => importCAS(ctx),

    async 'all-to-calendar'(_, { store }) {
      const policies = store.assets.filter((a) => a.category === Category.insurance && a.policyRenewalDate != null);
      await deliverFile(renewalCalendar(policies), 'WealthTracker-Renewals.ics', 'text/calendar');
    },

    async install() {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    },

    async 'delete-all'(_, { store }) {
      const n = store.assets.length;
      const ok = await confirmDialog({
        title: 'Delete all assets?',
        message: `All ${n} assets and their history will be permanently removed from this device${store.syncOn ? ' and, through sync, from your other devices' : ''}.`,
        confirmLabel: 'Delete Everything',
        destructive: true,
      });
      if (ok) await store.deleteAllAssets();
    },

    async 'erase-everything'(_, { store, navigate }) {
      const ok = await confirmDialog({
        title: 'Erase everything?',
        message: store.syncOn
          ? 'Removes every asset, your PPF rate list, your passcode and the sync settings from this device. Your synced copy on GitHub is kept: set up sync again to get it back.'
          : 'Removes every asset, your PPF rate list and your passcode from this device. Export a backup first if you might need it.',
        confirmLabel: 'Erase',
        destructive: true,
      });
      if (!ok) return;
      await store.eraseEverything();
      navigate('#/dashboard', { replace: true });
    },

    'lock-now'(_, { store }) {
      store.lock();
    },

    async 'set-passcode'(_, { store }) {
      const result = await passcodeDialog({ title: 'Turn On Passcode', needsCurrent: false, needsNew: true });
      if (!result) return;
      await runWithFeedback(() => store.changePasscode('', result.next), 'Passcode on. Your data is now encrypted.');
    },

    async 'change-passcode'(_, { store }) {
      const result = await passcodeDialog({ title: 'Change Passcode', needsCurrent: true, needsNew: true });
      if (!result) return;
      await runWithFeedback(() => store.changePasscode(result.current, result.next), 'Passcode changed.');
    },

    async 'remove-passcode'(_, { store }) {
      const result = await passcodeDialog({
        title: 'Turn Off Passcode',
        message: 'Your data will be stored unencrypted on this device.',
        needsCurrent: true,
        needsNew: false,
        confirmLabel: 'Turn Off',
      });
      if (!result) return;
      await runWithFeedback(() => store.changePasscode(result.current, ''), 'Passcode off.');
    },
  },
};

async function runWithFeedback(fn, success) {
  try {
    await fn();
    toast(success);
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

export function passcodeFields({ needsCurrent, needsNew }) {
  return html`
    ${needsCurrent ? html`<label class="field stacked"><span>Current passcode</span><input type="password" name="current" autocomplete="current-password" required></label>` : ''}
    ${needsNew
      ? html`<label class="field stacked"><span>New passcode</span><input type="password" name="next" autocomplete="new-password" minlength="${MIN_PASSCODE_LENGTH}" required placeholder="At least ${MIN_PASSCODE_LENGTH} characters"></label>
        <label class="field stacked"><span>Confirm passcode</span><input type="password" name="confirm" autocomplete="new-password" required></label>`
      : ''}`;
}

/** Live check for the new-passcode pair; returns a message or ''. */
export function passcodeProblem(form) {
  const next = form.next?.value ?? '';
  const confirm = form.confirm?.value ?? '';
  if (form.next && next.length < MIN_PASSCODE_LENGTH) return `Use at least ${MIN_PASSCODE_LENGTH} characters.`;
  if (form.confirm && confirm !== next) return confirm ? 'Passcodes don’t match.' : '';
  if (form.current && !form.current.value) return '';
  return '';
}

function passcodeDialog({ title, message, needsCurrent, needsNew, confirmLabel = 'Save' }) {
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>${title}</h2>
      ${message ? html`<p class="muted">${message}</p>` : ''}
      <input type="text" name="username" autocomplete="username" value="WealthTracker" hidden>
      ${passcodeFields({ needsCurrent, needsNew })}
      <p class="muted small" data-problem aria-live="polite"></p>
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok disabled>${confirmLabel}</button>
      </div>
    </form>`,
    {
      onMount(dialog, form) {
        form.addEventListener('input', () => {
          const problem = passcodeProblem(form);
          const filled = (!form.current || form.current.value) && (!form.next || (form.next.value && form.confirm.value === form.next.value));
          dialog.querySelector('[data-problem]').textContent = problem;
          dialog.querySelector('[data-ok]').disabled = !!problem || !filled;
        });
      },
      collect: (form) => ({ current: form.current?.value ?? '', next: form.next?.value ?? '' }),
    },
  );
}
