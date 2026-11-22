import { saveServiceSelection } from './core.js'
import {
  MIN_PASSWORD_LENGTH,
  PERMISSION_LABELS,
  Permission,
  Role,
  TokenScope,
} from './constants.js'
import { cacheStats } from './cache.js'
import * as store from './db.js'
import { diagnosticsSnapshot } from './diagnostics.js'
import { plexSettings } from './plex.js'
import { loadServiceOptions, serviceProfiles, serviceSummary } from './services.js'
import { syncState } from './sync.js'
import { tmdbApiKey } from './tmdb.js'
import { alert, escapeHtml, formatBytes, formatDuration, themeSelect } from './views.js'


// The settings, users, tokens and tasks pages. They were the densest part of
// pages.js and share almost nothing with the browse pages, so they live here
// now; pages.js keeps the routes and imports these bodies.

export const SETTINGS_TABS = Object.freeze([
  ['general', 'General'],
  ['integrations', 'Integrations'],
  ['users', 'Users'],
  ['notifications', 'Notifications'],
  ['tokens', 'API tokens'],
  ['tasks', 'Tasks'],
  ['logs', 'Logs'],
])

const WATCH_REGIONS = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['IE', 'Ireland'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['DK', 'Denmark'],
  ['NO', 'Norway'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['BR', 'Brazil'],
  ['IN', 'India'],
  ['JP', 'Japan'],
]

/**
 * The push card, shared by the settings notifications tab and the account page.
 * Push cannot be turned on from a plain form - the browser only prompts from a
 * click inside a script - so the card carries buttons and a status line and the
 * page script does the rest.
 */
export function pushCard(user, devices = []) {
  const labels = devices.length
    ? `<span class="push-devices">${devices.map((device) => escapeHtml(device.label || 'This device')).join(' \u00b7 ')}</span>`
    : '<span class="push-devices">No device is set up yet.</span>'

  return `<section class="panel push-card" data-push-card>
      <h2 style="margin: 0">Push notifications</h2>
      <p class="muted small">Get a notification on this device when a request is approved, declined or arrives, even with the app closed. It follows the events you ticked above.</p>
      <p class="muted small">Devices on your account: ${labels}</p>
      <div class="row">
        <button class="btn btn-sm" type="button" data-push-enable>Turn on for this device</button>
        <button class="btn btn-sm btn-ghost" type="button" data-push-disable hidden>Turn off for this device</button>
        <button class="btn btn-sm btn-ghost" type="button" data-push-test hidden>Send a test</button>
      </div>
      <p class="muted small" data-push-status>Push needs an HTTPS address; on an iPhone, add the app to the home screen first.</p>
    </section>`
}

function settingsTabs(tab) {
  // Seven sections as a row of links is a wall of words on a phone. The phone
  // and tablet shell gets a picker instead: a real GET form, so it still works
  // with JavaScript off, with the button only there when nothing else can submit.
  return `<nav class="tabs settings-tabs">
    ${SETTINGS_TABS.map(
      ([key, label]) => `<a class="tab ${tab === key ? 'is-active' : ''}" href="/settings?tab=${key}">${label}</a>`
    ).join('')}
  </nav>
  <form class="settings-picker" method="get" action="/settings">
    <label for="settings-section">Section</label>
    <select id="settings-section" name="tab" data-settings-picker>
      ${SETTINGS_TABS.map(
        ([key, label]) => `<option value="${escapeHtml(key)}"${tab === key ? ' selected' : ''}>${escapeHtml(label)}</option>`
      ).join('')}
    </select>
    <noscript><button class="btn btn-sm" type="submit">Show</button></noscript>
  </form>`
}

export function tokensPanel({ tokens, newToken, newTokenScope = null }) {
  return `<section class="panel">
      <h2 style="margin: 0">Your API tokens</h2>
      <p class="muted small">For scripts and home automation: send <code>Authorization: Bearer &lt;token&gt;</code> to <code>/api/v1/…</code>. A token acts as your account, so treat it like a password.</p>
      ${
        newToken && newTokenScope !== TokenScope.CALENDAR
          ? `<p class="alert alert-ok">New token, shown once: <code>${escapeHtml(newToken)}</code></p>`
          : ''
      }
      ${
        newToken && newTokenScope === TokenScope.CALENDAR
          ? `<p class="alert alert-ok">New calendar link, shown once: <code>${escapeHtml(
              `/calendar.ics?token=${newToken}`
            )}</code></p>
             <p class="muted small">This token can only read the feed, so a link that leaks into a log or a shared phone does not hand out your account.</p>`
          : ''
      }
      ${
        tokens.length
          ? `<table class="table">
              <thead><tr><th>Name</th><th>Kind</th><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>${tokens
                .map(
                  (token) => `<tr>
                    <td data-label="Name">${escapeHtml(token.name)}</td>
                    <td data-label="Kind">${token.scope === TokenScope.CALENDAR ? 'Calendar' : 'API'}</td>
                    <td data-label="Token"><code>${escapeHtml(token.prefix)}…</code></td>
                    <td data-label="Created">${escapeHtml(token.createdAt.slice(0, 10))}</td>
                    <td data-label="Last used">${token.lastUsedAt ? escapeHtml(token.lastUsedAt.slice(0, 16).replace('T', ' ')) : 'never'}</td>
                    <td><form method="post" action="/settings/tokens/${token.id}/delete"><button class="btn btn-sm btn-danger" type="submit">Revoke</button></form></td>
                  </tr>`
                )
                .join('')}</tbody>
            </table>`
          : '<p class="muted small">No tokens yet.</p>'
      }
      <form method="post" action="/settings/tokens" class="row">
        <label>Name <input type="text" name="name" maxlength="60" placeholder="Home Assistant" /></label>
        <button class="btn btn-sm" type="submit">Create token</button>
      </form>
      <form method="post" action="/settings/tokens" class="row">
        <input type="hidden" name="scope" value="${TokenScope.CALENDAR}" />
        <div>
          <button class="btn btn-sm btn-ghost" type="submit">Create calendar link</button>
          <p class="muted small">A read-only feed for a phone or calendar app. It works only on <code>/calendar.ics</code>, so treat the link as a subscription, never as a password.</p>
        </div>
      </form>
    </section>`
}

function regionOptions(current) {
  const value = String(current || 'US').toUpperCase()
  const known = WATCH_REGIONS.some(([code]) => code === value)
  return `${known ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`}${WATCH_REGIONS.map(
    ([code, name]) => `<option value="${code}" ${code === value ? 'selected' : ''}>${escapeHtml(name)}</option>`
  ).join('')}`
}

// The real Radarr and Sonarr marks, inlined so they render offline and stay
// crisp at 20px. Radarr's dark strokes take the panel colour, its arrow keeps
// the brand yellow.
const SERVICE_ICONS = Object.freeze({
  radarr:
    '<svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true"><g transform="translate(70 21)"><path fill="currentColor" d="m10.3 59.8 3.9 372.4c-31.4 3.9-54.9-11.8-54.9-43.1l-3.9-309.7c0-98 90.2-121.5 145.1-82.3l278.3 160.7c39.2 27.4 47 78.4 27.4 113.7-3.9-27.4-15.7-43.1-39.2-58.8L53.4 36.2C29.9 20.6 10.3 24.5 10.3 59.8"/><path fill="currentColor" d="M-13.2 451.8c23.5 7.8 47 3.9 66.6-7.8l321.5-188.2c19.6 27.4 15.7 54.9-7.8 70.6L96.5 483.2c-39.2 19.6-90.1 0-109.7-31.4"/><path fill="#ffc230" d="M80.9 342 273 232.3 84.8 126.4z"/></g></svg>',
  sonarr:
    '<svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true"><path fill="#eee" d="M511.8 256c0 70.4-24.9 130.8-74.6 181.1-1.7 2-3.5 3.8-5.5 5.4-8.2 8-16.8 15.3-26 21.8Q341.05 512 256.3 512c-56.6 0-106.3-15.9-149.2-47.7-11.3-8-22-17.1-31.9-27.3C36.5 398.7 12.8 354 4 303.2c-1.7-9.9-2.9-20-3.4-30.2-.2-5.7-.4-11.3-.4-17 0-6 .1-11.7.4-17.1 0-.6.2-1.1.5-1.7 3.7-62.8 28.4-117 74.1-162.8C125.5 24.8 185.8 0 256.2 0c70.7 0 131 24.8 180.9 74.5q74.7 75.9 74.7 181.5"/><path fill="#3a3f51" d="m459.7 100.3-52.9 52.9c-30.9 30.9-33.6 57.8-33.6 105.3 0 42.3 6.7 81.1 38.2 112.6 23 23 44.9 44.7 44.9 44.7-5.9 7.2-12.3 14.3-19.1 21.2-1.7 2-3.5 3.8-5.5 5.4-6 5.9-12.2 11.4-18.6 16.4l-41.4-41.4C334.9 380.6 305.6 377 257 377c-46.7 0-78.4 4.3-112.6 38.5-20.4 20.4-43.8 43.9-43.8 43.9-8.9-6.8-17.3-14.2-25.3-22.4-6.6-6.6-12.8-13.4-18.5-20.3 0 0 23.1-23.2 45.2-45.3 32.7-32.7 38-70.6 38-113 0-41.3-6.8-79.8-36.8-109.9C82.2 127.7 53.3 99 53.3 99c6.7-8.5 14-16.7 21.8-24.5 6.9-6.8 14-13.1 21.2-19l48 48c30.7 30.7 70 38.6 112.4 38.6 43.6 0 82.8-8.4 114.7-40.4C391 82.1 417 56.3 417 56.3c6.8 5.6 13.5 11.6 20.1 18.2 8.3 8.3 15.8 16.9 22.6 25.8"/><path fill="#0cf" d="M186 269.1c-.5-2.8-.8-5.5-.9-8.4-.1-1.6-.1-3.1-.1-4.7 0-1.7 0-3.2.1-4.7 0-.2 0-.3.1-.5 1-17.4 7.9-32.4 20.5-45.1 13.9-13.8 30.6-20.7 50.2-20.7s36.3 6.9 50.2 20.7c13.8 14 20.7 30.8 20.7 50.3s-6.9 36.2-20.7 50.2c-.5.5-1 1.1-1.5 1.5q-3.45 3.3-7.2 6-18 13.2-41.4 13.2c-23.4 0-29.4-4.4-41.3-13.2-3.1-2.2-6.1-4.7-8.9-7.6-10.8-10.6-17.3-22.9-19.8-37"/></svg>',
})

function serviceIcon(kind) {
  return SERVICE_ICONS[kind] ?? SERVICE_ICONS.radarr
}

/** One saved profile as a bubble: service icon, name and edit/delete buttons. */
function profileBubble(kind, profile, index, total) {
  const name = escapeHtml(profile.name)
  const icon = serviceIcon(kind)

  return `<div class="profile-bubble${profile.isDefault ? ' is-default' : ''} profile-bubble-${kind}">
    <span class="bubble-icon bubble-icon-${kind}" aria-hidden="true">${icon}</span>
    <span class="bubble-text">
      <span class="bubble-name"><strong>${name}</strong>${
        profile.isDefault ? ' <span class="badge badge-approved">default</span>' : ''
      }</span>
      <span class="muted small">${escapeHtml(profile.profileName)} · <code>${escapeHtml(
        profile.rootFolder || '—'
      )}</code></span>
    </span>
    <span class="bubble-actions">
      <button class="icon-btn" type="button" data-dialog-open="profile-${kind}-${index}" title="Edit ${name}" aria-label="Edit ${name}">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M4 20h4l10-10-4-4L4 16v4Zm12.7-12.7 2-2a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-2 2 4 4Z"/></svg>
      </button>
      <form method="post" action="/settings/profiles/${kind}/delete">
        <input type="hidden" name="name" value="${name}" />
        <button class="icon-btn icon-btn-danger" type="submit" title="Delete ${name}" aria-label="Delete ${name}" ${
          total <= 1 ? 'disabled' : ''
        }>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"/></svg>
        </button>
      </form>
    </span>
  </div>`
}

/** The add dialog (profile = null) or the edit dialog for one saved profile. */
function profileDialog(kind, label, options, profile = null, index = null) {
  const list = options?.[kind] ?? null
  const editing = Boolean(profile)
  const id = editing ? `profile-${kind}-${index}` : `profile-${kind}`
  const selectedId = profile?.profileId ?? null

  const qualityField = list?.qualityProfiles?.length
    ? `<label>Quality profile
        <select name="profileSelect" required>
          ${list.qualityProfiles
            .map(
              (entry) =>
                `<option value="${entry.id}|${escapeHtml(entry.name)}"${
                  String(entry.id) === String(selectedId) ? ' selected' : ''
                }>${escapeHtml(entry.name)}</option>`
            )
            .join('')}
        </select>
      </label>`
    : `<label>Quality profile
        <input type="text" name="profileSelect" required value="${escapeHtml(
          profile ? `${profile.profileId}|${profile.profileName}` : ''
        )}" placeholder="4|HD-1080p" />
        <span class="muted small">Format: id|name — load folders and profiles first for a list.</span>
      </label>`

  const rootField = list?.rootFolders?.length
    ? `<label>Root folder
        <select name="rootFolder" required>
          ${list.rootFolders
            .map(
              (folder) =>
                `<option value="${escapeHtml(folder.path)}"${
                  folder.path === profile?.rootFolder ? ' selected' : ''
                }>${escapeHtml(folder.path)}</option>`
            )
            .join('')}
          ${
            profile?.rootFolder && !list.rootFolders.some((folder) => folder.path === profile.rootFolder)
              ? `<option value="${escapeHtml(profile.rootFolder)}" selected>${escapeHtml(profile.rootFolder)}</option>`
              : ''
          }
        </select>
      </label>`
    : `<label>Root folder
        <input type="text" name="rootFolder" required value="${escapeHtml(profile?.rootFolder ?? '')}" placeholder="/media/movies" />
      </label>`

  return `<dialog class="dialog" id="${id}">
    <form method="post" action="/settings/profiles/${kind}/${editing ? 'edit' : 'add'}" class="stack">
      <h2 style="margin: 0">${editing ? `Edit ${escapeHtml(profile.name)}` : `Add a ${label} profile`}</h2>
      <p class="muted small">${
        editing
          ? 'Change the name, quality profile or root folder. Requests already sent keep the profile they were filed with.'
          : `The name is what requesters see. The quality profile and root folder are what ${label} uses for that choice.`
      }</p>
      ${
        editing
          ? `<input type="hidden" name="originalName" value="${escapeHtml(profile.name)}" />`
          : ''
      }
      <label>Profile name <input type="text" name="name" required maxlength="60" value="${escapeHtml(
        profile?.name ?? ''
      )}" placeholder="4K Movies" /></label>
      ${qualityField}
      ${rootField}
      ${
        profile?.isDefault
          ? '<p class="muted small">This is the default profile. Pick another one to make it the default instead.</p>'
          : `<label class="checkbox"><input type="checkbox" name="makeDefault" /> <span>Make this the default profile</span></label>`
      }
      <div class="request-actions">
        <button class="btn" type="submit">${editing ? 'Save profile' : 'Add profile'}</button>
        <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
      </div>
    </form>
  </dialog>`
}

function profileStrip(kind, label, options) {
  const profiles = serviceProfiles(kind)

  return `<div class="profiles">
    <div class="panel-head">
      <h3>${label} profiles</h3>
      <button class="btn btn-sm btn-ghost" type="button" data-dialog-open="profile-${kind}">+ Add profile</button>
    </div>
    <p class="muted small">Each bubble is a quality profile and root folder. Requesters choose one, and approval dispatches with it.</p>
    <div class="profile-bubbles">
      ${
        profiles.length
          ? profiles.map((profile, index) => profileBubble(kind, profile, index, profiles.length)).join('')
          : '<p class="empty small">No profiles yet — add one so requests know which quality and folder to use.</p>'
      }
    </div>
    ${profiles.map((profile, index) => profileDialog(kind, label, options, profile, index)).join('')}
    ${profileDialog(kind, label, options)}
  </div>`
}

/** One service: its connection form and its profile bubbles, side by side. */
function servicePanel(kind, label, settings, options) {
  const service = serviceSummary(kind)

  return `<section class="panel service-panel">
    <div class="service-head">
      <span class="service-icon service-icon-${kind}">${serviceIcon(kind)}</span>
      <h2>${label}</h2>
      <span class="badge badge-${service.enabled ? 'approved' : 'pending'}">${service.enabled ? 'enabled' : 'disabled'}</span>
    </div>
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="integrations" />
      <input type="hidden" name="settingsTab" value="integrations" />
      <input type="hidden" name="${kind}EnabledSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="${kind}Enabled" ${service.enabled ? 'checked' : ''} />
        <span>Enable ${label} integration</span>
      </label>
      <label>Base URL
        <input type="url" name="${kind}Url" value="${escapeHtml(
          settings[`services.${kind}.url`]
        )}" placeholder="http://192.168.1.20:8989" />
      </label>
      <label>API key
        <input type="password" name="${kind}ApiKey" value="${escapeHtml(
          settings[`services.${kind}.apiKey`]
        )}" autocomplete="off" />
      </label>
      <div class="request-actions">
        <button class="btn btn-sm" type="submit">Save</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/options/${kind}">Load folders and profiles</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/${kind}">Save and test connection</button>
      </div>
    </form>
    ${profileStrip(kind, label, options)}
  </section>`
}

function plexPanel(settings) {
  const plex = plexSettings()

  return `<fieldset class="panel">
    <legend>Plex <span class="badge badge-${plex.enabled ? 'approved' : 'pending'}">${
      plex.enabled ? 'enabled' : 'disabled'
    }</span></legend>
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="integrations" />
      <input type="hidden" name="settingsTab" value="integrations" />
      <input type="hidden" name="plexEnabledSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexEnabled" ${plex.enabled ? 'checked' : ''} />
        <span>Enable Plex integration</span>
      </label>
      <label>Plex URL
        <input type="url" name="plexUrl" value="${escapeHtml(settings['plex.url'])}" placeholder="http://192.168.1.20:32400" />
      </label>
      <label>Plex token
        <input type="password" name="plexToken" value="${escapeHtml(settings['plex.token'])}" autocomplete="off" />
      </label>
      <input type="hidden" name="plexLoginSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexLogin" ${settings['plex.login'] === 'true' ? 'checked' : ''} />
        <span>Allow signing in with Plex</span>
      </label>
      <input type="hidden" name="plexImportSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexImportWatchlist" ${settings['plex.importWatchlist'] === 'true' ? 'checked' : ''} />
        <span>Copy a profile's Plex watchlist into its Discovarr watchlist when it signs in</span>
      </label>
      <p class="muted small">A Plex account that has never used this instance gets its own Discovarr account the first time it
        signs in, and picks its Plex profile when the account has more than one. A profile with a Plex Home PIN has to
        enter that PIN before it signs in.</p>
      <p class="muted small">Used to check that a title really is in Plex and to link cards straight to playback. The token is the
        <code>X-Plex-Token</code> value in any Plex item's <code>Get Info → View XML</code> link.</p>
      <div class="request-actions">
        <button class="btn btn-sm" type="submit">Save</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/plex">Save and test connection</button>
      </div>
    </form>
  </fieldset>`
}

function userRow(member, actor) {
  const isSelf = member.id === actor.id
  return `<form method="post" action="/settings/users/${member.id}" class="user-row">
    <div class="user-id">
      <strong>${escapeHtml(member.username)}</strong>
      <span class="muted small">${escapeHtml(member.email)}</span>
    </div>
    <label>Role
      <select name="role" ${isSelf ? 'disabled' : ''}>
        <option value="user" ${member.role === Role.USER ? 'selected' : ''}>User</option>
        <option value="admin" ${member.role === Role.ADMIN ? 'selected' : ''}>Admin</option>
      </select>
    </label>
    <div class="permissions">
      ${Object.entries(Permission)
        .map(
          ([name, flag]) => `<label class="checkbox">
            <input type="checkbox" name="permission" value="${flag}" ${(member.permissions & flag) === flag || member.role === Role.ADMIN ? 'checked' : ''} ${member.role === Role.ADMIN || isSelf ? 'disabled' : ''} />
            <span>${escapeHtml(PERMISSION_LABELS[flag] ?? name)}</span>
          </label>`
        )
        .join('')}
    </div>
    <div class="quota">
      <label>Movie quota <input type="number" name="quotaMovie" min="0" value="${member.quotaMovie}" /></label>
      <label>Series quota <input type="number" name="quotaTv" min="0" value="${member.quotaTv}" /></label>
    </div>
    <div class="user-actions">
      <button class="btn btn-sm" type="submit" ${isSelf ? 'disabled' : ''}>Save</button>
      ${
        isSelf
          ? ''
          : `<button class="btn btn-sm btn-danger" type="submit" formaction="/settings/users/${member.id}/delete"
              data-confirm="Delete this user? Their requests, sessions and watchlist go with the account.">Delete</button>`
      }
    </div>
  </form>`
}

export function settingsBody({
  user,
  settings,
  users,
  audit,
  options,
  tab,
  tokens = [],
  newToken = null,
  notice,
  error, newTokenScope }) {
  const sync = syncState()
  const current = SETTINGS_TABS.some(([key]) => key === tab) ? tab : 'general'

  const general = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="general" />
      <input type="hidden" name="settingsTab" value="general" />
      <fieldset class="panel">
        <legend>Application</legend>
        <label>Application name <input type="text" name="appName" value="${escapeHtml(settings['app.name'])}" maxlength="60" /></label>
        <p class="muted small">Auto-approval is a per-account permission: tick
          <strong>Auto-approve own requests</strong> for someone in the Users tab and their
          requests go straight to Radarr or Sonarr instead of waiting for review.</p>
      </fieldset>
      <fieldset class="panel">
        <legend>Metadata</legend>
        <label>TMDB API key
          <input type="password" name="tmdbApiKey" value="${escapeHtml(settings['tmdb.apiKey'])}" autocomplete="off" placeholder="v3 key or v4 read token" />
        </label>
        <label>Where-to-watch region
          <select name="tmdbRegion">${regionOptions(settings['tmdb.region'])}</select>
        </label>
      </fieldset>
      <button class="btn" type="submit">Save general settings</button>
    </form>

    <section class="panel">
      <h2 style="margin: 0">Appearance</h2>
      <p class="muted small">The theme is saved to the account, so every device signed in as you paints the same one. It applies straight away.</p>
      ${themeSelect({ label: 'Theme' })}
    </section>`

  const integrations = `${servicePanel('radarr', 'Radarr', settings, options)}
    ${servicePanel('sonarr', 'Sonarr', settings, options)}
    ${plexPanel(settings)}`

  const usersTab = `<h2>Users</h2>
    <div class="user-list">${users.map((member) => userRow(member, user)).join('')}</div>

    <form method="post" action="/settings/users" class="stack panel">
      <h2 style="margin: 0">Add a user</h2>
      <div class="row-grid">
        <label>Username <input type="text" name="username" required minlength="3" maxlength="40" /></label>
        <label>Email <input type="email" name="email" required /></label>
        <label>Password <input type="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" /></label>
        <label>Role
          <select name="role">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <button class="btn btn-sm" type="submit">Create user</button>
    </form>`

  const notifications = `${pushCard(user, store.listPushSubscriptions(user.id))}
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="notifications" />
      <input type="hidden" name="settingsTab" value="notifications" />
      <fieldset class="panel">
        <legend>Webhook</legend>
        <label>Webhook URL
          <input type="url" name="webhookUrl" value="${escapeHtml(settings['notifications.webhookUrl'])}" placeholder="https://discord.com/api/webhooks/..." />
        </label>
        <label class="checkbox"><input type="checkbox" name="onRequest" ${settings['notifications.onRequest'] === 'true' ? 'checked' : ''} /> <span>New requests</span></label>
        <label class="checkbox"><input type="checkbox" name="onApproval" ${settings['notifications.onApproval'] === 'true' ? 'checked' : ''} /> <span>Approvals and declines</span></label>
        <label class="checkbox"><input type="checkbox" name="onAvailable" ${settings['notifications.onAvailable'] === 'true' ? 'checked' : ''} /> <span>Titles becoming available</span></label>
        <label class="checkbox"><input type="checkbox" name="onFailure" ${settings['notifications.onFailure'] === 'true' ? 'checked' : ''} /> <span>Failed dispatch to Radarr/Sonarr</span></label>
        <p class="muted small">A Discord or Slack incoming webhook works; the payload is a plain JSON message.</p>
      </fieldset>
      <button class="btn" type="submit">Save notification settings</button>
    </form>

    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="mail" />
      <input type="hidden" name="settingsTab" value="notifications" />
      <fieldset class="panel">
        <legend>Email (SMTP)</legend>
        <label class="checkbox">
          <input type="checkbox" name="smtpEnabled" ${settings['smtp.enabled'] === 'true' ? 'checked' : ''} />
          <span>Send notification email</span>
        </label>
        <div class="row-grid">
          <label>Server <input type="text" name="smtpHost" value="${escapeHtml(settings['smtp.host'])}" placeholder="smtp.example.com" /></label>
          <label>Port <input type="number" name="smtpPort" min="1" max="65535" value="${escapeHtml(settings['smtp.port'])}" /></label>
          <label>Security
            <select name="smtpSecurity">
              <option value="starttls" ${settings['smtp.security'] === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
              <option value="ssl" ${settings['smtp.security'] === 'ssl' ? 'selected' : ''}>Implicit TLS (465)</option>
              <option value="none" ${settings['smtp.security'] === 'none' ? 'selected' : ''}>None (relay on this host)</option>
            </select>
          </label>
          <label>Username <input type="text" name="smtpUser" value="${escapeHtml(settings['smtp.user'])}" autocomplete="off" /></label>
          <label>Password <input type="password" name="smtpPassword" value="${escapeHtml(settings['smtp.password'])}" autocomplete="off" /></label>
          <label>From address <input type="email" name="smtpFrom" value="${escapeHtml(settings['smtp.from'])}" placeholder="discovarr@example.com" /></label>
          <label>From name <input type="text" name="smtpFromName" value="${escapeHtml(settings['smtp.fromName'])}" /></label>
          <label><input type="checkbox" name="smtpVerifyTls" ${settings['smtp.verifyTls'] === 'false' ? '' : 'checked'} /> Verify the server certificate</label>
          <p class="muted small">Leave this on. Turn it off only for a relay on your own network with a self-signed certificate.</p>
        </div>
        <p class="muted small">Email goes to the users who turn it on in Account and tick the events they want.</p>
        <div class="row">
          <button class="btn btn-sm" type="submit">Save mail settings</button>
          <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/mail">Send me a test message</button>
        </div>
      </fieldset>
    </form>`

  const logs = `<section class="panel">
      <h2 style="margin: 0">Recent activity</h2>
      <p class="muted small">The last ${audit.length} actions, newest first. Container output is available in <code>docker logs discovarr</code>.</p>
      <table class="table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          ${
            audit.length
              ? audit
                  .map(
                    (entry) =>
                      `<tr><td data-label="When">${escapeHtml(entry.createdAt.slice(0, 16).replace('T', ' '))}</td><td data-label="Who">${escapeHtml(entry.username)}</td><td data-label="Action">${escapeHtml(entry.action)}</td><td data-label="Detail">${escapeHtml(entry.detail)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>'
          }
        </tbody>
      </table>
    </section>`

  const diag = diagnosticsSnapshot()
  const cache = cacheStats()

  // A failing sync used to be visible only in docker logs; surface it here with
  // the retry time so an administrator does not have to watch the container.
  const syncHealth = diag.sync.lastError
    ? `<section class="panel alert-panel">
        <h2 style="margin: 0">The last sync had errors</h2>
        <p class="muted small">${escapeHtml(diag.sync.lastError)}</p>
        ${
          diag.sync.nextAttemptAt
            ? `<p class="muted small">Attempt ${escapeHtml(String(diag.sync.attempts))}, retrying after ${escapeHtml(
                diag.sync.nextAttemptAt.replace('T', ' ').slice(0, 19)
              )}.</p>`
            : ''
        }
        <form method="post" action="/settings/sync"><button class="btn btn-sm" type="submit">Retry now</button></form>
      </section>`
    : ''

  const cachePanel = `<form method="post" action="/settings" class="stack panel">
      <h2 style="margin: 0">Artwork cache</h2>
      <p class="muted small">${cache.files} file(s), ${formatBytes(cache.bytes)}, in <code>${escapeHtml(cache.directory)}</code></p>
      <input type="hidden" name="settingsSection" value="cache" />
      <input type="hidden" name="settingsTab" value="tasks" />
      <div class="row-grid">
        <label>Maximum size (MB, 0 = unlimited)
          <input type="number" name="cacheMaxMb" min="0" value="${escapeHtml(settings['cache.maxMb'])}" />
        </label>
        <label>Delete images older than (days, 0 = never)
          <input type="number" name="cacheMaxAgeDays" min="0" value="${escapeHtml(settings['cache.maxAgeDays'])}" />
        </label>
      </div>
      <button class="btn btn-sm" type="submit">Save cache limits</button>
    </form>

    <form method="post" action="/settings/cache/prune" class="panel">
      <h2 style="margin: 0">Prune now</h2>
      <p class="muted small">Removes images past those limits, least recently used first. Posters are fetched from TMDB again the next time they are shown.</p>
      <button class="btn btn-sm btn-ghost" type="submit">Prune cache</button>
    </form>`

  const backupPanel = `<section class="panel">
      <h2 style="margin: 0">Backup and restore</h2>
      <p class="muted small">Every setting as one JSON file, so a move to another machine does not mean retyping keys.</p>
      <p><a class="btn btn-sm" href="/settings/export">Download settings file</a>
        <a class="btn btn-sm btn-ghost" href="/settings/export?secrets=1">Download with secrets</a></p>
      <form method="post" action="/settings/import" class="stack" data-restore-form>
        <label class="file-pick">Restore from a settings file
          <input type="file" accept=".json,application/json" data-restore-file />
        </label>
        <p class="muted small" data-restore-name hidden></p>
        <label>Or paste the JSON
          <textarea name="payload" rows="6" data-restore-payload placeholder="Paste the contents of discovarr-settings.json"></textarea>
        </label>
        <button class="btn btn-sm btn-ghost" type="submit">Restore settings</button>
        <p class="muted small">Only known settings are written and unknown keys are ignored. Blank secrets are skipped, so a redacted file cannot wipe keys that are already saved.</p>
      </form>
    </section>`

  const diagnosticsPanel = `<section class="panel">
      <h2 style="margin: 0">Diagnostics</h2>
      <table class="table">
        <tbody>
          <tr><th>Version</th><td>${escapeHtml(diag.version)} · Node ${escapeHtml(diag.node)} · ${escapeHtml(diag.platform)}</td></tr>
          <tr><th>Uptime</th><td>${escapeHtml(formatDuration(diag.uptimeSeconds))}</td></tr>
          <tr><th>Database</th><td>${formatBytes(diag.database.bytes)} (write-ahead log ${formatBytes(diag.database.walBytes)})</td></tr>
          <tr><th>Artwork cache</th><td>${diag.cache.files} file(s), ${formatBytes(diag.cache.bytes)}</td></tr>
          <tr><th>Catalog</th><td>${diag.counts.media} title(s) · ${diag.counts.users} user(s) · ${diag.counts.sessions} active session(s)</td></tr>
          <tr><th>Requests</th><td>${diag.counts.pending} pending · ${diag.counts.approved} approved · ${diag.counts.failed} failed · ${diag.counts.completed} completed · ${diag.counts.declined} declined</td></tr>
          <tr><th>Radarr</th><td>${escapeHtml(serviceLine(diag.services.radarr))}</td></tr>
          <tr><th>Sonarr</th><td>${escapeHtml(serviceLine(diag.services.sonarr))}</td></tr>
          <tr><th>Last sync</th><td>${diag.sync.lastRun ? escapeHtml(diag.sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${diag.sync.lastError ? ' · last attempt failed' : ''}</td></tr>
        </tbody>
      </table>
    </section>`

  const tasks = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="tasks" />
      <input type="hidden" name="settingsTab" value="tasks" />
      <fieldset class="panel">
        <legend>Library sync</legend>
        <label>Interval (minutes, 0 disables)
          <input type="number" name="syncIntervalMinutes" min="0" value="${escapeHtml(settings['sync.intervalMinutes'])}" />
        </label>
        <label>Automatic retries of a failed dispatch
          <input type="number" name="maxAttempts" min="0" max="10" value="${escapeHtml(settings['requests.maxAttempts'])}" />
        </label>
        <p class="muted small">A failed dispatch is retried after two minutes, then four, and so on. At 0 only a manual retry runs.</p>
        <p class="muted small">Last run: ${sync.lastRun ? escapeHtml(sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${sync.running ? ' · running now' : ''}</p>
        ${sync.lastSummary ? `<p class="muted small">Last result: ${escapeHtml(JSON.stringify(sync.lastSummary.services))}</p>` : ''}
        <button class="btn btn-sm" type="submit">Save schedule</button>
      </fieldset>
    </form>

    <form method="post" action="/settings/sync" class="panel">
      <h2 style="margin: 0">Run a sync now</h2>
      <p class="muted small">Pulls the Radarr and Sonarr libraries and marks finished requests as available.</p>
      <button class="btn btn-sm btn-ghost" type="submit">Sync now</button>
    </form>

    ${syncHealth}
    ${cachePanel}
    ${backupPanel}
    ${diagnosticsPanel}`

  const content =
    current === 'users'
      ? usersTab
      : current === 'notifications'
        ? notifications
        : current === 'logs'
          ? logs
          : current === 'tasks'
            ? tasks
            : current === 'tokens'
              ? tokensPanel({ tokens, newToken, newTokenScope })
              : current === 'general'
                ? general
                : integrations

  return `<h1>Settings</h1>
    ${alert({ notice, error })}
    ${settingsTabs(current)}
    ${content}`
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

export function serviceFromBody(body, kind) {
  const service = {}

  // Only fields that were actually submitted are written, so a partial post
  // cannot blank a URL or key that is already saved.
  for (const [field, suffix] of [
    ['url', 'Url'],
    ['apiKey', 'ApiKey'],
    ['rootFolder', 'RootFolder'],
  ]) {
    if (body[`${kind}${suffix}`] !== undefined) service[field] = body[`${kind}${suffix}`]
  }

  // A form that carries the marker can turn a service off; without it an
  // unchecked box is indistinguishable from a field that was never shown.
  if (body[`${kind}EnabledSubmitted`] !== undefined) {
    service.enabled = body[`${kind}Enabled`] !== undefined
  } else if (body[`${kind}Enabled`] !== undefined) {
    service.enabled = true
  }

  const profile = body[`${kind}QualityProfile`]
  if (profile !== undefined) {
    const [id, name] = String(profile).split('|')
    service.qualityProfileId = id ?? ''
    service.qualityProfileName = name ?? ''
  }

  if (body[`${kind}ProfilesSubmitted`] !== undefined) {
    const picked = body[`${kind}ExtraProfile`]
    service.qualityProfiles = picked === undefined ? [] : [].concat(picked)
  }

  return service
}

/**
 * Root folders and profiles for every configured service, so the settings page
 * can show dropdowns without the extra "load" round trip. Failures are
 * swallowed: the form then falls back to free-text inputs.
 */
export async function loadOptionsForPage({ fresh = false, kinds = ['radarr', 'sonarr'] } = {}) {
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      if (!serviceSummary(kind).configured) return [kind, null]
      try {
        return [kind, await loadServiceOptions(kind, { fresh })]
      } catch {
        return [kind, null]
      }
    })
  )

  return Object.fromEntries(entries)
}

