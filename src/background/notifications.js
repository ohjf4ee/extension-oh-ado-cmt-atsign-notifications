/**
 * Badge and notification management.
 */

import { loadState, saveReadIds } from './state.js';

// Badge blink state
const BLINK_KEEPALIVE_ALARM = 'badge_blink_keepalive';
const BLINK_INTERVAL_MS = 500;

let blinkState = {
  isBlinking: false,
  isVisible: true,
  unreadCount: 0,
  previousUnreadCount: 0,
  intervalId: null,
};

/**
 * Checks if any organization has an authentication error.
 */
function hasAuthErrors(organizations) {
  return organizations.some(org =>
    org.lastError && org.lastError.includes('Auth failed')
  );
}

/**
 * Updates the extension badge with the unread count or error indicator.
 * @param {Object} options - Options for badge update
 * @param {boolean} [options.checkForNewMentions=true] - Whether to check if count increased and start blinking
 */
export async function updateBadge(options = {}) {
  const { checkForNewMentions = true } = options;
  const state = await loadState();
  const unreadCount = state.mentions.filter(m => !state.readIds.has(m.id)).length;
  const authError = hasAuthErrors(state.organizations);

  // Check if unread count increased (new mentions arrived)
  if (checkForNewMentions && unreadCount > blinkState.previousUnreadCount && unreadCount > 0) {
    startBadgeBlink(unreadCount);
  }
  blinkState.previousUnreadCount = unreadCount;
  blinkState.unreadCount = unreadCount;

  try {
    if (authError) {
      // Show error indicator - exclamation mark with red background
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#A80000' });
      await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    } else if (unreadCount === 0) {
      await chrome.action.setBadgeText({ text: '' });
      stopBadgeBlink();
    } else if (unreadCount > 99) {
      await chrome.action.setBadgeText({ text: '99+' });
      await chrome.action.setBadgeBackgroundColor({ color: '#FFFFFF' });
      await chrome.action.setBadgeTextColor({ color: '#323130' });
    } else {
      await chrome.action.setBadgeText({ text: String(unreadCount) });
      await chrome.action.setBadgeBackgroundColor({ color: '#FFFFFF' });
      await chrome.action.setBadgeTextColor({ color: '#323130' });
    }
  } catch (error) {
    console.error('Failed to update badge:', error);
  }
}

/**
 * Starts the badge blinking effect.
 * Uses setInterval for the actual blink (works while service worker is active)
 * and a keepalive alarm to restart blinking if the service worker wakes from sleep.
 */
function startBadgeBlink(unreadCount) {
  if (blinkState.isBlinking) return;

  blinkState.isBlinking = true;
  blinkState.isVisible = true;
  blinkState.unreadCount = unreadCount;

  startBlinkInterval();

  // Create a keepalive alarm (1 minute minimum) that will restart the blink
  // interval if the service worker wakes up after sleeping
  chrome.alarms.create(BLINK_KEEPALIVE_ALARM, {
    periodInMinutes: 1,
  });
}

/**
 * Starts or restarts the blink interval timer.
 * Called on initial start and when waking from service worker sleep.
 */
function startBlinkInterval() {
  // Clear any existing interval first
  if (blinkState.intervalId) {
    clearInterval(blinkState.intervalId);
  }

  blinkState.intervalId = setInterval(() => {
    toggleBadgeBlink();
  }, BLINK_INTERVAL_MS);
}

/**
 * Stops the badge blinking effect.
 */
export function stopBadgeBlink() {
  if (!blinkState.isBlinking) return;

  blinkState.isBlinking = false;
  blinkState.isVisible = true;

  // Clear the blink interval
  if (blinkState.intervalId) {
    clearInterval(blinkState.intervalId);
    blinkState.intervalId = null;
  }

  // Clear the keepalive alarm
  chrome.alarms.clear(BLINK_KEEPALIVE_ALARM);

  // Ensure badge is visible when stopping
  updateBadgeDisplay();
}

/**
 * Toggles the badge visibility for the blink effect.
 */
async function toggleBadgeBlink() {
  if (!blinkState.isBlinking) return;

  blinkState.isVisible = !blinkState.isVisible;
  await updateBadgeDisplay();
}

/**
 * Updates the badge display based on current blink state.
 */
async function updateBadgeDisplay() {
  try {
    if (blinkState.isVisible && blinkState.unreadCount > 0) {
      const text = blinkState.unreadCount > 99 ? '99+' : String(blinkState.unreadCount);
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: '#FFFFFF' });
      await chrome.action.setBadgeTextColor({ color: '#323130' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (error) {
    console.error('Failed to update badge display:', error);
  }
}

/**
 * Sets up the blink keepalive alarm handler.
 * When the alarm fires after service worker sleep, restart the blink interval.
 */
export function setupBlinkAlarmHandler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BLINK_KEEPALIVE_ALARM && blinkState.isBlinking) {
      // Only restart if interval isn't already running
      // (intervalId will be null if service worker slept and lost it)
      if (!blinkState.intervalId) {
        startBlinkInterval();
      }
    }
  });
}

/**
 * Groups an array by a key function.
 */
function groupBy(array, keyFn) {
  const groups = {};
  for (const item of array) {
    const key = keyFn(item);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  return groups;
}

/**
 * Dispatches browser notifications for new mentions.
 *
 * @param {Mention[]} newMentions - Newly detected mentions
 * @param {Object} state - Current extension state
 */
export async function dispatchNotifications(newMentions, state) {
  if (!state.preferences.notificationsEnabled) {
    return;
  }

  if (newMentions.length === 0) {
    return;
  }

  // Group by organization to avoid notification flood
  const byOrg = groupBy(newMentions, m => m.orgName);

  for (const [orgName, orgMentions] of Object.entries(byOrg)) {
    if (orgMentions.length === 1) {
      // Single mention: show details
      const mention = orgMentions[0];
      await chrome.notifications.create(mention.id, {
        type: 'basic',
        iconUrl: 'icons/icon-128x128.png',
        title: `@mentioned by ${mention.mentionedBy.displayName}`,
        message: state.preferences.showPreviewInNotification
          ? mention.commentPreview
          : `In: ${mention.itemTitle}`,
        contextMessage: `${orgName} - ${mention.projectName}`,
        priority: 2,
      });
    } else {
      // Multiple mentions: summarize
      await chrome.notifications.create(`batch_${orgName}_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128x128.png',
        title: `${orgMentions.length} new @mentions`,
        message: `You were mentioned in ${orgMentions.length} places`,
        contextMessage: orgName,
        priority: 2,
      });
    }
  }
}

/**
 * Sets up the notification click handler.
 */
export function setupNotificationClickHandler() {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    try {
      const state = await loadState();
      const mention = state.mentions.find(m => m.id === notificationId);

      if (mention) {
        // Open the mention URL
        await chrome.tabs.create({ url: mention.url });

        // Mark as read
        state.readIds.add(mention.id);
        await saveReadIds(state.readIds);
        await updateBadge();
      }

      // Clear notification
      await chrome.notifications.clear(notificationId);
    } catch (error) {
      console.error('Failed to handle notification click:', error);
    }
  });
}
