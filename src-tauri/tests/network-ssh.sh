#!/bin/sh
# Simulate an SSH transport in an isolated test process; no machine or network settings change.
directory=$ALTAR_NETWORK_TEST_DIRECTORY
for argument; do script=$argument; done
phase=$(cat "$directory/link")
case "$script" in
    *journalctl*) kind=journal ;;
    *) kind=vitals ;;
esac
if [ "$phase" = down ]; then
    printf '%s\n' "$kind" >> "$directory/failed"
    printf 'ssh: connection unavailable\n' >&2
    exit 255
fi

record() {
    printf '__CURSOR=s=fixture;i=%s\n__REALTIME_TIMESTAMP=170000000000000%s\n_SYSTEMD_UNIT=api.service\nSYSLOG_IDENTIFIER=api\nMESSAGE=event-%s\n\n' "$1" "$1" "$1"
}

case "$script" in
    *journalctl*'-n 20000'*) printf P; record 1; exit 0 ;;
    *journalctl*)
        printf R
        case "$script" in
            *'i=1'*) record 2 ;;
            *'i=2'*) [ "$phase" != restored ] || record 3 ;;
        esac
        while [ "$(cat "$directory/link")" != down ]; do sleep 0.05; done
        ;;
    *)
        while [ "$(cat "$directory/link")" != down ]; do
            printf 'cpupct 12\nmem 100 50\ndisk 100 25\nuptime 60\ncores 2\n--\n'
            sleep 0.05
        done
        ;;
esac
printf 'ssh: connection interrupted\n' >&2
exit 255
