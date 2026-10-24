#!/bin/sh
# terra-migrate: applies the Terra Board schema to the server's database.
# Part of ee/ (Terra Board Enterprise License, see ee/LICENSE).
#
# Core migrations (/terra/migrations/core = supabase/migrations) first, then company features
# (/terra/migrations/ee = ee/supabase/migrations), each sorted by file name. Every file runs in
# one transaction together with its row in terra_server.migrations, so a re-run applies only
# new files and a failed file leaves nothing behind. Connects as the postgres user (PG* env).
set -eu

log() { echo "terra-migrate: $*"; }
fail() {
	echo "terra-migrate: $*" >&2
	exit 1
}

q() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

log "waiting for the database"
i=0
until pg_isready -q; do
	i=$((i + 1))
	[ "$i" -lt 180 ] || fail "database did not come up"
	sleep 1
done

# Auth, Storage and Realtime create their own tables when they start; the migrations need them.
log "waiting for auth, storage and realtime tables"
i=0
until [ "$(q -c "select to_regclass('auth.sessions') is not null and to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null and to_regclass('realtime.messages') is not null" 2>/dev/null)" = "t" ]; do
	i=$((i + 1))
	[ "$i" -lt 300 ] || fail "auth.sessions, storage.objects or realtime.messages never appeared (are auth, storage and realtime running?)"
	sleep 1
done

q <<'SQL'
create schema if not exists terra_server;
revoke all on schema terra_server from public;
create table if not exists terra_server.migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
SQL

applied=0
for set in core ee; do
	dir="/terra/migrations/$set"
	[ -d "$dir" ] || continue
	for file in $(find "$dir" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort); do
		name="$set/$(basename "$file")"
		done_already=$(q -v name="$name" <<'SQL'
select count(*) from terra_server.migrations where name = :'name';
SQL
)
		[ "$done_already" = "0" ] || continue
		log "applying $name"
		q -v name="$name" -v file="$file" <<'SQL' || fail "$name failed; nothing from it was kept. Fix it and run again."
begin;
\i :file
insert into terra_server.migrations (name) values (:'name');
commit;
SQL
		applied=$((applied + 1))
	done
done
log "$applied new migration(s) applied"

if [ -n "${TERRA_NAME:-}" ]; then
	q -v name="$TERRA_NAME" <<'SQL'
update public.server_settings set name = :'name' where id and name is distinct from :'name';
SQL
fi

if [ -n "${TERRA_ADMIN_EMAIL:-}" ]; then
	has=$(q -c "select to_regclass('public.server_admins') is not null")
	if [ "$has" = "t" ]; then
		q -v email="$TERRA_ADMIN_EMAIL" <<'SQL'
insert into public.server_admins (email) values (lower(:'email')) on conflict do nothing;
SQL
		log "server admin: $(printf "%s" "$TERRA_ADMIN_EMAIL" | tr "A-Z" "a-z")"
	else
		log "public.server_admins does not exist; TERRA_ADMIN_EMAIL not added"
	fi
fi

log "done"
