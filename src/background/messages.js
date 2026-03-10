/**
 * Message handling for communication between popup/content scripts and background.
 */

import { MESSAGE_TYPES } from '../config.js';
import { AdoApiClient, normalizeOrgUrl, extractOrgName } from '../ado/api-client.js';
import {
  loadState,
  saveReadIds,
  savePreferences,
  addOrganization,
  updateOrganization,
  removeOrganization,
  clearAllData,
} from './state.js';
import { updateBadge, stopBadgeBlink } from './notifications.js';
import { pollAllOrganizations, schedulePolling } from './polling.js';

/**
 * Handles incoming messages from popup and content scripts.
 */
export async function handleMessage(message, sender) {
  const state = await loadState();

  switch (message.type) {
    case MESSAGE_TYPES.GET_STATE:
      return {
        mentions: state.mentions,
        readIds: Array.from(state.readIds),
        organizations: state.organizations.map(o => ({
          orgUrl: o.orgUrl,
          orgName: o.orgName,
          enabled: o.enabled,
          pollIntervalMinutes: o.pollIntervalMinutes,
          lastError: o.lastError,
        })),
        preferences: state.preferences,
        lastPoll: state.lastPoll,
      };

    case MESSAGE_TYPES.POPUP_OPENED: {
      stopBadgeBlink();
      return { success: true };
    }

    case MESSAGE_TYPES.MARK_AS_READ: {
      state.readIds.add(message.mentionId);
      await saveReadIds(state.readIds);
      await updateBadge();
      return { success: true };
    }

    case MESSAGE_TYPES.MARK_AS_UNREAD: {
      state.readIds.delete(message.mentionId);
      await saveReadIds(state.readIds);
      await updateBadge({ checkForNewMentions: false });
      return { success: true };
    }

    case MESSAGE_TYPES.MARK_ALL_READ: {
      for (const mention of state.mentions) {
        state.readIds.add(mention.id);
      }
      await saveReadIds(state.readIds);
      await updateBadge();
      return { success: true };
    }

    case MESSAGE_TYPES.REFRESH_NOW: {
      const results = await pollAllOrganizations();
      return { success: true, results };
    }

    case MESSAGE_TYPES.VALIDATE_ORG: {
      const orgUrl = normalizeOrgUrl(message.orgUrl);
      const apiClient = new AdoApiClient(orgUrl, message.pat);
      const result = await apiClient.validateConnection();
      return result;
    }

    case MESSAGE_TYPES.ADD_ORG: {
      const orgUrl = normalizeOrgUrl(message.orgUrl);
      const orgName = extractOrgName(orgUrl);

      await addOrganization(
        orgUrl,
        orgName,
        message.pat,
        message.pollIntervalMinutes
      );

      // Reschedule polling to include new org
      await schedulePolling();

      return { success: true };
    }

    case MESSAGE_TYPES.UPDATE_ORG: {
      await updateOrganization(message.orgUrl, message.updates);

      // Reschedule polling in case interval changed
      await schedulePolling();

      return { success: true };
    }

    case MESSAGE_TYPES.REMOVE_ORG: {
      await removeOrganization(message.orgUrl);

      // Reschedule polling to remove org's alarm
      await schedulePolling();
      await updateBadge();

      return { success: true };
    }

    case MESSAGE_TYPES.UPDATE_PREFERENCES: {
      const newPrefs = { ...state.preferences, ...message.preferences };
      await savePreferences(newPrefs);
      return { success: true };
    }

    case MESSAGE_TYPES.MENTION_DETECTED: {
      // From content script (future implementation)
      console.log('Content script detected mention:', message.payload);
      return { success: true };
    }

    case MESSAGE_TYPES.COMMENT_ADDED: {
      // From content script - user added a comment on ADO page
      console.log('Content script detected comment submission, triggering refresh');
      // Trigger a refresh to pick up the new comment
      pollAllOrganizations().catch(err => {
        console.error('Error refreshing after comment:', err);
      });
      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/**
 * Sets up the message listener.
 */
export function setupMessageHandler() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch(error => {
        console.error('Message handler error:', error);
        sendResponse({ error: error.message });
      });

    // Return true to indicate async response
    return true;
  });
}
