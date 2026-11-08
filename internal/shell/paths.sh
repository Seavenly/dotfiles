#!/usr/bin/env bash

# Load machine-local paths with a stable precedence:
# explicit environment > paths.env > repository defaults.
dotfiles_load_paths() {
  local paths_file projects_override notes_override
  paths_file="${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles/paths.env"
  projects_override="${PROJECTS_DIR:-}"
  notes_override="${NOTES_DIR:-}"

  PROJECTS_DIR="$HOME/dev"
  NOTES_DIR="$HOME/notes"
  # shellcheck disable=SC1090
  [[ ! -r "$paths_file" ]] || source "$paths_file"
  [[ -z "$projects_override" ]] || PROJECTS_DIR="$projects_override"
  [[ -z "$notes_override" ]] || NOTES_DIR="$notes_override"
  export PROJECTS_DIR NOTES_DIR
}
