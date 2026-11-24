#!/bin/sh
# Publish this folder to the public repo members install from
# (npx github:Ubiship/arkivist-claude, claude plugin marketplace add
# Ubiship/arkivist-claude). The source of truth stays here, in the UbiComm
# monorepo; the public repo is a published copy WITH dist/ built and
# committed, because neither `npx github:` nor a marketplace install runs a
# build step.
#
#   scripts/publish-repo.sh            build, test, commit and push
#   scripts/publish-repo.sh --dry-run  build and test, stage the copy, print
#                                      what would change; push nothing
set -eu

REPO=${ARKIVIST_PUBLIC_REPO:-Ubiship/arkivist-claude}
HERE=$(cd "$(dirname "$0")/.." && pwd)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

cd "$HERE"
VERSION=$(node -p "require('./package.json').version")
SRC_COMMIT=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- .)" ]; then
  echo "tools/arkivist-claude has uncommitted changes; commit them first." >&2
  exit 1
fi

npm ci --silent
npm run build --silent
npx tsc -p tsconfig.build.json
npm run check:bundle --silent
npx vitest run --silent
test -f dist/cli.js || { echo "dist/cli.js was not built" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git clone --quiet "https://github.com/$REPO.git" "$WORK/repo"
# Replace the published tree wholesale (deletions too), keeping its .git.
find "$WORK/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
tar -C "$HERE" --exclude=node_modules --exclude=.gitignore -cf - . | tar -C "$WORK/repo" -xf -
printf 'node_modules/\n' > "$WORK/repo/.gitignore"

cd "$WORK/repo"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to publish: $REPO already matches v$VERSION."
  exit 0
fi
git diff --cached --stat | tail -5
if [ "$DRY" = 1 ]; then
  echo "Dry run: would publish v$VERSION (from UbiComm $SRC_COMMIT) to $REPO."
  exit 0
fi
git commit --quiet -m "v$VERSION (from UbiComm $SRC_COMMIT)"
git push --quiet origin HEAD
echo "Published v$VERSION to https://github.com/$REPO"
