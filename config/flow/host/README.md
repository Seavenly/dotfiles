# Flow owner host lifecycle

The replacement runtime has one host-owned owner process. The owner keeps the
durable `RunAuthority` open and drives only authority-projected work. Clients
are disposable: closing a client does not stop the owner or an accepted run.

The public lifecycle commands are:

```sh
flow start --json
flow status --json
flow stop --json
```

`flow start` launches one detached owner for interactive use. `flow status`
reports the endpoint, process identity, and lifecycle state without acquiring
the mutation lock. `flow stop` checks the recorded owner identity immediately
before signalling and refuses a mismatched endpoint. A stale endpoint is
reported and may be cleaned up only when its recorded socket and endpoint
paths still match.

The normal dotfiles convergence links this directory below
`~/.config/flow/host`; it does not install either host-manager definition into
an active manager directory and does not enable replacement launches. The
templates below are explicit opt-in sources for supported hosts:

- macOS: `macos/com.seavenly.flow-owner.plist` for a per-user LaunchAgent;
- Ubuntu: `ubuntu/flow-owner.service` for a per-user systemd unit.

Both definitions supervise `flow-owner`, a small managed wrapper that invokes
the long-lived owner entrypoint with `FLOW_OWNER_PROCESS=1`. The wrapper sets
the mise shim path because launchd and systemd user managers do not inherit an
interactive shell's PATH. The owner uses the same XDG state root as the public
CLI, normally `~/.local/state/flow`, with a mode `0700` directory, a mode
`0600` endpoint, and a mode `0600` Unix socket.

## macOS - explicit opt-in

Install and load the LaunchAgent only when the replacement runtime is
authorized for this host:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
ln -s "$HOME/.config/flow/host/macos/com.seavenly.flow-owner.plist" \
  "$HOME/Library/LaunchAgents/com.seavenly.flow-owner.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.seavenly.flow-owner.plist"
launchctl enable "gui/$(id -u)/com.seavenly.flow-owner"
```

Inspect and stop it with the public interface or the manager:

```sh
flow status --json
flow stop --json
launchctl print "gui/$(id -u)/com.seavenly.flow-owner"
```

To disable the opt-in definition, stop it first, then unload and remove only
the exact user-owned link:

```sh
launchctl bootout "gui/$(id -u)/com.seavenly.flow-owner"
rm "$HOME/Library/LaunchAgents/com.seavenly.flow-owner.plist"
```

## Ubuntu - explicit opt-in

Install and enable the user unit only when the replacement runtime is
authorized for this host. `systemctl --user` does not require root:

```sh
mkdir -p "$HOME/.config/systemd/user"
ln -s "$HOME/.config/flow/host/ubuntu/flow-owner.service" \
  "$HOME/.config/systemd/user/flow-owner.service"
systemctl --user daemon-reload
systemctl --user enable --now flow-owner.service
```

Inspect and stop it with the public interface or the manager:

```sh
flow status --json
flow stop --json
systemctl --user status flow-owner.service
```

To disable the opt-in definition, stop it first, then remove only the exact
user-owned link:

```sh
systemctl --user disable --now flow-owner.service
rm "$HOME/.config/systemd/user/flow-owner.service"
systemctl --user daemon-reload
```

The host manager is a restart mechanism, not a second lifecycle authority.
After an unexpected owner exit, a restarted owner replays its durable
authority and resumes only safe admitted work. A changed boot identity still
requires each affected run's explicit `reboot_admission` command. Human
checkpoints, capability expansion, uncertain effects, and terminal
disposition remain explicit stops for an operator.
