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

class CloudSync {
  constructor({ call, root, config, safeStorage, transaction, onStatus }) {
    this.call = call;
    this.config = config;
    this.transaction = transaction;
    this.onStatus = onStatus;
    this.status = { configured: !!config, state: 'off', pending: 0, lastSync: null, error: null };
    this.timer = null;
    this.poll = null;
    this.running = null;
    this.again = false;
    this.channel = null;
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

  async start() {
    if (!this.client) return this.status;
    const local = await this.call('syncStatus');
    if (!local.enabled) return this.emit({ state: 'off', pending: 0, workspace: null });
    this.workspace = local.workspace;
    this.emit({ state: 'syncing', pending: local.pending, workspace: local.workspace });
    const { data } = await this.client.auth.getSession();
    if (!data.session)
      return this.emit({ state: 'error', error: 'Signed out. Turn sync on again.' });
    this.userId = data.session.user.id;
    this.listen();
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

  async enable() {
    this.requireClient();
    await this.signIn();
    const { data, error } = await this.client.rpc('create_workspace', {
      p_name: 'My boards',
      p_device: os.hostname(),
    });
    fail(error, 'Could not create your sync space');
    await this.call('syncEnable', { workspace: data });
    return this.start();
  }

  async join(code) {
    this.requireClient();
    if (typeof code !== 'string' || code.length > 40)
      throw Error('Enter the code from your other device');
    await this.signIn();
    const { data, error } = await this.client.rpc('redeem_pairing_code', {
      p_code: code,
      p_device: os.hostname(),
    });
    fail(error, 'This code is wrong or has expired');
    await this.call('syncEnable', { workspace: data });
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
    await this.call('syncDisable');
    this.workspace = null;
    return this.emit({ state: 'off', pending: 0, workspace: null, error: null, lastSync: null });
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
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = null;
  }

  // Other devices ping after they push so changes arrive within a second.
  listen() {
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = this.client
      .channel('terra:' + this.workspace)
      .on('broadcast', { event: 'pushed' }, () => this.schedule(200))
      .subscribe();
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

  async run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const pushed = await this.push();
          await this.pull();
          if (pushed) await this.channel?.send({ type: 'broadcast', event: 'pushed', payload: {} });
        } while (this.again && this.workspace);
        const local = await this.call('syncStatus');
        this.emit({ state: 'synced', pending: local.pending, lastSync: Date.now(), error: null });
      } catch (e) {
        const local = await this.call('syncStatus').catch(() => ({ pending: this.status.pending }));
        this.emit({
          state: offline(e) ? 'offline' : 'error',
          pending: local.pending,
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
    let pushed = false;
    for (;;) {
      const batch = await this.call('syncTake', { limit: 200 });
      if (!batch.entries.length) return pushed;
      this.emit({ state: 'syncing', pending: Math.max(this.status.pending, batch.entries.length) });
      for (const a of batch.assets) await this.upload(a);
      const rows = [
        ...batch.assets.map((a) => ({
          kind: 'asset',
          board_id: '',
          id: a.id,
          data: { name: a.name, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes },
          deleted: false,
        })),
        ...batch.entries.map(({ queued, ...e }) => e),
      ];
      for (let i = 0; i < rows.length; i += 400) {
        const { error } = await this.client.rpc('push_entities', {
          p_workspace: this.workspace,
          p_rows: rows.slice(i, i + 400),
        });
        fail(error, 'Could not upload changes');
      }
      const local = await this.call('syncAck', {
        entries: batch.entries,
        assets: batch.assets.map((a) => a.id),
      });
      this.emit({ pending: local.pending });
      pushed = true;
    }
  }

  async upload(asset) {
    const bytes = fs.readFileSync(asset.file);
    const { error } = await this.client.storage
      .from('assets')
      .upload(`${this.workspace}/${asset.id}`, bytes, {
        contentType: asset.mime || 'application/octet-stream',
        upsert: false,
      });
    // Content-addressed: an existing file is already the same bytes.
    if (error && !/exists|duplicate|409/i.test(`${error.message} ${error.statusCode}`))
      fail(error, 'Could not upload a file');
  }

  async pull() {
    for (;;) {
      const { cursor } = await this.call('syncStatus');
      const { data: rows, error } = await this.client
        .from('entities')
        .select('kind, board_id, id, data, deleted, seq, updated_by')
        .eq('workspace_id', this.workspace)
        .gt('seq', cursor)
        .order('seq')
        .limit(500);
      fail(error, 'Could not download changes');
      if (!rows.length) return;
      const next = rows.at(-1).seq;
      // This device's own pushes come back too; only newer changes from others matter.
      const remote = rows.filter((r) => r.updated_by !== this.userId);
      await this.fetchAssets(remote);
      const content = remote.filter((r) => r.kind !== 'asset');
      if (content.length) {
        await this.transaction(() => this.call('syncApply', { rows: content, cursor: next }));
      } else await this.call('syncApply', { rows: [], cursor: next });
    }
  }

  async fetchAssets(rows) {
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
    if (unknown.length) {
      const { data, error } = await this.client
        .from('entities')
        .select('id, data')
        .eq('workspace_id', this.workspace)
        .eq('kind', 'asset')
        .in('id', unknown);
      fail(error, 'Could not look up files');
      for (const a of data) names.set(a.id, a.data?.name || 'file');
    }
    for (const id of missing) {
      const { data, error } = await this.client.storage
        .from('assets')
        .download(`${this.workspace}/${id}`);
      fail(error, 'Could not download a file');
      const bytes = new Uint8Array(await data.arrayBuffer());
      await this.call('syncImportAsset', { bytes, name: names.get(id) || 'file' });
    }
  }
}

function cloudConfig(packageJson) {
  const url = process.env.TERRA_CLOUD_URL || packageJson.terraCloud?.url;
  const key = process.env.TERRA_CLOUD_KEY || packageJson.terraCloud?.key;
  return url && key ? { url, key } : null;
}

module.exports = { CloudSync, cloudConfig };
