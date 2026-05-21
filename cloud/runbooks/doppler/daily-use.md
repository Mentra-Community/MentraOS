# Doppler Daily Use

Day-to-day Doppler operations: logging in, picking the right
project + config, reading secrets, and running commands with
secrets injected.

## Install

```bash
brew install dopplerhq/cli/doppler
doppler --version
```

For non-Mac, see https://docs.doppler.com/docs/install-cli.

## Log in

```bash
doppler login
```

This opens a browser tab to authenticate. After it finishes you
are logged in for that shell. The token is stored locally; you
do not need to log in again until it expires.

```bash
doppler whoami
# you@mentra.glass
```

## Pick a default project + config

`doppler setup` walks you through picking a default project and
config for the current directory. Once set, future `doppler`
commands in that directory do not need `--project` and
`--config` flags.

```bash
cd cloud
doppler setup
# pick mentraos-cloud, then prod_central-us (or whichever you
# work with most often)
```

The setup is per-directory. You can have different defaults in
different repos / sub-folders.

## List secrets

```bash
# With a default set
doppler secrets

# Without a default
doppler secrets --project mentra-sre --config dev
```

Add `--only-names` to just get the names. Useful for diffing
which secrets exist across configs.

## Get one secret value

```bash
doppler secrets get FOO
doppler secrets get FOO --plain    # value only, no formatting
```

`--plain` is what you want when piping into another command.

## Run a command with secrets injected

This is the most common pattern. Doppler exports the project's
secrets as env vars and execs the command:

```bash
doppler run -- bun src/index.ts
```

With explicit project / config:

```bash
doppler run --project mentra-sre --config dev -- bstack health
```

The `--` separates Doppler's args from the inner command's args.

## Switching projects on the fly

Without changing the default:

```bash
doppler secrets --project <other-project> --config <other-config>
doppler run --project <other-project> --config <other-config> -- <cmd>
```

Use `doppler configure --scope $(pwd)` to change the default for
the current directory.

## Common patterns

### Inject prod cloud secrets into a local script

For one-off debugging that needs the same secrets prod has:

```bash
doppler run --project mentraos-cloud --config prod_central-us -- \
  bun some-debug-script.ts
```

Be careful. This connects to production-grade resources.

### Run bstack with mentra-sre credentials

The `bstack` CLI auto-detects Doppler if env vars are missing.
If your Doppler is configured, just:

```bash
bstack health
```

Manual fallback if auto-detect fails:

```bash
doppler run --project mentra-sre --config dev -- bstack health
```

### Compare two configs

```bash
doppler secrets --project mentraos-cloud --config prod_central-us \
  --only-names > /tmp/central
doppler secrets --project mentraos-cloud --config prod_us-east \
  --only-names > /tmp/east
diff /tmp/central /tmp/east
```

If a key is in one config but not the other, that is a drift to
fix.

## Common mistakes

- **Forgetting `--`**. `doppler run --project foo bun start` runs
  Doppler's `bun` flag, not your bun. Always
  `doppler run [...flags] -- bun start`.
- **Wrong config**. The configs share names across projects but
  do different things. `mentraos-cloud:dev` and
  `mentra-sre:dev` are unrelated.
- **Running with prod secrets in a local shell tab and forgetting
  about it**. Subsequent commands in the same shell do not
  inherit Doppler's env (Doppler injects per-command), but if
  you `doppler run -- bash` you have an interactive shell with
  prod secrets. Exit when done.
