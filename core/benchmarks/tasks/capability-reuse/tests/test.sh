#!/bin/sh
set -eu
exec bun "$LUDENS_BENCH_TASK_DIR/tests/verify.ts"
