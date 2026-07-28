#!/bin/zsh
cd "$(dirname "${BASH_SOURCE[0]}")"

# Get current shell command
SHELL_COMMAND=$(ps -o comm= -p $$)
SHELL_NAME="${SHELL_COMMAND#-}"
CURR_FOLDERNAME="$(dirname "$0")"

cd "$CURR_FOLDERNAME"

$SHELL_NAME "$CURR_FOLDERNAME/a11y_assist_shell.sh" $SHELL_NAME
