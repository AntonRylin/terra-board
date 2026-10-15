const { autoUpdater } = require('electron-updater');

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// Checks GitHub Releases for a newer installer and downloads it in the background.
// The update installs when the app quits; `install()` does it right away and
// reopens the app. Only the installed (NSIS) build can update itself. Setting
// TERRA_UPDATE_FEED to a folder URL with a latest.yml tests the flow from any build.
function createAppUpdater({ app, enabled, onStatus }) {
  const feed = process.env.TERRA_UPDATE_FEED;
  let status = { supported: enabled || !!feed, state: 'idle', version: app.getVersion() };
  let timer;
  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };
  if (!status.supported)
    return { status: () => status, check() {}, install: () => false, stop() {} };

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

  const check = () => {
    if (status.state === 'downloading' || status.state === 'ready') return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
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
      if (status.state !== 'ready') return false;
      autoUpdater.quitAndInstall(true, true);
      return true;
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

module.exports = { createAppUpdater };
