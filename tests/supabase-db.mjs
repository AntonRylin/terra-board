// Runs supabase/migrations in PGlite (Postgres in WebAssembly) on top of a small stand-in
// for the parts of Supabase they use: the auth, storage and realtime schemas, the API roles
// and auth.uid() / auth.jwt(), which read the request's JWT claims like Supabase does.
// Used by tests that check the SQL without Docker or a Supabase project.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migrations = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));

const supabaseStub = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  is_anonymous boolean not null default false
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated, service_role;

create schema realtime;
grant usage on schema realtime to authenticated;
create table realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null,
  payload jsonb
);
alter table realtime.messages enable row level security;
grant all on realtime.messages to authenticated;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
grant execute on function realtime.topic() to authenticated;
`;

export async function supabaseDb({ until } = {}) {
  const db = await PGlite.create();
  await db.exec(supabaseStub);
  const files = fs
    .readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (until && file > until) break;
    try {
      await db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
  }
  return new TestServer(db);
}

class TestServer {
  constructor(db) {
    this.db = db;
  }

  // A new auth user, as Supabase creates on sign-in. Returns a person to act as.
  async user({ anonymous = false, email = null } = {}) {
    const id = randomUUID();
    await this.db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)', [
      id,
      anonymous ? null : (email ?? `${id.slice(0, 8)}@example.com`),
      anonymous,
    ]);
    const session = randomUUID();
    await this.db.query('insert into auth.sessions (id, user_id) values ($1, $2)', [session, id]);
    return new Person(this, { id, anonymous, email, session });
  }

  // Runs SQL as the database owner (the service role in Supabase terms).
  async admin(sql, params) {
    if (!params) {
      const results = await this.db.exec(sql);
      return results.at(-1)?.rows ?? [];
    }
    return (await this.db.query(sql, params)).rows;
  }
}

class Person {
  constructor(server, { id, anonymous, email, session }) {
    this.server = server;
    this.id = id;
    this.anonymous = anonymous;
    this.email = email;
    this.session = session;
  }

  // Runs one statement as this person through the API role, with their JWT claims,
  // inside a transaction like PostgREST does.
  async query(sql, params = []) {
    const claims = JSON.stringify({
      sub: this.id,
      role: 'authenticated',
      is_anonymous: this.anonymous,
      email: this.email,
      session_id: this.session,
    });
    return this.server.db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.exec('set local role authenticated');
      return (await tx.query(sql, params)).rows;
    });
  }

  // Calls a function the way supabase.rpc does and returns its value.
  async rpc(name, args = {}) {
    const keys = Object.keys(args);
    const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const rows = await this.query(
      `select public.${name}(${list}) as value`,
      keys.map((k) => args[k]),
    );
    return rows[0]?.value;
  }
}
