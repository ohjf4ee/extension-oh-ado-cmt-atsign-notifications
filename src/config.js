/**
 * Configuration constants for the ADO @ Mention Notifications extension.
 */

// Storage keys
export const STORAGE_KEYS = {
  ORGANIZATIONS: 'ado_orgs',
  MENTIONS: 'ado_mentions',
  READ_IDS: 'ado_read_ids',
  LAST_POLL: 'ado_last_poll',
  PREFERENCES: 'ado_preferences',
  CURRENT_USERS: 'ado_current_users',
};

// Default preferences
export const DEFAULT_PREFERENCES = {
  notificationsEnabled: false,
  notificationSound: true,
  showPreviewInNotification: true,
  defaultPollIntervalMinutes: 5,
};

// API configuration
export const API_CONFIG = {
  version: '7.1-preview',
  maxWorkItemsPerBatch: 200,
  maxMentionsToStore: 500,
};

// Polling configuration
export const POLLING_CONFIG = {
  minIntervalMinutes: 1,
  defaultIntervalMinutes: 5,
  maxConsecutiveFailures: 3,
  backoffMinutes: 15,
};

// Alarm name prefix for polling
export const ALARM_PREFIX = 'poll_';

// Message types for communication between popup/content scripts and background
export const MESSAGE_TYPES = {
  // State queries
  GET_STATE: 'GET_STATE',
  POPUP_OPENED: 'POPUP_OPENED',

  // Mention actions
  MARK_AS_READ: 'MARK_AS_READ',
  MARK_AS_UNREAD: 'MARK_AS_UNREAD',
  MARK_ALL_READ: 'MARK_ALL_READ',
  REFRESH_NOW: 'REFRESH_NOW',

  // Organization management
  VALIDATE_ORG: 'VALIDATE_ORG',
  ADD_ORG: 'ADD_ORG',
  UPDATE_ORG: 'UPDATE_ORG',
  REMOVE_ORG: 'REMOVE_ORG',

  // Preferences
  UPDATE_PREFERENCES: 'UPDATE_PREFERENCES',

  // From content script
  MENTION_DETECTED: 'MENTION_DETECTED',
  COMMENT_ADDED: 'COMMENT_ADDED',
};
