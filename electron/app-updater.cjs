const { isNewer, latestRelease, releasePage, PAGE_URL } = require('./version-check.cjs');

const FIRST_CHECK_MS = 3_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// Checks GitHub Releases for a newer version shortly after launch and every few hours.
//
// The installed (NSIS) build downloads the new installer in the background; it
// installs when the app quits, or right away through `install()`, which reopens
// the app. Setting TERRA_UPDATE_FEED to a folder URL with a latest.yml tests this
// from any build.
//
// Other packaged builds (`notify`, e.g. built from source) cannot install
// updates; they report the newer version as the 'available' state with a link
// to its release and installer.
//
// Automatic checks can be turned off in Settings; "Check now" still works.
function createAppUpdater({
  app,
  enabled,
  notify = enabled,
  automatic = true,
  fetch = globalThis.fetch,
  onStatus,
}) {
  const feed = process.env.TERRA_UPDATE_FEED;
  const supported = enabled || !!feed;
  let status = {
    supported,
    notify: supported || notify,
    automatic: !!automatic,
    state: 'idle',
    version: app.getVersion(),
    page: PAGE_URL,
  };
  let timer,
    autoUpdater,
    busy = false;
  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };
  const failed = (e) =>
    set({
      state: 'error',
      error: String(e?.message || e)
        .split('\n')[0]
        .slice(0, 200),
    });
  if (!status.notify)
    return {
      status: () => status,
      check() {},
      install: () => false,
      setAutomatic: () => status,
      stop() {},
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
      set({ state: 'current', latest: undefined, checkedAt: Date.now(), error: undefined }),
    );
    autoUpdater.on('update-available', (info) =>
      set({
        state: 'downloading',
        latest: info.version,
        available: info.version,
        page: releasePage(info.version),
        percent: 0,
        checkedAt: Date.now(),
      }),
    );
    autoUpdater.on('download-progress', (p) =>
      set({ state: 'downloading', percent: Math.floor(p.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      set({ state: 'ready', latest: info.version, available: info.version, percent: 100 }),
    );
    autoUpdater.on('error', (e) => {
      // A failed check keeps an already downloaded update ready to install.
      if (status.state !== 'ready') failed(e);
    });
  }

  const checkRelease = () => {
    if (busy) return;
    busy = true;
    set({ state: 'checking', error: undefined });
    latestRelease(fetch)
      .then(({ version, page, download }) =>
        isNewer(version, status.version)
          ? set({ state: 'available', latest: version, page, download, checkedAt: Date.now() })
          : set({ state: 'current', latest: undefined, checkedAt: Date.now() }),
      )
      .catch(failed)
      .finally(() => {
        busy = false;
      });
  };

  const check = () => {
    if (!supported) return checkRelease();
    if (status.state === 'downloading' || status.state === 'ready') return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!status.automatic) return;
    timer = setTimeout(function next() {
      check();
      timer = setTimeout(next, CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
  };
  schedule();

  return {
    status: () => status,
    check,
    setAutomatic(on) {
      if (status.automatic === !!on) return status;
      set({ automatic: !!on });
      schedule();
      return status;
    },
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

// Whether an installed copy can replace itself with a newer version: the NSIS
// installer on Windows, and on Linux only the AppImage (APPIMAGE names its
// file). A .deb belongs to the system's package tools, so those copies are
// told about new versions like builds from source.
const installsUpdates = (platform = process.platform, env = process.env) =>
  platform === 'win32' || (platform === 'linux' && !!env.APPIMAGE);

module.exports = { createAppUpdater, installsUpdates };
