/**
 * Badge and notification management.
 */

import { loadState, saveReadIds } from './state.js';

/**
 * Updates the extension badge with the unread count.
 */
export async function updateBadge() {
  const state = await loadState();
  const unreadCount = state.mentions.filter(m => !state.readIds.has(m.id)).length;

  if (unreadCount === 0) {
    await chrome.action.setBadgeText({ text: '' });
  } else if (unreadCount > 99) {
    await chrome.action.setBadgeText({ text: '99+' });
  } else {
    await chrome.action.setBadgeText({ text: String(unreadCount) });
  }

  // Azure DevOps blue
  await chrome.action.setBadgeBackgroundColor({ color: '#0078D4' });
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
        iconUrl: 'icons/icon128.png',
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
        iconUrl: 'icons/icon128.png',
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
  });
}
