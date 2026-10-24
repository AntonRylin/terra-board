#!/bin/sh
# Caddy entrypoint for the Terra Board server. Part of ee/ (see ee/LICENSE).
# Writes /.well-known/terra-board.json from the environment, then starts Caddy.
set -eu

fail() {
	echo "caddy-start: $*" >&2
	exit 1
}

[ -n "${TERRA_URL:-}" ] || fail "TERRA_URL is not set (run setup.mjs)"
[ -n "${ANON_KEY:-}" ] || fail "ANON_KEY is not set (run setup.mjs)"

# Never publish a secret key: refuse sb_secret_ keys and service_role JWTs.
case "$ANON_KEY" in
	sb_secret_*) fail "ANON_KEY is a secret key; it must be the public anon key" ;;
esac
payload=$(printf '%s' "$ANON_KEY" | cut -d. -f2 | tr '_-' '/+')
case $((${#payload} % 4)) in
	2) payload="$payload==" ;;
	3) payload="$payload=" ;;
esac
role=$(printf '%s' "$payload" | base64 -d 2>/dev/null | tr -d ' \n' | sed -n 's/.*"role":"\([^"]*\)".*/\1/p')
[ "$role" = "anon" ] || fail "ANON_KEY is not an anon key (role: ${role:-unknown})"

json_escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

case "${SAML_ENABLED:-false}" in
	true | TRUE | True | 1) sso=true ;;
	*) sso=false ;;
esac

mkdir -p /srv/public/.well-known
cat >/srv/public/.well-known/terra-board.json <<EOF
{
  "name": "$(json_escape "${TERRA_NAME:-Terra Board server}")",
  "supabaseUrl": "$(json_escape "$TERRA_URL")",
  "publicKey": "$(json_escape "$ANON_KEY")",
  "signIn": { "email": true, "sso": $sso }
}
EOF

PROXY_AUTH_PASSWORD=$(caddy hash-password --plaintext "$PROXY_AUTH_PASSWORD")
export PROXY_AUTH_PASSWORD
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
