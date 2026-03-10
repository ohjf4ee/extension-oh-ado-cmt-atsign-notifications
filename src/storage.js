/**
 * Storage module with encrypted PAT support.
 *
 * Provides:
 * - Encrypted storage for sensitive data (PATs)
 * - Plain storage for non-sensitive data (preferences, mention state)
 * - Typed accessors for common operations
 */

import { STORAGE_KEYS, DEFAULT_PREFERENCES } from './config.js';

// Encryption constants
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_DERIVATION_ALGORITHM = 'PBKDF2';
const KEY_DERIVATION_ITERATIONS = 100000;
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

/**
 * Derives an encryption key from a passphrase using PBKDF2.
 * Uses a device-specific identifier as the passphrase base.
 */
async function deriveKey(salt) {
  // Use extension ID as part of the key derivation
  // This ties encrypted data to this specific extension installation
  const extensionId = chrome.runtime.id;
  const passphrase = `ado-mentions-${extensionId}`;

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    KEY_DERIVATION_ALGORITHM,
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: KEY_DERIVATION_ALGORITHM,
      salt: salt,
      iterations: KEY_DERIVATION_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a string value.
 * Returns a base64-encoded string containing salt + iv + ciphertext.
 */
async function encrypt(plaintext) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Derive key and encrypt
  const key = await deriveKey(salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    data
  );

  // Combine salt + iv + ciphertext
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

  // Return as base64
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a base64-encoded encrypted string.
 */
async function decrypt(encryptedBase64) {
  // Decode base64
  const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

  // Extract salt, iv, and ciphertext
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

  // Derive key and decrypt
  const key = await deriveKey(salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Loads all extension state from storage.
 */
export async function loadState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.ORGANIZATIONS,
    STORAGE_KEYS.MENTIONS,
    STORAGE_KEYS.READ_IDS,
    STORAGE_KEYS.LAST_POLL,
    STORAGE_KEYS.PREFERENCES,
    STORAGE_KEYS.CURRENT_USERS,
  ]);

  return {
    organizations: data[STORAGE_KEYS.ORGANIZATIONS] || [],
    mentions: data[STORAGE_KEYS.MENTIONS] || [],
    readIds: new Set(data[STORAGE_KEYS.READ_IDS] || []),
    lastPoll: data[STORAGE_KEYS.LAST_POLL] || {},
    preferences: { ...DEFAULT_PREFERENCES, ...data[STORAGE_KEYS.PREFERENCES] },
    currentUsers: data[STORAGE_KEYS.CURRENT_USERS] || {},
  };
}

/**
 * Saves organizations to storage.
 * Note: PATs should already be encrypted before calling this.
 */
export async function saveOrganizations(organizations) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.ORGANIZATIONS]: organizations,
  });
}

/**
 * Saves mentions to storage.
 */
export async function saveMentions(mentions) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.MENTIONS]: mentions,
  });
}

/**
 * Saves read mention IDs to storage.
 */
export async function saveReadIds(readIds) {
  const idsArray = readIds instanceof Set ? Array.from(readIds) : readIds;
  await chrome.storage.local.set({
    [STORAGE_KEYS.READ_IDS]: idsArray,
  });
}

/**
 * Updates the last poll timestamp for an organization.
 */
export async function updateLastPoll(orgUrl, timestamp) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_POLL);
  const lastPoll = data[STORAGE_KEYS.LAST_POLL] || {};
  lastPoll[orgUrl] = timestamp;
  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_POLL]: lastPoll,
  });
}

/**
 * Saves user preferences.
 */
export async function savePreferences(preferences) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PREFERENCES]: preferences,
  });
}

/**
 * Saves current user info for an organization.
 */
export async function saveCurrentUser(orgUrl, userInfo) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_USERS);
  const currentUsers = data[STORAGE_KEYS.CURRENT_USERS] || {};
  currentUsers[orgUrl] = userInfo;
  await chrome.storage.local.set({
    [STORAGE_KEYS.CURRENT_USERS]: currentUsers,
  });
}

/**
 * Encrypts a PAT for secure storage.
 */
export async function encryptPat(pat) {
  return encrypt(pat);
}

/**
 * Decrypts a stored PAT.
 */
export async function decryptPat(encryptedPat) {
  return decrypt(encryptedPat);
}

/**
 * Clears all extension data.
 */
export async function clearAllData() {
  await chrome.storage.local.clear();
}

/**
 * Adds a new organization with encrypted PAT.
 */
export async function addOrganization(orgUrl, orgName, pat, pollIntervalMinutes = 5) {
  const state = await loadState();

  // Check if org already exists
  const existingIndex = state.organizations.findIndex(o => o.orgUrl === orgUrl);
  if (existingIndex >= 0) {
    throw new Error('Organization already exists');
  }

  // Encrypt PAT
  const encryptedPat = await encryptPat(pat);

  // Add org
  state.organizations.push({
    orgUrl,
    orgName,
    pat: encryptedPat,
    enabled: true,
    pollIntervalMinutes,
    lastError: null,
  });

  await saveOrganizations(state.organizations);
  return state.organizations;
}

