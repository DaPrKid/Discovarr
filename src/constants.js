export const APP_VERSION = '0.8.0'

// Lifecycle values mirror the enums Seerr uses, so the API and database stay
// familiar to anyone coming from that codebase.
export const MediaType = Object.freeze({
  MOVIE: 'movie',
  TV: 'tv',
})

export const MediaRequestStatus = Object.freeze({
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
})

export const REQUEST_STATUS_LABEL = Object.freeze({
  1: 'Pending',
  2: 'Approved',
  3: 'Declined',
  4: 'Failed',
  5: 'Completed',
})

export const MediaStatus = Object.freeze({
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  BLOCKLISTED: 6,
  DELETED: 7,
})

export const MEDIA_STATUS_LABEL = Object.freeze({
  1: 'Unknown',
  2: 'Requested',
  3: 'Processing',
  4: 'Partly available',
  5: 'Available',
  6: 'Blocklisted',
  7: 'Deleted',
})

export const Role = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
})

// Granular abilities, additive like Seerr's permission bitmask. Administrators
// implicitly hold every permission.
export const Permission = Object.freeze({
  REQUEST_MOVIE: 1,
  REQUEST_TV: 2,
  AUTO_APPROVE: 4,
  MANAGE_REQUESTS: 8,
  MANAGE_USERS: 16,
  MANAGE_SETTINGS: 32,
})

export const PERMISSION_LABELS = Object.freeze({
  [Permission.REQUEST_MOVIE]: 'Request movies',
  [Permission.REQUEST_TV]: 'Request series',
  [Permission.AUTO_APPROVE]: 'Auto-approve own requests',
  [Permission.MANAGE_REQUESTS]: 'Approve and decline requests',
  [Permission.MANAGE_USERS]: 'Manage users',
  [Permission.MANAGE_SETTINGS]: 'Change settings',
})

export const DEFAULT_USER_PERMISSIONS = Permission.REQUEST_MOVIE | Permission.REQUEST_TV
export const ALL_PERMISSIONS = Object.values(Permission).reduce((all, flag) => all | flag, 0)

// Every persisted setting must appear here: the store rejects unknown keys.
export const SETTING_DEFAULTS = Object.freeze({
  'app.name': 'Discovarr',
  'requests.autoApprove': 'false',

  'tmdb.apiKey': '',
  // Where-to-watch region for the title page (ISO 3166-1 alpha-2).
  'tmdb.region': 'US',

  'services.sonarr.enabled': 'false',
  'services.sonarr.url': '',
  'services.sonarr.apiKey': '',
  'services.sonarr.rootFolder': '',
  'services.sonarr.qualityProfileId': '',
  'services.sonarr.qualityProfileName': '',
  // Legacy single default plus "id|name" extra profiles, still read so an
  // install from before named profiles keeps working.
  'services.sonarr.qualityProfiles': '',
  // Named profiles: JSON [{ name, profileId, profileName, rootFolder, isDefault }].
  'services.sonarr.profiles': '',
  'services.radarr.enabled': 'false',
  'services.radarr.url': '',
  'services.radarr.apiKey': '',
  'services.radarr.rootFolder': '',
  'services.radarr.qualityProfileId': '',
  'services.radarr.qualityProfileName': '',
  'services.radarr.qualityProfiles': '',
  'services.radarr.profiles': '',

  'plex.enabled': 'false',
  'plex.url': '',
  'plex.token': '',

  'sync.intervalMinutes': '30',

  'notifications.webhookUrl': '',
  'notifications.onRequest': 'true',
  'notifications.onApproval': 'true',
  'notifications.onAvailable': 'true',
})

export const ACTIVE_REQUEST_STATUSES = Object.freeze([
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
])
