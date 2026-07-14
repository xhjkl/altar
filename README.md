# Altar

A small Bun + SolidJS Postgres workbench.

The app is intentionally one-mode: a psql-like SQL line produces a result grid. Result sets become patchable only when the gateway can prove they map to a single relation with a primary key.

Altar is deliberately a local, single-user tool. Its PostgreSQL client occupies one process-wide connection slot, so a second browser session can replace the first session's active connection.

## Development

```bash
bun install
bun run dev
```

Open the app and enter a Postgres URL, for example `postgres://localhost/db`.
