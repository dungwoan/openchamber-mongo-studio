English | [Tiếng Việt](README.vi.md)

# Mongo Studio

An OpenChamber extension for connecting to MongoDB, browsing collections, viewing and editing documents, and running mongo-shell style queries (similar to NoSQLBooster).

## Structure

| Path | Role |
|---|---|
| `panel/` | UI (sandboxed iframe): Connection → Database → Collection tree, Collection tab, Query tab |
| `service/` | Node service running on the local machine: holds the MongoDB client, stores connections, runs queries |
| `shared/query-parser.ts` | Mongo-shell syntax parser, shared by the panel (validation) and the service (execution). Does not use `eval` |
| `shared/api.ts` | Data types for the panel ↔ service contract |

## Installing for Users

Option 1: open Settings → Extensions and add the extension by URL:

```
https://github.com/dungwoan/openchamber-mongo-studio
```

Option 2: click the button below (opens the OpenChamber desktop app, which asks for confirmation before downloading):

[Install Mongo Studio](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2Fdungwoan%2Fopenchamber-mongo-studio)

> Note: connection passwords are stored as **plain text** in `~/.openchamber-mongo-studio/connections.json` (mode `0600`). Anyone who can log in to this OS account can read them. See the Security section below.

## Setup and Checks

```bash
bun install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
bun test shared/
```

Then add this folder in Settings → Extensions.

## Security

- The URI (including the password) is stored in `~/.openchamber-mongo-studio/connections.json`, mode `0600`, inside a directory with mode `0700`. It is plain text: anyone who can read this file (same OS account) can see the passwords.
- The panel never receives the full URI. The connection list only contains the name, the host (credentials removed) and the status.
- The service listens only on `127.0.0.1` and requires a bearer token on every route, including `/health`.
- Connections marked Read-only block all write operations, including `$out`/`$merge` in aggregate.

## Query Syntax

`db.<collection>.find(filter, projection).sort(...).skip(n).limit(n)`, `findOne`, `count`/`countDocuments`, `distinct`, `aggregate([...], {allowDiskUse, maxTimeMS})`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `db.getCollectionNames()`, `db.stats()`, and `db.getCollection("name")`.

Arguments are relaxed JS literals: unquoted keys, single or double quotes, trailing commas, comments, regex `/abc/i`, and `ObjectId`, `ISODate`, `new Date`, `NumberLong`, `NumberInt`, `NumberDecimal`, `UUID`. Any other function is rejected with the line and column position.

Ctrl/⌘ + Enter runs the command at the cursor. Find and aggregate return at most 500 rows.
