const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { referencedAssets } = require('./store-sync.cjs');

const iconAssetId = (icon) =>
  typeof icon === 'string' && icon.startsWith('asset-') ? icon.slice(6) : null;
const offline = (e) =>
  /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    String(e?.message || e),
  );
const fail = (error, fallback) => {
  if (!error) return;
  throw Error(error.message || fallback);
};
const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Session tokens are stored next to the library, encrypted when the OS allows it.
function sessionStorage(file, safeStorage) {
  const read = () => {
    try {
      const raw = fs.readFileSync(file);
      const text =
        safeStorage?.isEncryptionAvailable() && raw[0] !== 0x7b
          ? safeStorage.decryptString(raw)
          : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const write = (data) => {
    const text = JSON.stringify(data);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      safeStorage?.isEncryptionAvailable() ? safeStorage.encryptString(text) : text,
    );
  };
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => write({ ...read(), [key]: value }),
    removeItem: (key) => {
      const data = read();
      delete data[key];
      write(data);
    },
  };
}

// Cloud sync for one library. A person has one personal workspace (all their
// computers are members); it holds their whole library when library sync is
// on, and otherwise only what they share. Folders and boards other people
// share are pulled from those people's workspaces with view or edit rights.
class CloudSync {
  constructor({ call, root, config, safeStorage, transaction, onStatus }) {
    this.call = call;
    this.config = config;
    this.transaction = transaction;
    this.onStatus = onStatus;
    this.status = {
      configured: !!config,
      state: 'off',
      identity: false,
      library: false,
      name: '',
      pending: 0,
      lastSync: null,
      error: null,
      shared: [],
      sharedWithMe: [],
    };
    this.timer = null;
    this.poll = null;
    this.running = null;
    this.again = false;
    this.channels = new Map();
    this.roles = { boards: {}, folders: {} };
    this.foreign = [];
    if (config)
      this.client = createClient(config.url, config.key, {
        auth: {
          storage: sessionStorage(path.join(root, 'settings', 'cloud-session'), safeStorage),
          storageKey: 'terra-cloud',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
  }

  emit(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
    return this.status;
  }

  async local() {
    const l = await this.call('syncStatus');
    return {
      identity: l.identity,
      library: l.library,
      name: l.name,
      pending: l.pending,
      workspace: l.workspace,
    };
  }

  async start() {
    if (!this.client) return this.status;
    const local = await this.local();
    if (!local.identity) return this.emit({ state: 'off', ...local, shared: [], sharedWithMe: [] });
    this.workspace = local.workspace;
    this.emit({ state: 'syncing', ...local });
    const { data } = await this.client.auth.getSession();
    if (!data.session)
      return this.emit({ state: 'error', error: 'Signed out. Turn sync on again.' });
    this.userId = data.session.user.id;
    this.listen(this.workspace);
    clearInterval(this.poll);
    this.poll = setInterval(() => this.schedule(0), 30000);
    this.schedule(0);
    return this.status;
  }

  async signIn() {
    const { data } = await this.client.auth.getSession();
    if (data.session) return data.session.user;
    const result = await this.client.auth.signInAnonymously();
    fail(result.error, 'Could not reach the sync service');
    return result.data.user;
  }

  // A cloud identity for this person: needed to sync, share or accept a share.
  async identify(name) {
    this.requireClient();
    const local = await this.local();
    if (local.identity) {
      if (name && name.trim() && name.trim() !== local.name) await this.rename(name);
      return this.status;
    }
    if (typeof name !== 'string' || !name.trim())
      throw Error('Enter your name so people know who shared with them.');
    await this.signIn();
    const { data, error } = await this.client.rpc('create_workspace', {
      p_name: 'My boards',
      p_device: os.hostname(),
    });
    fail(error, 'Could not create your sync space');
    const named = await this.client.rpc('set_display_name', { p_workspace: data, p_name: name });
    fail(named.error, 'Could not save your name');
    await this.call('syncIdentity', { workspace: data, name });
    return this.start();
  }

  async rename(name) {
    this.requireWorkspace();
    const { error } = await this.client.rpc('set_display_name', {
      p_workspace: this.workspace,
      p_name: name,
    });
    fail(error, 'Could not save your name');
    await this.call('syncRename', { name });
    return this.emit(await this.local());
  }

  // Sync the whole library, or only what is shared.
  async setLibrary(on, name) {
    if (on) await this.identify(name || this.status.name);
    else this.requireWorkspace();
    await this.call('syncLibrary', { on: !!on });
    this.emit(await this.local());
    this.schedule(0);
    return this.status;
  }

  async enable(name) {
    return this.setLibrary(true, name || this.status.name || 'Me');
  }

  // A code from another computer of this person, or an invite to someone's share.
  async join(code, name) {
    this.requireClient();
    if (typeof code !== 'string' || code.length > 40) throw Error('Enter the code you were given');
    const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (clean.startsWith('S')) {
      await this.identify(name || this.status.name);
      const { error } = await this.client.rpc('redeem_share_invite', {
        p_code: clean,
        p_workspace: this.workspace,
      });
      fail(error, 'This code is wrong or has expired');
      await this.run();
      return this.status;
    }
    await this.signIn();
    const { data, error } = await this.client.rpc('redeem_pairing_code', {
      p_code: clean,
      p_device: os.hostname(),
    });
    fail(error, 'This code is wrong or has expired');
    await this.call('syncEnable', { workspace: data, name: name || this.status.name });
    return this.start();
  }

  async disable() {
    this.stop();
    if (this.client && this.workspace && this.userId) {
      try {
        await this.client.rpc('remove_member', {
          p_workspace: this.workspace,
          p_user: this.userId,
        });
        await this.client.auth.signOut();
      } catch {}
    }
    await this.transaction(async () => {
      await this.call('syncDisable');
      return { library: true, boards: [] };
    });
    this.workspace = null;
    return this.emit({
      state: 'off',
      identity: false,
      library: false,
      pending: 0,
      error: null,
      lastSync: null,
      shared: [],
      sharedWithMe: [],
    });
  }

  async pairingCode() {
    this.requireWorkspace();
    const { data, error } = await this.client.rpc('create_pairing_code', {
      p_workspace: this.workspace,
    });
    fail(error, 'Could not create a code');
    return data;
  }

  async devices() {
    this.requireWorkspace();
    const { data, error } = await this.client
      .from('workspace_members')
      .select('user_id, device_name, joined_at, role')
      .eq('workspace_id', this.workspace)
      .order('joined_at');
    fail(error, 'Could not load devices');
    return data.map((d) => ({
      id: d.user_id,
      name: d.device_name || 'Device',
      joined: d.joined_at,
      current: d.user_id === this.userId,
    }));
  }

  async removeDevice(userId) {
    this.requireWorkspace();
    if (userId === this.userId) return this.disable();
    const { error } = await this.client.rpc('remove_member', {
      p_workspace: this.workspace,
      p_user: userId,
    });
    fail(error, 'Could not remove the device');
  }

  // --- Sharing ---------------------------------------------------------------

  shareFor(kind, targetId) {
    return this.status.shared.find((s) => s.kind === kind && s.targetId === targetId) || null;
  }

  async sharePeople(kind, targetId) {
    const share = this.workspace && this.shareFor(kind, targetId);
    if (!share) return { shareId: null, people: [] };
    const { data, error } = await this.client.rpc('share_people', { p_share: share.shareId });
    fail(error, 'Could not load who has access');
    return {
      shareId: share.shareId,
      people: data.map((p) => ({ id: p.workspace_id, name: p.name, role: p.role })),
    };
  }

  // Share a folder or board (if not yet) and create a one-time invite code.
  async invite(kind, targetId, role, name) {
    if (!['folder', 'board'].includes(kind)) throw Error('Choose a folder or a board');
    await this.identify(name || this.status.name);
    let share = this.shareFor(kind, targetId);
    if (!share) {
      // No sync round may read a share list from before this share exists.
      share = await this.exclusive(async () => {
        const { data, error } = await this.client.rpc('create_share', {
          p_workspace: this.workspace,
          p_kind: kind,
          p_target: targetId,
        });
        fail(error, 'Could not share this');
        const created = { shareId: data, kind, targetId, people: 0 };
        this.emit({ shared: [...this.status.shared.filter((s) => s.shareId !== data), created] });
        await this.call('syncOwned', {
          upload: true,
          shares: this.status.shared.map((s) => ({
            kind: s.kind,
            targetId: s.targetId,
            shareId: s.shareId,
          })),
        });
        return created;
      });
      // Upload the shared content before the invite is used.
      await this.run();
    }
    const { data, error } = await this.client.rpc('create_share_invite', {
      p_share: share.shareId,
      p_role: role === 'edit' ? 'edit' : 'view',
    });
    fail(error, 'Could not create an invite');
    return data;
  }

  async setPersonRole(shareId, person, role) {
    const { error } = await this.client.rpc('set_share_role', {
      p_share: shareId,
      p_member: person,
      p_role: role === 'edit' ? 'edit' : 'view',
    });
    fail(error, 'Could not change access');
    this.ping(this.workspace);
  }

  async removePerson(shareId, person) {
    const { error } = await this.client.rpc('remove_share_member', {
      p_share: shareId,
      p_member: person,
    });
    fail(error, 'Could not remove access');
    this.ping(this.workspace);
    await this.run();
  }

  async stopSharing(shareId) {
    const { error } = await this.client.rpc('delete_share', { p_share: shareId });
    fail(error, 'Could not stop sharing');
    this.ping(this.workspace);
    await this.run();
  }

  // Leave something another person shared; its copies disappear here.
  async leave(shareId) {
    this.requireWorkspace();
    const { error } = await this.client.rpc('remove_share_member', {
      p_share: shareId,
      p_member: this.workspace,
    });
    fail(error, 'Could not leave');
    await this.run();
  }

  requireClient() {
    if (!this.client) throw Error('Cloud sync is not set up in this build.');
  }
  requireWorkspace() {
    this.requireClient();
    if (!this.workspace) throw Error('Turn on sync first.');
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.timer = this.poll = null;
    for (const channel of this.channels.values()) this.client.removeChannel(channel);
    this.channels.clear();
  }

  // People who change a workspace ping its channel; listeners pull within a second.
  listen(workspace) {
    if (this.channels.has(workspace)) return;
    const channel = this.client
      .channel('terra:' + workspace)
      .on('broadcast', { event: 'pushed' }, () => this.schedule(200))
      .subscribe();
    this.channels.set(workspace, channel);
  }

  ping(workspace) {
    void this.channels.get(workspace)?.send({ type: 'broadcast', event: 'pushed', payload: {} });
  }

  localChanged() {
    if (this.workspace) this.schedule(1500);
  }

  schedule(delay) {
    if (!this.workspace) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  // Run a job while no sync round is in progress; rounds asked for meanwhile follow it.
  async exclusive(job) {
    while (this.running) await this.running.catch(() => {});
    let release;
    this.running = new Promise((resolve) => (release = resolve));
    try {
      return await job();
    } finally {
      this.running = null;
      release();
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  async run() {
    if (!this.workspace) return this.status;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const pushed = await this.push();
          await this.reconcile();
          await this.pull(this.workspace);
          for (const ws of this.foreign) await this.pull(ws);
          for (const ws of pushed) this.ping(ws);
        } while (this.again && this.workspace);
        this.emit({ state: 'synced', ...(await this.local()), lastSync: Date.now(), error: null });
      } catch (e) {
        const local = await this.local().catch(() => ({}));
        this.emit({
          state: offline(e) ? 'offline' : 'error',
          ...local,
          error: offline(e) ? null : String(e.message || e),
        });
        this.schedule(offline(e) ? 15000 : 60000);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async push() {
    const pushed = new Set();
    for (;;) {
      const batch = await this.call('syncTake', { limit: 200 });
      if (!batch.entries.length && !batch.dropped.length) return pushed;
      this.emit({ state: 'syncing', pending: Math.max(this.status.pending, batch.entries.length) });
      for (const a of batch.assets) await this.upload(a);
      const byWorkspace = new Map();
      const add = (workspace, row) => {
        if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, []);
        byWorkspace.get(workspace).push(row);
      };
      for (const a of batch.assets)
        add(a.workspace, {
          kind: 'asset',
          board_id: '',
          id: a.id,
          data: { name: a.name, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes },
          deleted: false,
        });
      for (const { workspace, queued, ...e } of batch.entries) add(workspace, e);
      for (const [workspace, rows] of byWorkspace) {
        for (const part of chunks(rows, 400)) {
          const { error } = await this.client.rpc('push_entities', {
            p_workspace: workspace,
            p_rows: part,
          });
          fail(error, 'Could not upload changes');
        }
        pushed.add(workspace);
      }
      const local = await this.call('syncAck', {
        entries: batch.entries,
        dropped: batch.dropped,
        assets: batch.assets.map((a) => ({ workspace: a.workspace, id: a.id })),
      });
      this.emit({ pending: local.pending });
    }
  }

  async upload(asset) {
    const bytes = fs.readFileSync(asset.file);
    const { error } = await this.client.storage
      .from('assets')
      .upload(`${asset.workspace}/${asset.id}`, bytes, {
        contentType: asset.mime || 'application/octet-stream',
        upsert: false,
      });
    // Content-addressed: an existing file is already the same bytes.
    if (error && !/exists|duplicate|409/i.test(`${error.message} ${error.statusCode}`))
      fail(error, 'Could not upload a file');
  }

  // Learn what this person shares and what others share with them, then
  // download boards that just became visible and drop ones that did not stay.
  async reconcile() {
    const [mine, withMe] = await Promise.all([
      this.client.rpc('my_shares', { p_workspace: this.workspace }),
      this.client.rpc('shared_with_me'),
    ]);
    fail(mine.error, 'Could not load your shares');
    fail(withMe.error, 'Could not load what is shared with you');
    const shared = mine.data.map((s) => ({
      shareId: s.share_id,
      kind: s.kind,
      targetId: s.target_id,
      people: s.people,
    }));
    await this.call('syncOwned', {
      shares: shared.map((s) => ({ kind: s.kind, targetId: s.targetId, shareId: s.shareId })),
    });
    const sharedWithMe = withMe.data.map((s) => ({
      shareId: s.share_id,
      workspace: s.workspace_id,
      owner: s.owner_name,
      kind: s.kind,
      targetId: s.target_id,
      role: s.role,
      boards: s.boards || [],
    }));
    this.emit({ shared, sharedWithMe });
    this.foreign = [...new Set(sharedWithMe.map((s) => s.workspace))];
    for (const ws of this.foreign) this.listen(ws);
    const result = await this.call('syncReconcile', {
      shares: sharedWithMe.map((s) => ({
        workspace: s.workspace,
        kind: s.kind,
        targetId: s.targetId,
        role: s.role,
        boards: s.boards,
        owner: s.owner,
      })),
    });
    this.roles = result.roles;
    for (const group of result.missing) await this.download(group);
    if (result.changed && !result.missing.length)
      await this.transaction(async () => ({ library: true, boards: [] }));
  }

  // Everything of the given boards and folders, regardless of the cursor.
  async download({ workspace, boards, folders }) {
    const rows = [];
    const select = () =>
      this.client
        .from('entities')
        .select('kind, board_id, id, data, deleted, seq, updated_by')
        .eq('workspace_id', workspace)
        .eq('deleted', false);
    for (const part of chunks(folders, 100)) {
      const { data, error } = await select().eq('kind', 'folder').in('id', part);
      fail(error, 'Could not download shared folders');
      rows.push(...data);
    }
    for (const part of chunks(boards, 100)) {
      const { data, error } = await select().eq('kind', 'board').in('id', part);
      fail(error, 'Could not download shared boards');
      rows.push(...data);
      for (let from = 0; ; from += 1000) {
        const objects = await select()
          .eq('kind', 'object')
          .in('board_id', part)
          .order('seq')
          .range(from, from + 999);
        fail(objects.error, 'Could not download shared boards');
        rows.push(...objects.data);
        if (objects.data.length < 1000) break;
      }
    }
    if (!rows.length) return;
    await this.fetchAssets(rows, workspace);
    await this.transaction(() =>
      this.call('syncApply', { workspace, rows, cursor: null, roles: this.roles }),
    );
  }

  async pull(workspace) {
    for (;;) {
      const cursor = await this.call('syncCursor', { workspace });
      const { data: rows, error } = await this.client
        .from('entities')
        .select('kind, board_id, id, data, deleted, seq, updated_by')
        .eq('workspace_id', workspace)
        .gt('seq', cursor)
        .order('seq')
        .limit(500);
      fail(error, 'Could not download changes');
      if (!rows.length) return;
      const next = rows.at(-1).seq;
      // This person's own pushes come back too; only newer changes from others matter.
      const remote = rows.filter((r) => r.updated_by !== this.userId);
      await this.fetchAssets(remote, workspace);
      const content = remote.filter((r) => r.kind !== 'asset');
      const args = { workspace, rows: content, cursor: next, roles: this.roles };
      if (content.length) await this.transaction(() => this.call('syncApply', args));
      else await this.call('syncApply', { ...args, rows: [] });
    }
  }

  async fetchAssets(rows, workspace) {
    const needed = new Set();
    for (const r of rows)
      if (!r.deleted)
        for (const id of r.kind === 'asset'
          ? [r.id]
          : referencedAssets(r.kind, r.data, iconAssetId))
          needed.add(id);
    if (!needed.size) return;
    const missing = await this.call('syncMissingAssets', { ids: [...needed] });
    if (!missing.length) return;
    const names = new Map(
      rows.filter((r) => r.kind === 'asset').map((r) => [r.id, r.data?.name || 'file']),
    );
    const unknown = missing.filter((id) => !names.has(id));
    for (const part of chunks(unknown, 100)) {
      const { data, error } = await this.client
        .from('entities')
        .select('id, data')
        .eq('workspace_id', workspace)
        .eq('kind', 'asset')
        .in('id', part);
      fail(error, 'Could not look up files');
      for (const a of data) names.set(a.id, a.data?.name || 'file');
    }
    for (const id of missing) {
      const { data, error } = await this.client.storage
        .from('assets')
        .download(`${workspace}/${id}`);
      // A file the server does not let this person read is skipped; the board still opens.
      if (error) continue;
      const bytes = new Uint8Array(await data.arrayBuffer());
      await this.call('syncImportAsset', { bytes, name: names.get(id) || 'file', workspace });
    }
  }
}

function cloudConfig(packageJson) {
  const url = process.env.TERRA_CLOUD_URL || packageJson.terraCloud?.url;
  const key = process.env.TERRA_CLOUD_KEY || packageJson.terraCloud?.key;
  return url && key ? { url, key } : null;
}

module.exports = { CloudSync, cloudConfig };
