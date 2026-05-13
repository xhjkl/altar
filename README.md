# Altar

A small Bun + SolidJS Postgres workbench.

The app is intentionally one-mode: a psql-like SQL line produces a result grid. Result sets become patchable only when the gateway can prove they map to a single relation with a primary key.

## Development

```bash
bun install
bun run dev
```

Open the app and enter a Postgres URL, for example `postgres://localhost/db`.
