# Trying showrunner in Herdr (hc-backend branch)

A setup guide for an agent preparing a machine for the trial: showrunner
sessions in herdr-core (`hc`) terminals, with the Herdr app as the UI (the
sidebar tree, the right panels, the status bar). The user-facing description
is in the main README, "In the Herdr app".

## Prerequisites

- The Herdr app (`herdr-app`) and herdr-core (`hc`) on the PATH. Tested with
  `herdr-app` 0.1.14 and `hc` 0.1.19. Open Herdr once, so
  `~/.config/herdr-app` exists.
- Rust, git, `gh` (for PR badges), python3.

## Install

1. Build this branch: `cargo build --release` in a checkout of `hc-backend`.
2. If the machine runs the tmux version, keep it for switching back:
   `cp ~/.cargo/bin/showrunner ~/.cargo/bin/showrunner-tmux`.
3. Install the build as `showrunner`. On macOS remove the old file first:
   copying over a binary in place gets the new one killed at launch
   (exit 137, silently if output is hidden).
   ```sh
   rm -f ~/.cargo/bin/showrunner && cp target/release/showrunner ~/.cargo/bin/showrunner
   showrunner --version
   ```
   Agents' skills call `showrunner`, so the hc build must be the one on the
   PATH. Sessions' Claude hooks call the binary that created them, by its
   absolute path, so keep it in one place.
4. Install the patched review panel (vim keys, per-branch base) **before**
   the next step: `showrunner herdr install` only puts it in the Changes
   panel's place when it is already installed.
   ```sh
   git clone -b local https://github.com/Bendzae/herdr-reviewer ~/code/personal/herdr-reviewer
   sh ~/code/personal/herdr-reviewer/scripts/install.sh --no-layout
   ```
   The fork's `local` branch merges `vim-keys` and `merge-base-config`; both
   are meant to go upstream (vytasgavelis/herdr-reviewer).
5. Install the mods, the layout and the keys:
   ```sh
   showrunner herdr install --bin ~/.cargo/bin/showrunner
   ```
   Its output should include "the Changes panel shows herdr-reviewer".
   `--bin` gives the mods an absolute path; Herdr may not have
   `~/.cargo/bin` on its PATH. Run this again after every rebuild: the mods
   are compiled into the binary.
6. Record the base of existing stacked tasks in git config. New tasks and
   set-base do it themselves; `gh pr create` and the review panel read it.
   ```sh
   showrunner list --json | python3 -c '
   import json, sys
   for p in json.load(sys.stdin)["projects"]:
       for t in p.get("tasks", []):
           if t.get("base_branch") not in (None, "main"):
               print(p["path"], t["branch"], t["base_branch"], sep="\t")' |
   while IFS=$'\t' read -r repo branch base; do
     git -C "$repo" config "branch.$branch.gh-merge-base" "$base"
   done
   ```
   (Don't name the loop variable `path` in zsh: it is the PATH.)
7. Move the sessions from tmux. Quit the old TUI, let busy agents finish,
   then run `showrunner migrate` from a terminal **outside** tmux, with tmux
   still running. It moves idle sessions into hc and resumes their
   conversations. It lists the ones it skipped: busy sessions, the one it
   runs in, and sessions it can't match to their own conversation. Run it
   again later for those.
8. In Herdr, switch to the **showrunner** layout with ⌘⇧L. In it, `⌃/` jumps
   between the tree and the terminal, `⌃'` picks the right panel, and
   `⌃b h`/`⌃b l` (or `⌘⌥←`/`⌘⌥→`) move the keyboard between panes and panels.

During the trial, never start the old `showrunner-tmux` TUI while sessions
run in hc. It recreates every saved session that isn't in tmux, so each
agent would run twice.

## Another machine

Sessions can also run on another machine, e.g. a dev box reached over ssh:
it runs its own hc and showrunner, and Herdr here shows its spaces. The tree
gets a section for it and runs every command there (`exec` with `on`).

1. On that machine: Claude (or the other agents), git, `gh`, and this
   branch built and installed as `showrunner` (keep the old binary as
   `showrunner-tmux` to switch back). Its non-interactive shell must find
   `showrunner` on the PATH (e.g. `~/.cargo/bin` in `~/.zshenv`).
   Claude starts a worktree without asking when it trusts the repository:
   open `claude` once in each project's repository there.
2. Here: `hc machine add <ssh host> --name <name> --install` (or Herdr's
   Settings > Machines). It copies hc there.
3. Sessions still running in tmux there move with `showrunner migrate`, run
   there from outside tmux. Saved sessions that aren't running come back by
   themselves when Herdr reaches the machine (`restore --no-coordinator`: the
   Coordinator runs here only).
4. After updating the branch, build and install it there again, and run
   `hc machine update <name>` when hc here was updated.

To switch that machine back: `hc machine rm <name>` here, then there
`hc server stop` (this ends its agents) and put `showrunner-tmux` back as
`showrunner`. The old version recreates the saved sessions in tmux when it
starts.

## Switching back to tmux

1. Quit Herdr, then run `hc server stop`. This ends the agents in hc.
2. `rm -f ~/.cargo/bin/showrunner && cp ~/.cargo/bin/showrunner-tmux ~/.cargo/bin/showrunner`
3. Start `showrunner`. Both versions use the same `~/.showrunner` data, so
   it recreates every session in tmux and resumes its conversation.

## Testing changes without touching the user's Herdr

Run a second Herdr with its own home, hc session and showrunner data:

```sh
T=/tmp/sr-test; mkdir -p $T/app $T/sr $T/bin
cat > $T/bin/showrunner <<EOF
#!/bin/sh
export SHOWRUNNER_HOME=$T/sr HC_SESSION=srtest
exec $PWD/target/debug/showrunner "\$@"
EOF
chmod +x $T/bin/showrunner
cargo build && HERDR_APP_HOME=$T/app $T/bin/showrunner herdr install --bin $T/bin/showrunner
HC_SESSION=srtest HERDR_APP_HOME=$T/app nohup env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u TMUX -u TMUX_PANE -u HC_TERMINAL_ID herdr-app > $T/app.log 2>&1 &
```

- Never point a test instance at the real `~/.showrunner`. The tree
  restores saved sessions when it starts, so it would start a second copy
  of every agent. Give `$T/sr` its own `config.toml` with a test project.
- Drive it with `HERDR_APP_HOME=$T/app` set: `herdr-app status` (the shown
  layout, focus, mod errors), `herdr-app do <command> '<json>'` (e.g.
  `layout.switch '{"name":"showrunner"}'`,
  `layout.select '{"stack":"panel-body","child":"changes"}'`,
  `layout.show '{"id":"panel"}'`), `herdr-app shot $T/shot.png`
  (crop with `sips`), `herdr-app check <mod folder>`, and
  `herdr-app do app.quit` to quit.
- Don't send keystrokes (osascript and the like) while the user's own
  Herdr is running: both are the same app, and the keys can land in theirs.
  `herdr-app do pane.go` doesn't move the keyboard into a panel, so test
  keyboard handling by asking the user to try it.
- Rebuild before `herdr install`: the mod files are embedded with
  `include_str!`.
- Another machine for the test instance: add it in its hc session with its
  own hc session there (`HC_SESSION=srtest hc machine add <host> --name
  devbox --session srtest`), give it a wrapper there like the one above
  (its own `SHOWRUNNER_HOME`, `HC_SESSION=srtest`), and point the mods at it
  in `$T/app/mods/showrunner/local.json`:
  `"machines": { "devbox": { "bin": "/path/to/wrapper" } }` (add it again
  after each `herdr install`).
