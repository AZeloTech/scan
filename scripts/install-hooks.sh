#!/bin/sh
# Run once per clone: git config core.hooksPath .githooks
set -e
root="$(git rev-parse --show-toplevel)"
chmod +x "$root/.githooks/pre-commit"
git -C "$root" config core.hooksPath .githooks
echo "hooks installed: core.hooksPath=.githooks (pre-commit runs the PII guard)"
