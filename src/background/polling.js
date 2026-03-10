/**
 * Polling scheduler for mention detection.
 */

import { ALARM_PREFIX, POLLING_CONFIG } from '../config.js';
import { AdoApiClient, getUserFriendlyError } from '../ado/api-client.js';
import { detectMentions } from '../ado/mentions.js';
import {
  loadState,
  saveOrganizations,
  saveMentions,
  updateLastPoll,
  getDecryptedPat,
  mergeMentions,
  getLastPRPoll,
  updateLastPRPoll,
  getPRThreadCache,
  savePRThreadCache,
  getLastAssignmentCheck,
  updateLastAssignmentCheck,
} from './state.js';
import { updateBadge, dispatchNotifications } from './notifications.js';

// Track consecutive failures per org (in-memory, resets on service worker restart)
const failureCounts = new Map();

/**
 * Creates an alarm name for an organization.
 */
function getAlarmName(orgUrl) {
  // Create deterministic alarm name from org URL
  // Use base64 and strip non-alphanumeric chars
  return ALARM_PREFIX + btoa(orgUrl).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

/**
 * Finds an organization by its alarm name.
 */
function findOrgByAlarmName(organizations, alarmName) {
  return organizations.find(o => getAlarmName(o.orgUrl) === alarmName);
}

/**
 * Schedules polling alarms for all enabled organizations.
 */
export async function schedulePolling() {
  const state = await loadState();

  // Clear existing polling alarms
  const existingAlarms = await chrome.alarms.getAll();
  for (const alarm of existingAlarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // Schedule alarm for each enabled org and poll immediately
  for (const org of state.organizations) {
    if (!org.enabled) {
      continue;
    }

    const alarmName = getAlarmName(org.orgUrl);
    const intervalMinutes = org.pollIntervalMinutes || POLLING_CONFIG.defaultIntervalMinutes;

    // Schedule recurring alarm (first alarm fires after periodInMinutes)
    await chrome.alarms.create(alarmName, {
      periodInMinutes: Math.max(intervalMinutes, POLLING_CONFIG.minIntervalMinutes),
    });

    console.log(`Scheduled polling for ${org.orgName} every ${intervalMinutes} min`);

    // Poll immediately on startup (don't wait for first alarm)
    pollOrganization(org).catch(err => {
      console.error(`Initial poll failed for ${org.orgName}:`, err);
    });
  }
}

/**
 * Polls a single organization for mentions.
 */
export async function pollOrganization(org) {
  console.log(`Polling ${org.orgName}...`);

  const failureCount = failureCounts.get(org.orgUrl) || 0;

  // Circuit breaker: skip if too many consecutive failures
  if (failureCount >= POLLING_CONFIG.maxConsecutiveFailures) {
    console.log(`${org.orgName} circuit breaker open, skipping`);
    return { success: false, skipped: true };
  }

  try {
    // Get decrypted PAT
    const pat = await getDecryptedPat(org.orgUrl);

    // Create API client
    const apiClient = new AdoApiClient(org.orgUrl, pat);

    // Check rate limit
    if (apiClient.isRateLimited()) {
      console.log(`${org.orgName} is rate limited, skipping`);
      return { success: false, rateLimited: true };
    }

    // Load state for PR and assignment tracking
    const lastPRPollTime = await getLastPRPoll(org.orgUrl);
    const prThreadCache = await getPRThreadCache(org.orgUrl);
    const lastAssignmentCheckTime = await getLastAssignmentCheck(org.orgUrl);

    // Detect all notification types
    const result = await detectMentions(apiClient, {
      includeWorkItems: true,
      includePRs: true,
      includeAssignments: true,
      lastPRPollTime,
      prThreadCache,
      lastAssignmentCheckTime,
    });

    // Load current state and merge mentions
    const state = await loadState();
    const { added, updated } = mergeMentions(state.mentions, result.mentions);

    // Save updated mentions
    await saveMentions(state.mentions);

    // Update timestamps
    await updateLastPoll(org.orgUrl, Date.now());
    await updateLastAssignmentCheck(org.orgUrl, new Date().toISOString());

    // Update PR poll state if we polled PRs
    if (result.prResult) {
      await updateLastPRPoll(org.orgUrl, result.prResult.newLastPollTime);
      await savePRThreadCache(org.orgUrl, result.prResult.newThreadCache);
    }

    // Clear any previous error
    if (org.lastError) {
      org.lastError = null;
      const orgs = state.organizations;
      const orgIndex = orgs.findIndex(o => o.orgUrl === org.orgUrl);
      if (orgIndex >= 0) {
        orgs[orgIndex].lastError = null;
        await saveOrganizations(orgs);
      }
    }

    // Reset failure count on success
    failureCounts.delete(org.orgUrl);

    // Dispatch notifications for new mentions
    if (added.length > 0) {
      await dispatchNotifications(added, state);
    }

    // Update badge
    await updateBadge();

    console.log(`Polled ${org.orgName}: ${added.length} new, ${updated.length} updated`);

    return {
      success: true,
      added: added.length,
      updated: updated.length,
    };

  } catch (error) {
    console.error(`Error polling ${org.orgName}:`, error);

    // Increment failure count
    failureCounts.set(org.orgUrl, failureCount + 1);

    // Save error for display in UI
    const state = await loadState();
    const orgs = state.organizations;
    const orgIndex = orgs.findIndex(o => o.orgUrl === org.orgUrl);

    if (orgIndex >= 0) {
      orgs[orgIndex].lastError = getUserFriendlyError(error);

      // If auth error, disable org to prevent hammering
      if (error.isAuthError) {
        console.warn(`Disabling ${org.orgName} due to auth error`);
        orgs[orgIndex].enabled = false;
      }

      await saveOrganizations(orgs);
    }

    // If we've hit max failures, reschedule with backoff
    if (failureCount + 1 >= POLLING_CONFIG.maxConsecutiveFailures) {
      const alarmName = getAlarmName(org.orgUrl);
      await chrome.alarms.create(alarmName, {
        delayInMinutes: POLLING_CONFIG.backoffMinutes,
        periodInMinutes: org.pollIntervalMinutes || POLLING_CONFIG.defaultIntervalMinutes,
      });
      console.log(`${org.orgName} entering backoff for ${POLLING_CONFIG.backoffMinutes} min`);
    }

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Polls all enabled organizations.
 */
export async function pollAllOrganizations() {
  const state = await loadState();
  const results = [];

  for (const org of state.organizations) {
    if (org.enabled) {
      const result = await pollOrganization(org);
      results.push({ org: org.orgName, ...result });
    }
  }

  return results;
}

/**
 * Handles alarm events for polling.
 */
export function setupAlarmHandler() {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) {
      return;
    }

    const state = await loadState();
    const org = findOrgByAlarmName(state.organizations, alarm.name);

    if (org && org.enabled) {
      await pollOrganization(org);
    }
  });
}