/** Stores the first folder and profile when the service has neither yet. */
export function applyFirstServiceDefaults(kind, loaded, actor) {
  const service = serviceSummary(kind)
  const selection = {
    rootFolder: service.rootFolder || loaded.rootFolders[0]?.path || '',
    qualityProfileId:
      service.qualityProfileId || (loaded.qualityProfiles[0] ? String(loaded.qualityProfiles[0].id) : ''),
    qualityProfileName: service.qualityProfileName || loaded.qualityProfiles[0]?.name || '',
  }

  const unchanged =
    selection.rootFolder === String(service.rootFolder ?? '') &&
    selection.qualityProfileId === String(service.qualityProfileId ?? '') &&
    selection.qualityProfileName === String(service.qualityProfileName ?? '')

  if (!unchanged) saveServiceSelection(kind, selection, actor)
}

export function settingsFromBody(body) {
  const section = body.settingsSection ?? ''
  const touchesServices = ['radarr', 'sonarr'].some((kind) =>
    ['Url', 'ApiKey', 'Enabled', 'EnabledSubmitted', 'RootFolder', 'QualityProfile', 'ProfilesSubmitted'].some(
      (suffix) => body[`${kind}${suffix}`] !== undefined
    )
  )

  const input = {}

  if (section === 'integrations' || touchesServices) {
    input.radarr = serviceFromBody(body, 'radarr')
    input.sonarr = serviceFromBody(body, 'sonarr')
  }

  const generalForm = section === '' || section === 'general' || section === 'integrations'

  if (generalForm) {
    if (body.appName !== undefined) input.appName = body.appName
    if (body.tmdbApiKey !== undefined) input.tmdbApiKey = body.tmdbApiKey
    if (body.tmdbRegion !== undefined) input.tmdbRegion = body.tmdbRegion
  }

  if (
    body.plexUrl !== undefined ||
    body.plexToken !== undefined ||
    body.plexEnabledSubmitted !== undefined
  ) {
    input.plex = {}
    if (body.plexUrl !== undefined) input.plex.url = body.plexUrl
    if (body.plexToken !== undefined) input.plex.token = body.plexToken
    if (body.plexEnabledSubmitted !== undefined) input.plex.enabled = body.plexEnabled !== undefined
    if (body.plexLoginSubmitted !== undefined) input.plex.login = body.plexLogin !== undefined
    if (body.plexImportSubmitted !== undefined) {
      input.plex.importWatchlist = body.plexImportWatchlist !== undefined
    }
  }

  if (section === 'notifications') {
    input.notifications = {
      webhookUrl: body.webhookUrl,
      onRequest: body.onRequest !== undefined,
      onApproval: body.onApproval !== undefined,
      onAvailable: body.onAvailable !== undefined,
      onFailure: body.onFailure !== undefined,
    }
  }

  if (section === 'mail') {
    input.smtp = {
      enabled: body.smtpEnabled !== undefined,
      host: body.smtpHost,
      port: body.smtpPort,
      security: body.smtpSecurity,
      user: body.smtpUser,
      password: body.smtpPassword,
      from: body.smtpFrom,
      fromName: body.smtpFromName,
      verifyTls: body.smtpVerifyTls !== undefined,
    }
  }

  if (section === 'tasks') {
    if (body.syncIntervalMinutes !== undefined) input.syncIntervalMinutes = body.syncIntervalMinutes
    if (body.maxAttempts !== undefined) input.maxAttempts = body.maxAttempts
  }

  if (section === 'cache') {
    input.cache = {}
    if (body.cacheMaxMb !== undefined) input.cache.maxMb = body.cacheMaxMb
    if (body.cacheMaxAgeDays !== undefined) input.cache.maxAgeDays = body.cacheMaxAgeDays
  }

  return input
}

export function permissionsFromBody(body) {
  const values = body.permission === undefined ? [] : [].concat(body.permission)
  return values.reduce((mask, value) => mask | Number(value), 0)
}

/** One line describing a service's configuration, never its credentials. */
export function serviceLine(summary) {
  if (!summary) return 'not configured'
  if (!summary.enabled) return 'disabled'
  if (!summary.configured) return 'enabled, but no URL or API key saved'
  return `enabled · root folder ${summary.rootFolder || 'not set'} · profile ${summary.qualityProfileName || 'default'}`
}

