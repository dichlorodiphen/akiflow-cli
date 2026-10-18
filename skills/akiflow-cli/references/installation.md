# Installation

This private fork's command surface differs from the original npm package and
upstream release binaries. Build this repository to install the matching CLI:

```bash
git clone https://github.com/dichlorodiphen/akiflow-cli.git
cd akiflow-cli
bun install --frozen-lockfile
bun run build
mkdir -p ~/.local/bin
install -m 0755 ./af ~/.local/bin/af
```

Use Bun 1.3.14 (the verified CI version) and ensure `~/.local/bin` is on PATH.
Dependencies are local, ignored build inputs; do not commit `node_modules` symlinks.
To update, preserve any local changes, pull the intended source revision, reinstall
locked dependencies, run the repository checks, rebuild, and replace the binary.
Keep a rollback copy and record the revision for local builds. `af --version` reports
the package version, which alone does not distinguish local patches.

## Verify installation

```bash
af --version
af --help
af reconcile --help
```

## First-time setup

Sign in to Akiflow in a supported browser, then explicitly extract credentials:

```bash
af auth login
af auth verify --json
```

Chrome, Firefox, Safari, Arc, Brave, and Edge storage discovery is supported.
Platform-specific extraction still depends on browser storage format and OS access.
Do not copy credentials or production caches into the repository. Run `af refresh`
to populate local observations after authentication.

For another Akiflow login, first run `af profile create <name>`, then use
`af --profile <name> auth login` and `af --profile <name> auth verify --json`.
Confirm the returned identity before using that profile. Use explicit `--profile`
selection rather than changing the saved default for a single operation.
