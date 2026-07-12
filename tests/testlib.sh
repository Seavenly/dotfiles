#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "expected output not to contain: $needle"
}

assert_status() {
  local actual="$1"
  local expected="$2"
  [[ "$actual" -eq "$expected" ]] || fail "expected status $expected, got $actual"
}
