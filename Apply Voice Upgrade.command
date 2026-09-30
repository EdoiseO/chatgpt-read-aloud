#!/bin/zsh
set -eu
project_dir=${0:A:h}
cd "$project_dir"
exec /usr/bin/python3 "$project_dir/apply_voice_upgrade.py" --apply
