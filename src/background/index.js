/**
 * Background service entry point.
 *
 * Initializes all background functionality:
 * - Polling scheduler
 * - Message handlers
 * - Notification handlers
 * - Badge updates
 */

import { schedulePolling, setupAlarmHandler } from './polling.js';
import { setupMessageHandler } from './messages.js';
import { setupNotificationClickHandler, updateBadge } from './notifications.js';
import { loadState } from './state.js';

/**
 * Initializes the background service.
 * Called on extension load.
 */
export function initializeBackgroundService() {
  console.log('ADO Mentions: Initializing background service');

  // Set up event handlers
  setupAlarmHandler();
  setupMessageHandler();
  setupNotificationClickHandler();

  // Handle extension install/update
  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('ADO Mentions: Extension installed/updated', details.reason);

    // Initialize badge
    await updateBadge();

    // Schedule polling for any existing orgs
    await schedulePolling();
  });

  // Handle browser startup
  chrome.runtime.onStartup.addListener(async () => {
    console.log('ADO Mentions: Browser started');

    // Restore badge state
    await updateBadge();

    // Resume polling
    await schedulePolling();
  });

  // Log that initialization is complete
  console.log('ADO Mentions: Background service initialized');
}

// Re-export for convenience
export { schedulePolling, pollAllOrganizations } from './polling.js';
export { updateBadge } from './notifications.js';
export { loadState } from './state.js';
