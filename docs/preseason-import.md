# Preseason import

The normal import command uses a fixed, root-installed broker. It accepts no
arguments, reads only the `fpl/api-football` secret, and writes only the
sanitized dataset to `data/preseason/2026-27.json`.

A human installs it once:

```bash
cd /home/kyle/fpl && sudo ./bin/install-preseason-broker
```

After that, agents run this without an interactive sudo prompt:

```bash
npm run fetch-preseason-data
```

The installer copies the importer and broker into root-owned, non-writable
paths, creates a root-only raw-response cache, and validates a sudoers rule
with `visudo`. The rule permits only the zero-argument
`/usr/local/bin/fpl-fetch-preseason-data` command. The broker has no fallback
to global secrets, arbitrary paths, caller arguments, or caller environment.

For controlled CI only, provide the credential through the CI secret manager
and use the separate direct entrypoint:

```bash
API_FOOTBALL_KEY="$API_FOOTBALL_KEY" npm run fetch-preseason-data:direct
```

The direct entrypoint does not use sudo. Never put the credential in the
repository, generated dataset, command arguments, or logs.
