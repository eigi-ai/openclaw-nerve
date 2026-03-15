#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_NAME="upstream"
UPSTREAM_URL="https://github.com/daggerhashimoto/openclaw-nerve.git"
BRANCH="master"
TAG=""
PUSH_TO_ORIGIN=false
FORCE_RESET=false
ALLOW_DIRTY=false

usage() {
  cat <<EOF
Sync local branch with daggerhashimoto upstream.

Usage:
  $(basename "$0") [options]

Options:
  -b, --branch <name>      Branch to sync (default: master)
  -t, --tag <name>         Sync to a specific upstream release tag (e.g. v1.4.8)
  -u, --upstream-url <url> Upstream URL (default: ${UPSTREAM_URL})
  --push                   Push synced branch to origin
  --force-reset            Hard reset local branch to upstream/<branch>
  --allow-dirty            Allow running with uncommitted changes
  -h, --help               Show this help

Examples:
  $(basename "$0")
  $(basename "$0") --push
  $(basename "$0") --tag v1.4.8 --push
  $(basename "$0") --force-reset --push
EOF
}

while (($# > 0)); do
  case "$1" in
    -b|--branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    -t|--tag)
      TAG="${2:-}"
      shift 2
      ;;
    -u|--upstream-url)
      UPSTREAM_URL="${2:-}"
      shift 2
      ;;
    --push)
      PUSH_TO_ORIGIN=true
      shift
      ;;
    --force-reset)
      FORCE_RESET=true
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${BRANCH}" ]]; then
  echo "Branch name cannot be empty."
  exit 1
fi

if [[ -n "${TAG}" ]] && [[ -z "${TAG// }" ]]; then
  echo "Tag name cannot be empty."
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "This script must be run inside a git repository."
  exit 1
fi

if [[ "${ALLOW_DIRTY}" == false ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit/stash changes or pass --allow-dirty."
  exit 1
fi

echo "==> Ensuring ${UPSTREAM_NAME} points to ${UPSTREAM_URL}"
if git remote get-url "${UPSTREAM_NAME}" >/dev/null 2>&1; then
  git remote set-url "${UPSTREAM_NAME}" "${UPSTREAM_URL}"
else
  git remote add "${UPSTREAM_NAME}" "${UPSTREAM_URL}"
fi

echo "==> Fetching ${UPSTREAM_NAME}"
git fetch --tags "${UPSTREAM_NAME}"

if [[ -n "${TAG}" ]]; then
  if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "Tag not found: ${TAG}"
    exit 1
  fi
fi

echo "==> Checking out ${BRANCH}"
git checkout "${BRANCH}"

if [[ "${FORCE_RESET}" == true ]]; then
  echo "==> Hard resetting ${BRANCH} to ${UPSTREAM_NAME}/${BRANCH}"
  git reset --hard "${UPSTREAM_NAME}/${BRANCH}"
elif [[ -n "${TAG}" ]]; then
  echo "==> Resetting ${BRANCH} to release tag ${TAG}"
  git reset --hard "refs/tags/${TAG}"
else
  echo "==> Fast-forward merging ${UPSTREAM_NAME}/${BRANCH}"
  git merge --ff-only "${UPSTREAM_NAME}/${BRANCH}"
fi

if [[ "${PUSH_TO_ORIGIN}" == true ]]; then
  if [[ "${FORCE_RESET}" == true ]] || [[ -n "${TAG}" ]]; then
    echo "==> Force pushing ${BRANCH} to origin (with lease)"
    git push --force-with-lease origin "${BRANCH}"
  else
    echo "==> Pushing ${BRANCH} to origin"
    git push origin "${BRANCH}"
  fi
fi

echo "==> Done"
