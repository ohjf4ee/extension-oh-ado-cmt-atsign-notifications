# Background Service Module

## Purpose

The background service worker is the "brain" of the extension. It orchestrates polling, manages state, updates the badge, and dispatches notifications. In Manifest V3, this runs as a service worker that can be terminated by the browser when idle.

## Dependencies

- **02-mention-detection** - For detecting mentions
- **01-ado-api** - For creating API clients
- **Storage module** - For persisting state across service worker restarts
- **Chrome APIs** - alarms, notifications, action (badge), storage

## Responsibilities

1. Schedule and execute polling for each configured organization
2. Maintain mention state (list of mentions, read/unread status)
3. Update badge count with unread mention count
4. Dispatch browser notifications for new mentions (when enabled)
5. Handle messages from popup UI and content scripts
6. Survive service worker termination/restart

---

## Manifest V3 Service Worker Constraints

### Key Limitations

- **Termination**: Service worker terminates after ~30 seconds of inactivity
- **No persistent state**: All state must be stored in `chrome.storage`
- **Minimum alarm interval**: `chrome.alarms` minimum period is 30 seconds
- **No DOM access**: Cannot use DOM APIs

### Design Implications

1. **State Recovery**: On every activation, restore state from `chrome.storage`
2. **Alarms for Scheduling**: Use `chrome.alarms` API, not `setInterval`
3. **Idempotent Operations**: Polling should be safe to run multiple times
4. **Minimal Memory**: Don't hold large data structures in memory

---

## State Management

### State Schema

```javascript
// Stored in chrome.storage.local
const STATE_KEYS = {
  ORGANIZATIONS: 'ado_orgs',           // OrgConfig[]
  MENTIONS: 'ado_mentions',            // Mention[]
  READ_IDS: 'ado_read_ids',            // string[] (mention IDs marked as read)
  LAST_POLL: 'ado_last_poll',          // { [orgUrl]: timestamp }
  PREFERENCES: 'ado_preferences',      // UserPreferences
  CURRENT_USERS: 'ado_current_users',  // { [orgUrl]: UserInfo }
};

interface OrgConfig {
  orgUrl: string;
  orgName: string;
  pat: string;                         // Encrypted
  enabled: boolean;
  pollIntervalMinutes: number;         // Default: 5
  lastError?: string;
}

interface UserPreferences {
  notificationsEnabled: boolean;       // Default: false
  notificationSound: boolean;          // Default: true
  showPreviewInNotification: boolean;  // Default: true
}
```

### State Helper Functions

```javascript
// src/background/state.js

async function loadState() {
  const data = await chrome.storage.local.get([
    STATE_KEYS.ORGANIZATIONS,
    STATE_KEYS.MENTIONS,
    STATE_KEYS.READ_IDS,
    STATE_KEYS.LAST_POLL,
    STATE_KEYS.PREFERENCES,
    STATE_KEYS.CURRENT_USERS
  ]);

  return {
    organizations: data[STATE_KEYS.ORGANIZATIONS] || [],
    mentions: data[STATE_KEYS.MENTIONS] || [],
    readIds: new Set(data[STATE_KEYS.READ_IDS] || []),
    lastPoll: data[STATE_KEYS.LAST_POLL] || {},
    preferences: data[STATE_KEYS.PREFERENCES] || getDefaultPreferences(),
    currentUsers: data[STATE_KEYS.CURRENT_USERS] || {}
  };
}

async function saveMentions(mentions) {
  await chrome.storage.local.set({ [STATE_KEYS.MENTIONS]: mentions });
}

async function saveReadIds(readIds) {
  await chrome.storage.local.set({ [STATE_KEYS.READ_IDS]: Array.from(readIds) });
}

async function updateLastPoll(orgUrl, timestamp) {
  const { [STATE_KEYS.LAST_POLL]: lastPoll = {} } =
    await chrome.storage.local.get(STATE_KEYS.LAST_POLL);
  lastPoll[orgUrl] = timestamp;
  await chrome.storage.local.set({ [STATE_KEYS.LAST_POLL]: lastPoll });
}
```

---

## Polling Scheduler

### Alarm-Based Scheduling

