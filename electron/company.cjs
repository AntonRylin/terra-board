// The company server's admin side (ee/supabase/migrations): who may administer the server,
// the people on it, the audit log and the license key. Talks to the server through the
// signed-in Supabase client; the license key itself is checked here (license.cjs).
//
// It uses no Node or Electron API, like cloud-auth.cjs.
//
//   const company = createCompany({ client, hosts: ['terra.acme.eu', 'https://api.acme.eu'] });
//   await company.status(); // null on a server without the company migrations

const { verifyLicense, licenseSummary, FREE_PEOPLE } = require('./license.cjs');

const NO_CONNECTION = 'Could not reach the server. Check your internet connection.';
const NOT_ADMIN = 'Only a server admin can do this.';

const offline = (e) =>
  /fetch failed|network|Failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    `${e?.name || ''} ${e?.message || e || ''}`,
  );

// The server's own messages from the company RPCs are written for people (raise exception
// '...'); anything else becomes the fallback.
function failure(error, fallback) {
  if (offline(error)) return new Error(NO_CONNECTION);
  if (error?.code === '42501') return new Error(error.message || NOT_ADMIN);
  if (['22023', 'P0001', '23514'].includes(error?.code) && error.message)
    return new Error(error.message);
  return new Error(fallback);
}

async function call(client, name, args, fallback) {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch (e) {
    throw failure(e, fallback);
  }
  if (result.error) {
    const e = failure(result.error, fallback);
    e.code = result.error.code;
    throw e;
  }
  return result.data;
}

// Rows come back as a jsonb array or as table rows; either way, an array of objects.
const list = (data) => (Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : []);
const pick = (row, ...keys) => {
  for (const k of keys) if (row?.[k] !== undefined) return row[k];
  return null;
};

function person(row) {
  return {
    id: pick(row, 'id', 'user_id'),
    email: pick(row, 'email'),
    createdAt: pick(row, 'createdAt', 'created_at', 'created'),
    lastSignIn: pick(row, 'lastSignIn', 'last_sign_in_at', 'lastSignInAt'),
    disabled: pick(row, 'disabled') === true,
    admin: pick(row, 'admin', 'is_admin') === true,
    devices: Number(pick(row, 'devices') ?? 0),
    storageBytes: Number(pick(row, 'storageBytes', 'storage_bytes', 'storage') ?? 0),
  };
}

function event(row) {
  return {
    id: Number(pick(row, 'id')),
    at: pick(row, 'at'),
    actorEmail: pick(row, 'actorEmail', 'actor_email'),
    action: pick(row, 'action'),
    target: pick(row, 'target'),
    details: pick(row, 'details') || {},
  };
}

function createCompany({ client, hosts = [] }) {
  if (!client) throw new Error('createCompany needs a Supabase client');
  const company = {
    // { admin, people, freePeople, audit, license, summary } for a signed-in person, or null
    // when the server has no company migrations. license is the key's check without the key
    // (state, customer, seats, expires, message), or null when none is set.
    async status() {
      let data;
      try {
        data = await call(client, 'company_status', {}, 'Could not load the server status.');
      } catch (e) {
        // PostgREST: unknown function. A plain Supabase server without ee/.
        if (e.code === 'PGRST202' || e.code === '42883') return null;
        throw e;
      }
      if (!data || typeof data !== 'object') return null;
      const key = typeof data.license === 'string' && data.license ? data.license : null;
      const license = key ? await verifyLicense(key, { hosts }) : null;
      const people = Number(data.people ?? 0);
      const freePeople = Number(data.freePeople ?? FREE_PEOPLE);
      return {
        admin: data.admin === true,
        people,
        freePeople,
        audit: data.audit !== false,
        license,
        summary: licenseSummary({ people, freePeople, license }),
      };
    },

    async people({ search = '', limit = 200, offset = 0 } = {}) {
      const data = await call(
        client,
        'admin_people',
        { p_search: String(search || '').slice(0, 200) || null, p_limit: limit, p_offset: offset },
        'Could not load the people on this server.',
      );
      return list(data).map(person);
    },

    async setDisabled(userId, disabled) {
      await call(
        client,
        'admin_set_disabled',
        { p_user: userId, p_disabled: !!disabled },
        disabled ? 'Could not disable this sign-in.' : 'Could not enable this sign-in.',
      );
    },

    async setAdmin(email, admin) {
      await call(
        client,
        'admin_set_admin',
        {
          p_email: String(email || '')
            .trim()
            .toLowerCase(),
          p_admin: !!admin,
        },
        'Could not change who is an admin.',
      );
    },

    // Checks the key before saving it, so a typo never replaces a working license.
    // null removes the key.
    async setLicense(key) {
      const text = typeof key === 'string' ? key.trim() : '';
      if (text) {
        const check = await verifyLicense(text, { hosts });
        if (check.state === 'invalid' || check.state === 'server' || check.state === 'expired')
          throw new Error(check.message);
      }
      await call(
        client,
        'admin_set_license',
        { p_key: text || null },
        'Could not save the license key.',
      );
    },

    async setAudit(on) {
      await call(client, 'admin_set_audit', { p_on: !!on }, 'Could not change the audit log.');
    },

    // Newest first; before: the id of the oldest event already shown.
    async audit({ before = null, limit = 200 } = {}) {
      const data = await call(
        client,
        'admin_audit',
        { p_before: before, p_limit: limit },
        'Could not load the audit log.',
      );
      return list(data).map(event);
    },
  };
  return company;
}

// The audit log as CSV, for Export.
function auditCsv(events) {
  const cell = (v) => {
    let text =
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // A leading = + - @ would make a spreadsheet run the cell as a formula.
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = ['time,person,action,target,details'];
  for (const e of events)
    lines.push([e.at, e.actorEmail, e.action, e.target, e.details].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { createCompany, auditCsv };
