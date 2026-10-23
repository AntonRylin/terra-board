// Keeps SQLite-WASM from deleting the library. When installOpfsSAHPoolVfs()
// cannot open one of the pool's files, it calls removeVfs(), which deletes
// the pool's whole directory: every board. A file is locked whenever another
// worker still has the library open: the previous page during a reload (its
// worker is torn down a moment after the new page starts), or another tab.
// So the store only installs the pool once every file in it can be opened,
// and gives up with an error, leaving the files alone, if they stay locked.
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lockedFile(directory: string): Promise<string | null> {
  let dir: FileSystemDirectoryHandle = await navigator.storage.getDirectory();
  try {
    for (const part of [...directory.split('/').filter(Boolean), '.opaque'])
      dir = await dir.getDirectoryHandle(part);
  } catch {
    return null; // No library yet: nothing to protect.
  }
  for await (const [name, handle] of (dir as any).entries() as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind !== 'file') continue;
    try {
      const access = await (handle as FileSystemFileHandle).createSyncAccessHandle();
      access.close();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') continue;
      return name;
    }
  }
  return null;
}

export async function waitForFreePool(directory: string, timeout = 15000) {
  const started = Date.now();
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    const locked = await lockedFile(directory);
    if (!locked) return;
    if (Date.now() - started > timeout)
      throw Error(
        'the library is still open somewhere else (another tab or window of Terra Board). Close it and reload this page.',
      );
    await delay(wait);
  }
}
