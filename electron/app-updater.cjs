const { isNewer, latestVersion, PAGE_URL } = require('./version-check.cjs');

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// Checks GitHub Releases for a newer installer and downloads it in the background.
// The update installs when the app quits; `install()` does it right away and
// reopens the app. Only the installed (NSIS) build can update itself. Setting
// TERRA_UPDATE_FEED to a folder URL with a latest.yml tests the flow from any build.
//
// Every build with `notify` also compares its version with package.json on GitHub
// at launch and sets `latest` when that is newer. Builds that cannot install
// updates report it as the 'available' state; the app then links to GitHub.
function createAppUpdater({ app, enabled, notify = enabled, fetch = globalThis.fetch, onStatus }) {
  const feed = process.env.TERRA_UPDATE_FEED;
  const supported = enabled || !!feed;
  let status = { supported, notify, state: 'idle', version: app.getVersion(), page: PAGE_URL };
  let timer,
    autoUpdater,
    remoteBusy = false;
  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };
  if (!supported && !notify)
    return { status: () => status, check() {}, install: () => false, stop() {} };

  const checkRemote = () => {
    if (!notify || remoteBusy) return;
    remoteBusy = true;
    if (!supported) set({ state: 'checking', error: undefined });
    latestVersion(fetch)
      .then((version) => {
        const latest = isNewer(version, status.version) ? version : undefined;
        if (supported) set({ latest });
        else set({ latest, state: latest ? 'available' : 'current', checkedAt: Date.now() });
      })
      .catch((e) => {
        if (!supported) set({ state: 'error', error: String(e?.message || e).slice(0, 200) });
      })
      .finally(() => {
        remoteBusy = false;
      });
  };

  if (supported) {
    // Loaded only by builds that install updates themselves.
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    if (feed) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    }
    autoUpdater.on('checking-for-update', () => {
      if (status.state !== 'ready') set({ state: 'checking', error: undefined });
    });
    autoUpdater.on('update-not-available', () =>
      set({ state: 'current', checkedAt: Date.now(), error: undefined }),
    );
    autoUpdater.on('update-available', (info) =>
      set({ state: 'downloading', available: info.version, percent: 0, checkedAt: Date.now() }),
    );
    autoUpdater.on('download-progress', (p) =>
      set({ state: 'downloading', percent: Math.floor(p.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      set({ state: 'ready', available: info.version, percent: 100 }),
    );
    autoUpdater.on('error', (e) => {
      // A failed check keeps an already downloaded update ready to install.
      if (status.state !== 'ready')
        set({
          state: 'error',
          error: String(e?.message || e)
            .split('\n')[0]
            .slice(0, 200),
        });
    });
  }

  const check = () => {
    checkRemote();
    if (!supported || status.state === 'downloading' || status.state === 'ready') return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  // The launch check runs right away so the prompt appears on every open.
  checkRemote();
  timer = setTimeout(function next() {
    check();
    timer = setTimeout(next, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);

  return {
    status: () => status,
    check,
    // Call only after the library is saved and closed: it starts the installer
    // and quits. Returns false when there is nothing to install.
    install() {
      if (!supported || status.state !== 'ready') return false;
      autoUpdater.quitAndInstall(true, true);
      return true;
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

module.exports = { createAppUpdater };