/**
 * Updates an existing organization.
 */
export async function updateOrganization(orgUrl, updates) {
  const state = await loadState();
  const org = state.organizations.find(o => o.orgUrl === orgUrl);

  if (!org) {
    throw new Error('Organization not found');
  }

  // If PAT is being updated, encrypt it
  if (updates.pat) {
    updates.pat = await encryptPat(updates.pat);
  }

  Object.assign(org, updates);
  await saveOrganizations(state.organizations);
  return state.organizations;
}

/**
 * Removes an organization.
 */
export async function removeOrganization(orgUrl) {
  const state = await loadState();
  const index = state.organizations.findIndex(o => o.orgUrl === orgUrl);

  if (index < 0) {
    throw new Error('Organization not found');
  }

  state.organizations.splice(index, 1);

  // Also remove related data
  delete state.lastPoll[orgUrl];
  delete state.currentUsers[orgUrl];

  // Remove mentions from this org
  const filteredMentions = state.mentions.filter(m => m.orgUrl !== orgUrl);

  await Promise.all([
    saveOrganizations(state.organizations),
    saveMentions(filteredMentions),
    chrome.storage.local.set({
      [STORAGE_KEYS.LAST_POLL]: state.lastPoll,
      [STORAGE_KEYS.CURRENT_USERS]: state.currentUsers,
    }),
  ]);

  return state.organizations;
}

/**
 * Gets a decrypted PAT for an organization.
 */
export async function getDecryptedPat(orgUrl) {
  const state = await loadState();
  const org = state.organizations.find(o => o.orgUrl === orgUrl);

  if (!org) {
    throw new Error('Organization not found');
  }

  return decryptPat(org.pat);
}

// =============================================================================
// PR Poll State
// =============================================================================

/**
 * Gets the last PR poll timestamp for an organization.
 */
export async function getLastPRPoll(orgUrl) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_PR_POLL);
  const lastPRPoll = data[STORAGE_KEYS.LAST_PR_POLL] || {};
  return lastPRPoll[orgUrl] || null;
}

/**
 * Updates the last PR poll timestamp for an organization.
 */
export async function updateLastPRPoll(orgUrl, timestamp) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_PR_POLL);
  const lastPRPoll = data[STORAGE_KEYS.LAST_PR_POLL] || {};
  lastPRPoll[orgUrl] = timestamp;
  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_PR_POLL]: lastPRPoll,
  });
}

/**
 * Gets the PR thread cache for an organization.
 * Returns { prId: maxLastUpdatedDate } map.
 */
export async function getPRThreadCache(orgUrl) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PR_THREAD_CACHE);
  const cache = data[STORAGE_KEYS.PR_THREAD_CACHE] || {};
  return cache[orgUrl] || {};
}

/**
 * Updates the PR thread cache for a specific PR.
 */
export async function updatePRThreadCache(orgUrl, prId, maxDate) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PR_THREAD_CACHE);
  const cache = data[STORAGE_KEYS.PR_THREAD_CACHE] || {};
  if (!cache[orgUrl]) {
    cache[orgUrl] = {};
  }
  cache[orgUrl][prId] = maxDate;
  await chrome.storage.local.set({
    [STORAGE_KEYS.PR_THREAD_CACHE]: cache,
  });
}

/**
 * Saves the entire PR thread cache for an organization.
 */
export async function savePRThreadCache(orgUrl, prCache) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PR_THREAD_CACHE);
  const cache = data[STORAGE_KEYS.PR_THREAD_CACHE] || {};
  cache[orgUrl] = prCache;
  await chrome.storage.local.set({
    [STORAGE_KEYS.PR_THREAD_CACHE]: cache,
  });
}

/**
 * Clears the PR thread cache for an organization.
 */
export async function clearPRThreadCache(orgUrl) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PR_THREAD_CACHE);
  const cache = data[STORAGE_KEYS.PR_THREAD_CACHE] || {};
  delete cache[orgUrl];
  await chrome.storage.local.set({
    [STORAGE_KEYS.PR_THREAD_CACHE]: cache,
  });
}

// =============================================================================
// Assignment Check State
// =============================================================================

/**
 * Gets the last assignment check timestamp for an organization.
 */
export async function getLastAssignmentCheck(orgUrl) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_ASSIGNMENT_CHECK);
  const lastCheck = data[STORAGE_KEYS.LAST_ASSIGNMENT_CHECK] || {};
  return lastCheck[orgUrl] || null;
}

/**
 * Updates the last assignment check timestamp for an organization.
 */
export async function updateLastAssignmentCheck(orgUrl, timestamp) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_ASSIGNMENT_CHECK);
  const lastCheck = data[STORAGE_KEYS.LAST_ASSIGNMENT_CHECK] || {};
  lastCheck[orgUrl] = timestamp;
  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_ASSIGNMENT_CHECK]: lastCheck,
  });
}
