# Only the host's own sockets and loopback interfaces are candidates.
exec 2>/dev/null
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
client=$(command -v psql)
if [ ! -x "$client" ]; then
    for candidate in /usr/lib/postgresql/*/bin/psql \
        /Applications/Postgres.app/Contents/Versions/latest/bin/psql \
        /opt/homebrew/opt/libpq/bin/psql /opt/homebrew/opt/postgresql*/bin/psql \
        /usr/local/opt/libpq/bin/psql /usr/local/opt/postgresql*/bin/psql; do
        [ -x "$candidate" ] || continue
        client=$candidate
        break
    done
fi
[ -x "$client" ] || exit 0
uid=$(id -u)
catalog="SELECT json_build_array(extract(epoch FROM pg_postmaster_start_time())::text || ':' || current_setting('port'), datname)::text FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(oid, 'CONNECT') ORDER BY datname"

attempt() {
    set -- "$client" -X -w -A -t -v ON_ERROR_STOP=1 -P pager=off \
        -h "$location" -p "$port" -d "$maintenance" -c "$catalog"
    if [ "$mode" != direct ]; then set -- "$@" -U postgres; fi
    case "$mode" in
        direct|postgres) env PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c default_transaction_read_only=on' "$@" ;;
        runuser) runuser -u postgres -- env PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c default_transaction_read_only=on' "$@" ;;
        sudo) sudo -n -u postgres -- env PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c default_transaction_read_only=on' "$@" ;;
    esac
}

probe() {
    location=$1
    port=$2
    for mode in direct postgres runuser sudo; do
        case "$mode" in
            runuser) [ "$uid" = 0 ] && command -v runuser >/dev/null || continue ;;
            sudo) command -v sudo >/dev/null || continue ;;
        esac
        for maintenance in postgres template1; do
            output=$(attempt </dev/null) || continue
            [ -n "$output" ] || continue
            # NUL separates batches; JSON preserves whitespace in database names.
            printf '%s\000%s\000%s\000%s\000%s\000' "$mode" "$client" "$location" "$port" "$output"
            return
        done
    done
}

for socket in /var/run/postgresql/.s.PGSQL.* /run/postgresql/.s.PGSQL.* /tmp/.s.PGSQL.*; do
    [ -S "$socket" ] || continue
    port=${socket##*.}
    case "$port" in ''|*[!0-9]*) continue ;; esac
    probe "${socket%/*}" "$port"
done
for location in 127.0.0.1 ::1; do
    for port in 5432 5433 5434; do probe "$location" "$port"; done
done
exit 0
