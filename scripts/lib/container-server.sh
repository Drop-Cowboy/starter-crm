#!/usr/bin/env bash
# Runs one Starter CRM container image as the "server under test" of the
# conformance suite, so the same cases that prove the Node and Python servers
# also prove what you actually ship.
#
#   SERVER_CMD="bash scripts/lib/container-server.sh starter-crm:test" node run.js
#
# Where it sits: the harness (server/conformance/run.js) starts one server per
# mode through a shell command, with the settings in the environment and a
# temporary starter root on disk. This script turns that into `docker run`:
#
# - The root (when the harness sets one) is mounted at the SAME path inside the container. The harness
#   writes absolute paths into the fixtures it creates (a log file the custom
#   log sink appends to), so a different path inside would break them.
# - The container uses the host network, so 127.0.0.1 reaches the mock Drop
#   Cowboy API and the OIDC issuer the harness starts, and the harness reaches
#   the server on the port it chose.
# - It runs as your own uid and gid so the server can write into the temp root.
#   The image's own non-root user is proved by the smoke check, not here.
# - Every environment variable the harness set is passed on, except the ones
#   that only make sense on your machine. DC_ENV is the exception that needs
#   care: the image defaults it to production, and the harness fixtures expect
#   the server default (development) unless their .env file says otherwise.
set -euo pipefail

image="${1:?usage: container-server.sh <image>}"
root="${STARTER_CRM_ROOT:-}"

# Only your own machine's settings stay out of the container.
host_only=" PATH HOME TMPDIR TEMP TMP LANG LC_ALL VIRTUAL_ENV PYTHONPATH PWD OLDPWD SHLVL _ USER LOGNAME SHELL TERM HOSTNAME "

# --no-healthcheck: the image's HEALTHCHECK probes the PORT, and the "port already
# in use" case parks a listener there that never answers, which held the harness
# open. The healthcheck itself is proved by the smoke check.
args=(run --rm --init --no-healthcheck --network host --user "$(id -u):$(id -g)")
if [[ -n "$root" ]]; then
    args+=(-v "$root:$root")
fi
for name in $(compgen -e); do
    case "$host_only" in *" $name "*) continue ;; esac
    args+=(-e "$name")
    # A setting that names an existing folder, such as DC_SECRETS_DIR, is
    # mounted read-only at the same path. Folders that do not exist are left
    # alone, so the server reports them as missing, which is what those cases check.
    # The folder holding DC_SQLITE_PATH is mounted writable, so containers of one
    # site share one database file.
    case "$name" in
        DC_SQLITE_PATH)
            value="${!name}"
            if [[ "$value" == /* && -d "$(dirname "$value")" && "$(dirname "$value")" != "$root" ]]; then
                args+=(-v "$(dirname "$value"):$(dirname "$value")")
            fi
            ;;
        DC_*_DIR)
            value="${!name}"
            if [[ "$value" == /* && -d "$value" && "$value" != "$root" ]]; then
                args+=(-v "$value:$value:ro")
            fi
            ;;
    esac
done

if [[ -z "${DC_ENV:-}" ]]; then
    from_file=""
    if [[ -n "$root" && -f "$root/.env" ]]; then
        from_file="$(sed -n 's/^DC_ENV=//p' "$root/.env" | tail -n 1)"
    fi
    args+=(-e "DC_ENV=${from_file:-development}")
fi

# exec, so SIGTERM from the harness reaches the docker client, which forwards
# it to the server and lets the graceful drain run.
exec docker "${args[@]}" "$image"
