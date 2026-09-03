#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node --no-warnings ./bin/maskshift.mjs "$@"
