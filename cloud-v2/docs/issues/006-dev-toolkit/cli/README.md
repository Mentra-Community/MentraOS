# Mentra CLI

**Status:** Draft. Part of the Dev Toolkit (see ../README.md).

The Mentra CLI v2 is specified in
[`../../012-mentra-cli-v2/`](../../012-mentra-cli-v2/).

Direction:

- `@mentra/cli` owns the public `mentra` binary.
- `@mentra/miniapp-cli` or a split `@mentra/miniapp-tools` package provides
  reusable build/pack/dev helpers.
- Common miniapp scripts should stay short: `mentra dev`, `mentra build`,
  `mentra pack`, `mentra publish`.
