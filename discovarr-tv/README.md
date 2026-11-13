# Discovarr TV

A companion app for [Discovarr](../discovarr) that runs on Android TV: the same
product as the one in your browser — same logo, same six themes, same sign-in
card, same account, same Plex profile — laid out for a remote instead of a mouse.

It is a client only. Nothing in `discovarr/` changes, no extra service is needed,
and the app talks to the endpoints Discovarr already exposes.

## What it does

- **Discover** — the library's films, shows, books and audiobooks on shelves.
  Empty shelves are hidden, so a films-only setup looks like it did before books
  existed.
- **Search** — one field across everything, with the same filter chips the web
  offers, including the book types only when Readarr is switched on.
- **Title page** — the browser's page, ported: poster, tagline, overview, the
  fact table (release date, runtime, rating, genres, director, studio, library
  state), the cast strip, the season list, the trailer, the Plex button and the
  watchlist toggle. Facts and cast come from the same HTML the browser renders,
  because `/api/v1` does not carry them.
- **Watchlist** — the server's watchlist, newest first, savable and removable
  from the television. It is the same list the browser shows, not a second one.
- **Calendar** — a month of releases for what is in the library and what has been
  asked for, walked with the D-pad as an agenda, with previous/next month.
- **Requests** — the same list the web UI shows, with live state (waiting for
  approval, with the download client, available, failed).
- **Settings** — the account this box is paired with, the six themes, how many
  presses open a title, Plex profile switching and sign out.
- **Looks like the browser** — the Discovarr mark and gradient wordmark, and all
  six colourways from `public/styles.css` (Midnight, Cinema, Deep Teal, Enchanted
  Forest, Midnight Sapphire, Imperial Crimson), each with its own glows, accents
  and brand gradient.
- **One press to open** — a single press opens a title, the way a tap does.
  *Settings → Remote* switches to **Press twice**, where the first press only
  highlights. The choice is stored on the television.
- **Accounts and Plex profiles are the server's** — the television signs in as the
  same account the browser lists, with the same theme, quotas, requests and
  watchlist. *Switch account* asks for another account on the same server without
  retyping the address; *Change Plex profile* re-runs the household picker.
- **Play on Plex** — hands the title to the Plex app instead of a browser tab.
- **Only what is switched on** — if the Readarr integration is off, the books and
  audiobooks shelves, filter chips and copy are never drawn at all.

## Requirements

- Discovarr reachable from the TV box over the LAN, on its normal HTTP port
  (5057 by default). Cleartext HTTP is enabled on purpose, because that is how
  most people run this on an Unraid box.
- An Android TV device on **Android 6.0 (API 23) or newer**. Compose sets that
  floor, so API 21/22 boxes are out.
- For the calendar to fill in, TMDB has to be configured on the server: the month
  is built from TMDB releases narrowed to your library and requests.
- For *Play on Plex*, the Plex integration has to be configured in Discovarr and
  the title has to be in your Plex library; otherwise the button is not shown.

## Building

No third-party dependencies beyond the Kotlin and Compose runtimes: HTTP is
`HttpURLConnection`, JSON is `org.json`, posters are decoded with `BitmapFactory`,
and the few HTML pages the server renders without a JSON twin are read with small
regexes rather than an HTML parser.

You need JDK 17 (`JAVA_HOME` set), Android SDK with **platform 36** and
**build-tools 36.0.0**, and Gradle 8.14.6 or your own wrapper.

```bash
export ANDROID_HOME=/path/to/android-sdk
cd discovarr-tv
./gradlew assembleDebug          # or: gradle assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`.

## Installing on the TV box

