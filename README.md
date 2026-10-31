# Discovarr

A media request and discovery manager for a self-hosted library, packaged as a
Docker image. Users browse a catalog, request movies or individual seasons, and
requests flow to Radarr/Sonarr for download. Statuses reconcile back from those
services on a schedule.

It is a self-contained implementation inspired by the domain model of
[Seerr](https://github.com/seerr-team/seerr): the same `media` / `request` /
`season` entities, the same numeric lifecycle statuses, and a similar
`/api/v1/...` API surface. No Seerr code is vendored.

## Stack

- Node.js 24, ES modules, **zero runtime dependencies**
- SQLite through Node's built-in `node:sqlite`
- Server-rendered HTML, no client bundle
- Docker image on `node:24-alpine`; the entrypoint drops to `PUID:PGID`
  (`99:100`, Unraid `nobody:users`) after preparing `/data`

## Quick start

```bash
# then open http://localhost:5057 and create the administrator
docker compose up --build
```

```bash
# plain Docker
docker build -t discovarr .
docker run --rm -p 5057:5057 -v discovarr-data:/data discovarr
```

```bash
# without Docker
npm start          # http://localhost:5057, database in ./data
npm test           # end-to-end HTTP tests
```

## Pulling the published image (private)

Pushing a `v*` tag, or running the **Publish image** workflow by hand, builds and
pushes `ghcr.io/daprkid/discovarr` to the GitHub Container Registry. The package
inherits this repository's visibility, so it is **private**: an anonymous
`docker pull` is refused, and the image is only usable by accounts you grant
access to. Publishing uses the workflow's own `GITHUB_TOKEN`, so no personal
token is needed for that side.

```bash
# once, on the machine that runs the container; classic PAT with read:packages
echo "<token>" | docker login ghcr.io -u DaPrKid --password-stdin

docker pull ghcr.io/daprkid/discovarr:0.14.0
```

Tags are the bare version (`0.3.0`), `latest` for tagged releases, and
`sha-<commit>`. The login is stored for the Docker daemon, so Unraid's Docker
page and its update checks use it too once the credential exists.

### First run

The image ships no accounts. On first start every page redirects to `/setup`,
where you create the administrator with an **email, username and password** —
the first account is always the admin. Sign in afterwards with the username (or
the email) and that password.

If you would rather have the account created at boot, set `ADMIN_PASSWORD` (plus
optionally `ADMIN_EMAIL` and `ADMIN_USERNAME`) and the administrator is seeded
into the empty database instead; `/setup` then redirects to `/login`.
`SEED_DEMO_USER=true` additionally seeds `sam@discovarr.local` / `sam` while
bootstrapping, which is only useful for demos.

## Features

- **Discover** — TMDB trending and multi-search once an API key is set, with a
  cached local image proxy (`/img/<size>/<file>`). Without a key the app runs on
  a seeded offline catalog instead of failing.
- **Title pages** — every card opens a page with the release date, rating,
  genres, runtime (or season and episode counts), description, top cast, and
  streaming, rental and purchase options for the configured region (JustWatch
  data via TMDB). Titles nobody has requested yet get a page too.
- **Settings tabs** — Integrations, Users, Notifications, Logs and Tasks, so the
  page stays readable as features grow. Signing in always opens Discover.
- **Browse** — a sidebar on Discover for Networks, Studios, Movie Genres, Series
  Genres and Recommendations (seeded by the titles you actually request).
- **Search that answers while you type** — Discover suggests matches with
  posters, year and availability as you type, keyboard-navigable, and the plain
  search form still submits when JavaScript is off.
- **A denser Discover grid with pages** — a full poster wall per screen and
  Previous/Next paging over trending titles and search results.
- **Networks and studios** — all 31 networks and 18 studios are toggles in the
  right-hand panel, so their pages open straight onto titles instead of a wall
  of logos.
- **A filter panel on every browse page** — the right-hand rail toggles genres,
  studios and networks, then narrows further by year, minimum rating, vote
  count, original language and sort order. It applies as soon as a toggle
  changes and still works as a plain GET form without JavaScript.
- **Type switches** — Anime, Animation, Documentary, Reality, Kids and Talk show
  sit beside the genres. Anime is matched through its TMDB keyword, so it stays
  distinct from Animation.
- **Title pages with atmosphere** — a blurred still of the title itself tints the
  page background, and a cast member TMDB has no headshot for borrows a still
  from one of their own titles.
- **Series, season by season** — every season opens to its episodes with their
  descriptions and air dates, and a request covers all seasons or only the ones
  you tick.
- **Collections on the side** — a film that belongs to a series of films shows
  the rest of them beside the page, with a tick box per film and a select-all.
- **No duplicate requests** — a title already requested in Discovarr, or already
  sitting in Radarr or Sonarr, shows a disabled "Already requested" button.
- **Watchlist** — save any title for later from its page, whether or not it is
  in the catalog yet, then work through it from the Watchlist tab.
- **Release calendar** — the next 45 days of film and series releases, grouped
  by date, each with the same one-click request as the browse pages.
- **Collection pages** — a film's collection opens as its own page listing every
  part, which are already in your library and which are still missing, with a
  tick box per film and one button for the rest.
- **Trailers** — a title page links to its YouTube trailer when TMDB has one.
- **API tokens** — create a named token in Account and call `/api/v1/…` with
  `Authorization: Bearer <token>`. The token is shown once, stored only as a
  SHA-256 hash, records its last use, and can be revoked without touching your
  password or sessions.
- **Person pages** — every name in a title's cast opens that person's biography,
  dates and the full list of films and series they appear in.
- **Genre shelves** — the genre pages lead with titles from the busiest
  categories instead of a bare list of names.
- **Requests** — movies or individual seasons, duplicate and already-available
  protection, pagination and status filters.
- **Artwork cache with limits** — posters and backdrops are cached on disk, and
  the cache is pruned on a schedule against a size and an age limit (500 MB and
  60 days by default), least recently used first. A **Prune cache** button in
  Settings → Tasks applies the limits immediately.
- **Settings backup** — every setting downloads as one JSON file, secrets
  blanked unless you ask for them, and pastes back in on another machine. Only
  known keys are written, and a blank secret in the file never clears a key you
  already have.
- **Diagnostics** — Settings → Tasks reports the database and write-ahead log
  size, artwork cache size, title, user and session counts, request counts by
  status, how each service is configured (never its credentials), and the last
  sync.
- **Sync that backs off** — a failing Radarr or Sonarr is retried after two
  minutes, then four, eight, and so on up to half an hour, with the error and
  the next attempt surfaced in Settings → Tasks instead of only in the log.
- **Approval workflow** — `pending → approved → completed`, or `declined` /
  `failed`. Media and season statuses track `requested`, `processing`,
  `partly available`, `available`.
- **Named profiles** — each Radarr/Sonarr profile pairs a name with a quality
  profile and a root folder, so "4K Movies" and "Kids" can point at different
  libraries. Profiles sit as bubbles inside the Radarr/Sonarr panel, each with
  an edit and a delete button; one is the default and requesters pick another
  per title. Approval dispatches with the chosen profile's quality and folder.
- **Plex** — point it at your Plex server and every card Plex can play is marked
  *Plex* with a **Play on Plex** button that opens the item in Plex Web. This
  checks the actual library, so a download that *arr reports but Plex lacks is
  not advertised as watchable.
- **Dispatch on approval** — approving adds the title to Radarr/Sonarr. Failures
  mark the request `failed` with the service's error, and can be retried.
- **Library sync** — every N minutes (default 30) the app reads the Radarr/Sonarr
  library, updates media and season statuses, imports titles it did not know
  about, and completes requests whose content arrived. Also runnable on demand.
- **Quotas** — per-user monthly limits for movies and series, plus a granular
  permission bitmask (request movies/series, auto-approve, manage requests,
  manage users, manage settings).
- **Notifications** — webhook (Discord-compatible `content`, plus structured
  fields) for new requests, approvals/declines and titles becoming available,
  and now email over SMTP too: STARTTLS, implicit TLS or a plain relay on the
  same host, with a **Send me a test message** button in Settings.
- **A bell in the header** — approvals, declines, titles becoming available and
  a dispatch that finally gives up all land in `/notifications`, with an unread
  count and a *mark all read* button.
- **Per-user notification choices** — each account decides whether email is
  wanted and which events matter (approved, declined, available); the bell
  always shows the account's own updates.
- **Bulk request management** — tick requests on the Requests page and approve,
  retry, decline or delete them in one post, with the outcome reported per
  request instead of failing the batch.
- **Background retries** — a failed dispatch is retried automatically after two
  minutes, four, eight and so on, up to a configured number of attempts, and
  only then is the requester told it failed.
- **Accounts** — first-run `/setup` page where the first account becomes the
  administrator, sign-in by username or email, self-service password change
  that revokes other sessions.
- **Audit log** — requests, approvals, dispatch failures, user and settings
  changes, sync runs, all visible on the settings page.
- **Security** — scrypt password hashes, server-side sessions, HttpOnly cookies,
  cross-site mutation blocking, login rate limiting.

### Radarr and Sonarr

Enter the base URL and API key, then press **Save and test connection**. That
saves the settings, checks the service and, in the same click, pulls its root
folders and quality profiles. The first folder and profile are stored as the
default profile when the service has none yet.

Profiles are bubbles inside the Radarr and Sonarr panels: the service icon, the
name, its quality profile and root folder, and two buttons — the pencil edits the
bubble, the bin deletes it. **+ Add profile** opens a dialog with a name, the
quality profile to use, the root folder, and a *make this the default* checkbox;
the edit dialog is the same form, pre-filled, and can promote a profile to
default. The last profile cannot be deleted.

When more than one profile exists the title page shows a profile select, and the
choice is stored on the request, so approval dispatches with that profile's
quality profile and root folder. Requests without a pick use the default.
Settings saved before profiles existed are read as a single default profile, so
nothing needs re-entering after an upgrade.

### Plex

Enter the Plex URL (`http://192.168.1.20:32400`), the token and press **Save and
test connection**. The token is the `X-Plex-Token` value in any item's
`Get Info → View XML` link in Plex Web. Matching is by TMDB id, so it works with
either the new Plex agent or the legacy one, and the deep link opens
`app.plex.tv` on the right server and item.

## Running as a specific user (Unraid, LinuxServer-style)

The container starts as root, fixes ownership of `/data`, then runs the app as
`PUID:PGID` — `99:100` by default, so a standard Unraid appdata share works
without manual `chown`:

```bash
docker run -d --name discovarr -p 5060:5057 \
  -e PUID=99 -e PGID=100 \
  -v /mnt/user/appdata/discovarr:/data \
  --restart unless-stopped ghcr.io/daprkid/discovarr:0.14.0
```

If you prefer to run the process without root at all, start the container with
`--user 99:100` yourself and the entrypoint skips the privilege drop. Files are
created with `umask 002` so the group can write them.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5057` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATABASE_FILE` | `./data/discovarr.db` | SQLite file (image: `/data/discovarr.db`) |
| `IMAGE_CACHE_DIR` | `<database dir>/images` | TMDB artwork cache |
| `ADMIN_PASSWORD` | unset | Bootstrap only: create the first administrator at boot instead of using `/setup` |
| `ADMIN_EMAIL` | `admin@discovarr.local` | Bootstrap admin email (used with `ADMIN_PASSWORD`) |
| `ADMIN_USERNAME` | `admin` | Bootstrap admin username (used with `ADMIN_PASSWORD`) |
| `SEED_DEMO_USER` | `false` | Bootstrap only: also seed the demo user `sam@discovarr.local` |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `COOKIE_SECURE` | `false` | Force the `Secure` cookie flag (auto behind `x-forwarded-proto: https`) |
| `COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`; `none` needs HTTPS and suits embedded previews |
| `LOGIN_RATE_LIMIT` | `8` | Failed logins allowed per window |
| `LOGIN_RATE_WINDOW_MINUTES` | `15` | Rate-limit window |
| `PUID` | `99` | UID the app runs as inside the container (Unraid `nobody`) |
| `PGID` | `100` | GID the app runs as (Unraid `users`) |
| `TMDB_API_KEY` | unset | Fallback when no key is saved in settings |
| `DEMO_AUTO_LOGIN` | unset | Preview only: sign every request in as this email. Never set publicly. |

Everything else (TMDB key, Sonarr/Radarr URLs, keys, root folders, quality
profiles, sync interval, webhooks, app name, auto-approve) lives in the database
and is edited on the Settings page.

## API

Session cookie from `POST /api/v1/auth/login`, or a personal token from
Account → API tokens sent as `Authorization: Bearer <token>`; `filter`/`page`/`take` where
relevant. Admin-only endpoints require the matching permission.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness, version, TMDB state, last sync |
| `POST` | `/auth/login` · `/auth/logout` | `{ username, password }` — the username or the email |
| `GET` | `/auth/me` | Current user |
| `POST` | `/auth/password` | `{ currentPassword, newPassword }` |
| `GET` | `/search?query=&type=` | TMDB search |
| `GET` | `/media?type=&q=` | Local catalog |
| `GET` | `/media/:id` | Title, seasons, requests |
| `PATCH` | `/media/:id` | `{ status: 5 }` marks available |
| `GET` | `/request?filter=&page=&take=` | Admin sees all |
| `POST` | `/request` | `{ mediaId }`, `{ mediaType, tmdbId }`, optional `seasons`, `qualityProfileId` or `profileIndex` |
| `POST` | `/request/:id/approve` | Approves and dispatches |
| `POST` | `/request/:id/decline` | |
| `POST` | `/request/:id/retry` | Re-dispatch a failed request |
| `DELETE` | `/request/:id` | Owner or manager |
| `POST` | `/sync` | Run a library sync now |
| `GET`/`PATCH` | `/users`, `/users/:id` | Roles, permissions, quotas |
| `GET`/`PUT` | `/settings` | Admin |
| `GET` | `/services/:kind/options` | Root folders and quality profiles |

## Layout

```
discovarr/
├── Dockerfile            # node:24-alpine, non-root, healthcheck, /data volume
├── docker-compose.yml
├── docker/entrypoint.sh  # chowns /data, then drops to PUID:PGID
├── public/styles.css
├── tests/lifecycle.test.js
├── tests/services.test.js   # *arr client and profile dispatch against a fake service
├── tests/setup.test.js
└── src/
    ├── server.js         # bootstrap, static files, /img proxy, error pages
    ├── pages.js          # server-rendered routes
    ├── api.js            # /api/v1
    ├── core.js           # lifecycle, quotas, permissions, dispatch, audit
    ├── sync.js           # library reconciliation + scheduler
    ├── services.js       # Radarr/Sonarr client
    ├── plex.js           # Plex library check and deep links
    ├── tmdb.js           # metadata client
    ├── images.js         # cached artwork proxy
    ├── notifications.js  # webhooks
    ├── ratelimit.js      # login throttling
    ├── db.js             # schema, migrations, seed, SQL access
    ├── auth.js           # sessions, permissions
    ├── http.js           # router, body parsing, same-origin guard
    ├── views.js          # HTML components
    ├── constants.js      # statuses, permissions, settings defaults
    ├── passwords.js      # scrypt hashing
    └── config.js         # environment configuration
```

`cache.js` (artwork cache limits), `diagnostics.js` (the Tasks tab snapshot),
`mail.js` (a small SMTP client), `retry.js` (background dispatch retries) and
`settingsfile.js` (settings export and import) carry the maintenance and
notification work.

## Tests

`npm test` boots the real server on a free port against a temporary database and
exercises login, permissions, quotas, request/approval/dispatch, retry,
pagination, password change, CSRF rejection and the image proxy guard. The
services suite runs a stand-in Radarr that rejects a wrong API key and records
the POST it receives, which covers connection testing, folder and profile
loading, named profiles (adding, editing and dispatching with a non-default one),
the tabbed settings page and sign-in landing on Discover. A stand-in Plex
provides an identity, two libraries and one item, which covers the availability
badge, the play deep link and the browse sidebar.

## Limitations

- Single container, single writer: SQLite in WAL mode, no external database.
- Notification email is plain text from one SMTP account; there is no per-user
  mail server or mailing-list management.
- Dispatch assumes Radarr/Sonarr v3 APIs; failures surface verbatim in the note.
- The seeded catalog is demo data, used only when TMDB is not configured.
