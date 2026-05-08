# Auth (Phase 22)

icarus is a single-tenant, self-hosted tool. The auth system is
intentionally small: **JWT-bearer auth on every HTTP route and the
WebSocket fanout, backed by a SQLite users table managed via
[`aerekos-record`](https://www.npmjs.com/package/aerekos-record)**.
There's no signup flow, no SSO, no refresh-token dance. You boot the
server, sign in as `admin`, change the password, and you're done.

This doc covers the contract (so you know what's authenticated and
what isn't), the storage layout, the JWT shape, and how to recover
when something goes sideways (forgot password, rotate the JWT secret,
etc.).

---

## TL;DR

- First-boot credentials: **`admin` / `changeme`**.
- The first sign-in flips `must_change_password=true` on the JWT and
  every protected route 403s with `must_change_password: true` until
  the password is changed via `/v1/auth/change-password`.
- After the change, the app re-issues a token with
  `must_change_password: false` and routes you back to the main UI.
- Tokens are HS256 JWTs, default lifetime `7d`, stored in localStorage
  on the client and sent as `Authorization: Bearer <jwt>` on every
  request.
- Public endpoints (no token required): `GET /health`, `POST
  /v1/auth/login`. Everything else requires a valid token.
- The WebSocket fanout at `/v1/events` requires the token as a
  `?token=` query param at upgrade time.

---

## Endpoints

### `POST /v1/auth/login`

```json
{ "username": "admin", "password": "changeme" }
```

Response (`200`):

```json
{
  "token": "eyJhbGciOi…",
  "user": {
    "id": "uuid",
    "username": "admin",
    "must_change_password": true,
    "last_login_at": "2026-05-08T00:46:12.668Z",
    "created_at": "2026-05-08T00:46:12.668Z",
    "updated_at": "2026-05-08T00:46:12.668Z"
  }
}
```

Errors:

- `400 bad_request` — missing username/password.
- `401 invalid_credentials` — wrong username or password.

### `GET /v1/auth/me`

Returns the authenticated user. `401` if no token / token expired.

### `POST /v1/auth/change-password`

```json
{ "current_password": "changeme", "new_password": "..." }
```

Validates:

- `new_password` length ≥ 8 and ≤ 256.
- `new_password` ≠ `current_password`.
- `current_password` matches the stored bcrypt hash.

On success returns a fresh `{ token, user }` envelope (same shape as
login) with `must_change_password: false`. Use this token for
subsequent requests immediately — the previous one is still valid
until expiry but carries the stale `must_change_password: true`
claim, which blocks every protected route.

Errors:

- `400 weak_password` — fails the policy.
- `400 password_unchanged` — new password equals current.
- `401 invalid_credentials` — current password is wrong.

### `POST /v1/auth/logout`

Idempotent stateless endpoint. JWTs are not blacklisted server-side,
so "logout" really just means "drop the token client-side" — this
endpoint exists so the client can `await` a clean POST and not stash
the request in retry queues.

### Auth-gated routes

Everything else (`/projects`, `/chats`, `/v1/mutations/apply`,
`/v1/voice/*`, `/v1/settings/*`, etc.) requires a valid `Bearer`
token. While `must_change_password` is set, the auth middleware
returns `403 must_change_password` for everything except `/v1/auth/{me,
logout, change-password}`.

### `WebSocket /v1/events?token=<jwt>`

The browser's `WebSocket` API can't attach custom headers, so the
client passes the JWT in the URL. The handshake is gated:

- Missing token → `401 Unauthorized`, socket never opens.
- Invalid/expired token → `401 Unauthorized`.
- Valid token → upgrade succeeds, server emits an initial `ping`.

When the client logs out (or hits a 401 elsewhere and clears its
cached token), the WS layer closes the socket. When a fresh token
appears, it reconnects automatically.

---

## JWT shape

```json
{
  "sub": "<user uuid>",
  "username": "admin",
  "must_change_password": false,
  "iat": 1778201437,
  "exp": 1778806237
}
```

- Algorithm: `HS256`.
- Lifetime: `JWT_EXPIRES_IN` (default `7d`). Anything that the
  [`jsonwebtoken`](https://www.npmjs.com/package/jsonwebtoken)
  package accepts (`"15m"`, `"24h"`, `"30d"`, an integer of seconds,
  …) works.
- Secret: see "JWT secret" below.

The client treats `must_change_password: true` as a tripwire: it
shows the change-password screen until the server returns a fresh
token with the claim flipped to `false`.

---

## Storage

Users live in a SQLite database opened via `aerekos-record`. The
schema is:

```ts
db.model("User", {
  username: "string",
  password: "string",          // bcrypt hash (we never store plaintext)
  must_change_password: "boolean",
  last_login_at: "string",
}, {
  required: ["username", "password"],
  unique: ["username"],
  indexes: ["username"],
  timestamps: true,
});
```

By default the database file lives at `<dataRoot>/auth.sqlite`
(typically `./store/auth.sqlite`). Override with `AUTH_DB_PATH`. The
file is gitignored via the existing `store/` rule.

> **Why store the bcrypt hash in a `string` column instead of
> aerekos-record's `encrypted` type?** The `encrypted` type omits the
> hash from reads, which would mean we couldn't verify a password on
> login. Storing the hash in a regular `string` column gives us full
> control and uses `bcryptjs` directly for both `hash` and `compare`.

---

## JWT secret

Resolution order, first match wins:

1. **`JWT_SECRET` env var** — operator-managed. Must be ≥ 16
   characters. Use this in production / multi-host deployments where
   you want to rotate the key explicitly.
2. **`<dataRoot>/.jwt-secret` file** — auto-generated on first boot.
   The server writes a 48-byte url-safe random string with `0600`
   permissions and reuses it on subsequent boots. The path is covered
   by the existing `store/` gitignore rule.

Override the file location with `JWT_SECRET_FILE` if you keep your
data root elsewhere.

To **rotate** the secret, either change `JWT_SECRET` or delete
`.jwt-secret` and restart — every existing token will be invalidated
and clients will be kicked back to the login screen.

---

## Bootstrap admin

On first boot, if the users table is empty (or has no user with the
configured bootstrap username) the server seeds:

```text
username = AUTH_BOOTSTRAP_USERNAME (default: "admin")
password = AUTH_BOOTSTRAP_PASSWORD (default: "changeme")
must_change_password = true
```

The seed log line is intentionally loud:

```
[auth] bootstrap admin created (username='admin', password='changeme'). Change it on first sign-in.
```

If you want the very first sign-in to use a different default, set
both env vars before the first boot. Once the user exists, changing
the env vars has no effect — they're seed defaults, not live values.

---

## Forgotten password / reset

Single-user shop, so there's no email recovery flow. To reset:

```bash
# 1. Stop the server.
docker compose stop server   # or Ctrl-C the native dev process.

# 2. Wipe the auth database.
rm store/auth.sqlite store/auth.sqlite-shm store/auth.sqlite-wal

# 3. Restart — the bootstrap admin (admin/changeme) is recreated.
docker compose up -d server  # or scripts/dev-native.sh
```

If you have multiple users and only want to reset one, drop into the
sqlite file directly:

```bash
sqlite3 store/auth.sqlite \
  "UPDATE users SET password=?, must_change_password=1 WHERE username='admin';" \
  -- "$(node -e 'console.log(require("bcryptjs").hashSync("changeme", 10))')"
```

(Yes, this assumes you have a Node process handy that can `require`
`bcryptjs` — `cd server && node` works.)

---

## Environment variables

| Variable                   | Default                   | Notes                                            |
| -------------------------- | ------------------------- | ------------------------------------------------ |
| `JWT_SECRET`               | _(auto-generated)_        | ≥ 16 chars when set; overrides the file.         |
| `JWT_SECRET_FILE`          | `<dataRoot>/.jwt-secret`  | Where the auto-generated secret is persisted.    |
| `JWT_EXPIRES_IN`           | `7d`                      | Anything the `jsonwebtoken` package accepts.     |
| `AUTH_DB_PATH`             | `<dataRoot>/auth.sqlite`  | Override the SQLite file location.               |
| `AUTH_BOOTSTRAP_USERNAME`  | `admin`                   | Seed username (only used when users table empty).|
| `AUTH_BOOTSTRAP_PASSWORD`  | `changeme`                | Seed password (forces password change on use).   |
| `AUTH_BCRYPT_ROUNDS`       | `10`                      | bcrypt cost factor.                              |

---

## Client-side wiring (briefly)

- `app/src/auth.ts` is the single source of truth: token storage
  (`localStorage`), `login`/`logout`/`changePassword` helpers,
  `subscribeAuth(fn)` for auth state subscribers, and an `authFetch`
  wrapper that pins `Authorization` and clears the cached token on
  any `401`.
- `api.ts` uses `authFetch` for every request — there's no plain
  `fetch` that bypasses auth.
- `events.ts` builds the WS URL with `?token=` from the same source.
  Login/logout triggers a reconnect / disconnect.
- `App.tsx` renders `<AuthScreen />` (login or forced change-password
  variant) until a usable user is in `auth` state, then mounts the
  full UI.

A small "ACCOUNT" pill in the sidebar exposes "change pw" and "sign
out" — pressing change-pw routes back through `<AuthScreen />` in
manual (non-forced) mode so users can rotate without logging out.