```javascript
// src/background/polling.js

const ALARM_NAME_PREFIX = 'poll_';

function getAlarmName(orgUrl) {
  // Create deterministic alarm name from org URL
  return ALARM_NAME_PREFIX + btoa(orgUrl).replace(/[^a-zA-Z0-9]/g, '');
}

async function schedulePolling() {
  const state = await loadState();

  // Clear existing alarms
  const existingAlarms = await chrome.alarms.getAll();
  for (const alarm of existingAlarms) {
    if (alarm.name.startsWith(ALARM_NAME_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // Schedule alarm for each enabled org
  for (const org of state.organizations) {
    if (!org.enabled) continue;

    const alarmName = getAlarmName(org.orgUrl);
    await chrome.alarms.create(alarmName, {
      delayInMinutes: 0.5,  // First poll in 30 seconds
      periodInMinutes: org.pollIntervalMinutes || 5
    });

    console.log(`Scheduled polling for ${org.orgName} every ${org.pollIntervalMinutes} min`);
  }
}

// Handle alarm firing
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_NAME_PREFIX)) return;

  const state = await loadState();
  const org = state.organizations.find(o => getAlarmName(o.orgUrl) === alarm.name);

  if (org && org.enabled) {
    await pollOrganization(org, state);
  }
});
```

### Polling Execution

```javascript
// src/background/polling.js

async function pollOrganization(org, state) {
  console.log(`Polling ${org.orgName}...`);

  try {
    // Decrypt PAT
    const pat = await decryptPat(org.pat);

    // Create API client
    const apiClient = new AdoApiClient(org.orgUrl, pat);

    // Check rate limit
    if (apiClient.isRateLimited()) {
      console.log(`${org.orgName} is rate limited, skipping`);
      return;
    }

    // Detect mentions
    const newMentions = await detectMentions(apiClient, {
      includeWorkItems: true,
      includePRs: false  // Stub for Phase 1
    });

    // Merge with existing mentions
    const { added, updated } = mergeMentions(state.mentions, newMentions);

    // Save updated mentions
    await saveMentions(state.mentions);

    // Update last poll time
    await updateLastPoll(org.orgUrl, Date.now());

    // Clear any previous error
    if (org.lastError) {
      org.lastError = null;
      await saveOrganizations(state.organizations);
    }

    // Handle new mentions
    if (added.length > 0) {
      await handleNewMentions(added, state);
    }

    // Update badge
    await updateBadge(state);

    console.log(`Polled ${org.orgName}: ${added.length} new, ${updated.length} updated`);

  } catch (error) {
    console.error(`Error polling ${org.orgName}:`, error);

    // Save error for display in UI
    org.lastError = error.message;
    await saveOrganizations(state.organizations);

    // Update badge to show error state?
    // (Optional: could show "!" or different color)
  }
}

function mergeMentions(existing, incoming) {
  const existingById = new Map(existing.map(m => [m.id, m]));
  const added = [];
  const updated = [];

  for (const mention of incoming) {
    const existingMention = existingById.get(mention.id);
    if (!existingMention) {
      existing.push(mention);
      added.push(mention);
    } else if (mention.timestamp > existingMention.timestamp) {
      // Update existing mention
      Object.assign(existingMention, mention);
      updated.push(existingMention);
    }
  }

  // Sort by timestamp descending
  existing.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limit to last 500 mentions to prevent unbounded growth
  if (existing.length > 500) {
    existing.length = 500;
  }

  return { added, updated };
}
```

---

## Badge Management

### Badge Count

```javascript
// src/background/notifications.js

async function updateBadge(state) {
  // Count unread mentions
  const unreadCount = state.mentions.filter(m => !state.readIds.has(m.id)).length;

  if (unreadCount === 0) {
    await chrome.action.setBadgeText({ text: '' });
  } else if (unreadCount > 99) {
    await chrome.action.setBadgeText({ text: '99+' });
  } else {
    await chrome.action.setBadgeText({ text: String(unreadCount) });
  }

  // Set badge color
  await chrome.action.setBadgeBackgroundColor({ color: '#0078D4' });  // Azure blue
}
```

---

## Browser Notifications

### Notification Dispatch

```javascript
// src/background/notifications.js

async function handleNewMentions(newMentions, state) {
  if (!state.preferences.notificationsEnabled) {
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
        priority: 2
      });
    } else {
      // Multiple mentions: summarize
      await chrome.notifications.create(`batch_${orgName}_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `${orgMentions.length} new @mentions`,
        message: `You were mentioned in ${orgMentions.length} places`,
        contextMessage: orgName,
        priority: 2
      });
    }
  }
}

// Handle notification click
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const state = await loadState();
  const mention = state.mentions.find(m => m.id === notificationId);

  if (mention) {
    // Open the mention URL
    await chrome.tabs.create({ url: mention.url });

    // Mark as read
    state.readIds.add(mention.id);
    await saveReadIds(state.readIds);
    await updateBadge(state);
  }

  // Clear notification
  await chrome.notifications.clear(notificationId);
});
```

---

## Message Handling

### Message Types

```javascript
// Message types from popup and content scripts
const MESSAGE_TYPES = {
  // From popup
  GET_STATE: 'GET_STATE',
  MARK_AS_READ: 'MARK_AS_READ',
  MARK_ALL_READ: 'MARK_ALL_READ',
  REFRESH_NOW: 'REFRESH_NOW',

  // From content script
  MENTION_DETECTED: 'MENTION_DETECTED',
};
```

### Message Listener

```javascript
// background.js (service worker entry point)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ error: error.message }));

  return true;  // Indicates async response
});