```bash
adb connect 192.168.1.50:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

It appears on the Android TV home screen as **Discovarr**. Without ADB, put the
APK on a USB stick and open it with a file manager, or serve it locally.

On first launch the app asks for the address of the Discovarr container, for
example `192.168.1.10:5057`. *Connect* probes `/api/v1/health`, so a wrong address
is reported as "nothing is listening there" rather than as a bad password.

## Signing in with Plex

Plex authorises a device with a four-character code, and the television does that
itself: it shows the code on screen and waits while you enter it once at
**plex.tv/link** on a phone or laptop that is already signed in to Plex. No Plex
password is typed with the remote and no browser page opens on the TV.

The code is the television's own pin, and that detail matters. `/auth/plex` asks
plex.tv for a *strong* pin, which is the right thing for a browser — the code
rides inside a URL there — but plex.tv issues twenty-five characters for those
and plex.tv/link has a four-character field. So the app takes from the server only
the pin cookie its callback needs, asks plex.tv for a plain pin of its own, and
shows that. When the code is confirmed it hands the account token to
`/auth/plex/callback?authToken=` — the same parameter Plex appends when it
forwards a browser back — and the server starts the session as it always does.

It also asks plex.tv *as the server*: the client id comes out of the auth URL the
server just redirected to, and it is the id the token is then bound to. That
matters, because the server reads the account's profiles back with its own
identity, and a pin requested under the television's own id was confirmed at
plex.tv and then answered `401` there — the "account linked, app still waiting"
dead end. Using the server's id makes the token indistinguishable from the one a
browser gets, which is the only flow the server has ever been tested against.

When Plex confirms, the household's profile picker appears inside the app —
including each profile's PIN — and picking one lands the Discovarr session the
browser would have got. The endpoints are the server's own (`/auth/plex`,
`/auth/plex/callback`, `/auth/plex/profile`), so the two can never disagree about
who signed in.

## Design notes

- **Focus is the whole interaction.** Every control is a focusable surface with a
  visible border and a small scale-up when it holds focus. Rows scroll with the
  D-pad automatically.
- **One press, one open.** `Modifier.clickable` handles the D-pad itself, but a
  remote delivers a press as a key-down, often a repeat, and the click that
  follows — so a surface could see two activations for one press. Keys are handled
  explicitly here with a debounce, which is what makes "single press" true.
- **The design is ported, not approximated.** Colours, radii, the mark and the
  auth-card composition come from `public/styles.css`, `views.js` and `pages.js`.
  Only the scale changes: a browser is read at arm's length.
- **Themes follow the account.** The server paints `data-theme` into every page
  and saves the choice via `/account/theme`; the app reads the same attribute and
  posts to the same route, so a theme chosen in the browser is already painted
  when the television opens, and the other way round.
- **Plex links use Plex's router.** `plex://server/<machine>/details?...` launches
  Plex and leaves it on its home screen — the scheme is accepted, the path is not.
  The app sends `plex://preplay/?metadataKey=<key>&metadataType=<type>&server=<machine>`
  instead, which names the item rather than a path, and falls back to
  `plex://play/`. Without `metadataType` Plex cannot tell a film from a series and
  bounces home again.
- **Nothing is fired at a link no app claims.** Every candidate is resolved with
  the package manager first, because an unresolvable intent is answered by the
  launcher with "You don't have an app that can do this" — the toast that used to
  appear on top of the title page. If no build of Plex here accepts the link, the
  app opens Plex at its home screen and says so, rather than pretending it landed.
- **The rail folds instead of disappearing.** It holds its labels while it has
  focus and folds down to icons while you are reading a page, then opens again the
  moment focus returns to it. Left at the edge of any page walks back to the
  rail, because a viewer should not have to leave a title to reach the menu.
- **No image library.** Posters come from the public `/img/<size>/<file>` route
  and Open Library URLs; a small LRU keeps a screen's worth of art in memory.
- **Books are a setting, not a guess.** `/api/v1/settings` reports
  `services.readarr.enabled`, so an administrator's app knows immediately. A
  non-administrator cannot read settings and needs no special case: if the server
  holds no books and no audiobooks, there is nothing to show either way.
- **Pages without an API are read, not guessed.** The watchlist is a form post and
  the calendar is a month grid, so the television reads the markup the browser
  would have shown. That keeps one source of truth, at the cost of depending on
  that markup — worth knowing before changing `pages.js`.

## Limitations

- No built-in player. Playback is handed to the Plex app, and only when Discovarr
  knows Plex holds the title.
- Artwork comes from TMDB, so a title it has no poster for shows its initials on a
  coloured tile. The browser does the same; the next sync that finds art fills it
  in.
- Season selection is not implemented: requesting a series requests every season,
  the web UI's default. Single seasons need the browser.
- Activity, notifications and the settings pages that need `MANAGE_SETTINGS` are
  not on the television; only the account's own settings are.
- Requests can be filed and followed but not approved or declined from the TV.
- No in-app update channel. Rebuild and `adb install -r` again.
