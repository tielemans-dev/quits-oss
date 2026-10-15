#!/bin/sh
# Keep unstaged changes visible to lint-staged.mjs; never hide or stage them.
exec ./node_modules/.bin/lefthook "$@" --no-stage-fixed