async function handleMessage(message, sender) {
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
          lastError: o.lastError
        })),
        preferences: state.preferences,
        lastPoll: state.lastPoll
      };

    case MESSAGE_TYPES.MARK_AS_READ:
      state.readIds.add(message.mentionId);
      await saveReadIds(state.readIds);
      await updateBadge(state);
      return { success: true };

    case MESSAGE_TYPES.MARK_ALL_READ:
      for (const mention of state.mentions) {
        state.readIds.add(mention.id);
      }
      await saveReadIds(state.readIds);
      await updateBadge(state);
      return { success: true };

    case MESSAGE_TYPES.REFRESH_NOW:
      for (const org of state.organizations) {
        if (org.enabled) {
          await pollOrganization(org, state);
        }
      }
      return { success: true };

    case MESSAGE_TYPES.MENTION_DETECTED:
      // From content script
      // TODO: Implement content script integration
      console.log('Content script detected mention:', message.payload);
      return { success: true };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
```

---

## Service Worker Lifecycle

### Initialization

```javascript
// background.js (entry point)

import { schedulePolling } from './background/polling.js';
import { updateBadge, loadState } from './background/state.js';

// On install/update
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated');
  await schedulePolling();
  const state = await loadState();
  await updateBadge(state);
});

// On startup (browser launch)
chrome.runtime.onStartup.addListener(async () => {
  console.log('Browser started');
  await schedulePolling();
  const state = await loadState();
  await updateBadge(state);
});

// Service worker activated (e.g., after being idle)
// Note: This happens automatically when alarms fire or messages arrive
```

### Keeping Alive (If Needed)

Generally, we don't need to keep the service worker alive. Alarms will wake it up for polling, and messages from popup/content scripts will wake it for those interactions.

If needed for debugging:

```javascript
// NOT recommended for production, but useful for debugging
chrome.runtime.onConnect.addListener((port) => {
  // Keeping port open keeps service worker alive
});
```

---

## Error Handling

### Graceful Degradation

```javascript
async function pollOrganization(org, state) {
  try {
    // ... polling logic ...
  } catch (error) {
    // Log error
    console.error(`Polling error for ${org.orgName}:`, error);

    // Store error for UI display
    org.lastError = getUserFriendlyError(error);
    await saveOrganizations(state.organizations);

    // Don't throw - let other orgs continue

    // If auth error, disable org to prevent hammering
    if (error.isAuthError) {
      console.warn(`Disabling ${org.orgName} due to auth error`);
      org.enabled = false;
      await saveOrganizations(state.organizations);
    }
  }
}
```

### Circuit Breaker Pattern

```javascript
// Prevent repeated failures from consuming resources
const failureCounts = new Map();
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MINUTES = 15;

async function pollOrganization(org, state) {
  const failureCount = failureCounts.get(org.orgUrl) || 0;

  if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
    console.log(`${org.orgName} circuit breaker open, skipping`);
    return;
  }

  try {
    // ... polling logic ...
    failureCounts.delete(org.orgUrl);  // Reset on success
  } catch (error) {
    failureCounts.set(org.orgUrl, failureCount + 1);

    if (failureCount + 1 >= MAX_CONSECUTIVE_FAILURES) {
      // Reschedule with backoff
      const alarmName = getAlarmName(org.orgUrl);
      await chrome.alarms.create(alarmName, {
        delayInMinutes: BACKOFF_MINUTES,
        periodInMinutes: org.pollIntervalMinutes || 5
      });
    }

    throw error;
  }
}
```

---

## Module Exports

```javascript
// src/background/index.js
export { schedulePolling, pollOrganization } from './polling.js';
export { updateBadge, handleNewMentions } from './notifications.js';
export { loadState, saveMentions, saveReadIds } from './state.js';
export { MESSAGE_TYPES, handleMessage } from './messages.js';
```

---

## Testing Considerations

### Manual Testing

1. Install extension in developer mode
2. Configure an organization with PAT
3. Check `chrome://extensions` → Service Worker "Inspect" for console logs
4. Verify alarms in DevTools: `chrome.alarms.getAll()`
5. Test service worker termination by waiting >30s, then triggering action

### Debugging Service Worker

```javascript
// Add to background.js for debugging
self.addEventListener('activate', () => console.log('Service worker activated'));
self.addEventListener('install', () => console.log('Service worker installed'));

// Check storage state
chrome.storage.local.get(null, (data) => console.log('Storage:', data));
```
