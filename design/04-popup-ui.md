# Popup UI Module

## Purpose

The popup UI is the user-facing interface that appears when clicking the extension icon. It displays the list of mentions, allows marking items as read, and provides access to configuration settings.

## Dependencies

- **Background Service** - For fetching state and triggering actions
- **Storage module** - For reading/writing preferences and org configs

## Responsibilities

1. Display list of @ mentions with relevant metadata
2. Show read/unread status visually
3. Allow marking mentions as read (individually or all)
4. Provide configuration panel for organizations and settings
5. Show connection status and errors

---

## UI Architecture

### Component Structure

```
popup.html
├── Header
│   ├── Title/Logo
│   ├── Unread count badge
│   └── Settings gear icon
├── Mention List (default view)
│   ├── Filter/sort controls
│   ├── Mention items (scrollable)
│   │   ├── Unread indicator
│   │   ├── Mentioner avatar + name
│   │   ├── Work item title
│   │   ├── Comment preview
│   │   ├── Timestamp
│   │   └── Org/project badge
│   └── "Mark all read" button
└── Config Panel (toggled view)
    ├── Organizations list
    │   ├── Add new org button
    │   └── Org cards (URL, status, remove)
    ├── Notification preferences
    └── Clear data button
```

---

## HTML Structure

```html
<!-- popup.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADO Mentions</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="popup-container">
    <!-- Header -->
    <header class="popup-header">
      <div class="header-left">
        <img src="icons/icon32.png" alt="" class="header-icon">
        <h1>@ Mentions</h1>
        <span id="unread-badge" class="unread-badge hidden">0</span>
      </div>
      <div class="header-right">
        <button id="refresh-btn" class="icon-btn" title="Refresh">
          <svg><!-- refresh icon --></svg>
        </button>
        <button id="settings-btn" class="icon-btn" title="Settings">
          <svg><!-- gear icon --></svg>
        </button>
      </div>
    </header>

    <!-- Main content area -->
    <main class="popup-main">
      <!-- Mention list view (default) -->
      <section id="mentions-view" class="view active">
        <div class="list-controls">
          <select id="filter-org">
            <option value="">All organizations</option>
          </select>
          <button id="mark-all-read-btn" class="text-btn">Mark all read</button>
        </div>

        <div id="mentions-list" class="mentions-list">
          <!-- Populated dynamically -->
        </div>

        <div id="empty-state" class="empty-state hidden">
          <p>No mentions found</p>
          <p class="empty-hint">You'll see @mentions here when someone mentions you in Azure DevOps</p>
        </div>

        <div id="loading-state" class="loading-state hidden">
          <div class="spinner"></div>
          <p>Loading mentions...</p>
        </div>
      </section>

      <!-- Config view -->
      <section id="config-view" class="view">
        <h2>Organizations</h2>
        <div id="org-list" class="org-list">
          <!-- Populated dynamically -->
        </div>
        <button id="add-org-btn" class="primary-btn">+ Add Organization</button>

        <h2>Notifications</h2>
        <div class="setting-row">
          <label for="notifications-toggle">Browser notifications</label>
          <input type="checkbox" id="notifications-toggle">
        </div>

        <h2>Data</h2>
        <button id="clear-data-btn" class="danger-btn">Clear All Data</button>
        <p class="hint">This will remove all saved organizations and mention history</p>
      </section>

      <!-- Add/Edit Org Modal -->
      <div id="org-modal" class="modal hidden">
        <div class="modal-content">
          <h2 id="org-modal-title">Add Organization</h2>
          <form id="org-form">
            <div class="form-group">
              <label for="org-url">Organization URL</label>
              <input type="text" id="org-url" placeholder="https://dev.azure.com/myorg" required>
              <p class="hint">e.g., https://dev.azure.com/myorg or just "myorg"</p>
            </div>
            <div class="form-group">
              <label for="org-pat">Personal Access Token</label>
              <input type="password" id="org-pat" required>
              <p class="hint">
                <a href="#" id="create-pat-link">Create a PAT</a> with "Work Items: Read" scope
              </p>
            </div>
            <div class="form-group">
              <label>
                <input type="checkbox" id="consent-checkbox" required>
                I understand this token will be stored securely in my browser
              </label>
            </div>
            <div id="org-status" class="status-message"></div>
            <div class="modal-actions">
              <button type="button" id="cancel-org-btn" class="text-btn">Cancel</button>
              <button type="submit" class="primary-btn">Save</button>
            </div>
          </form>
        </div>
      </div>
    </main>

    <!-- Footer -->
    <footer class="popup-footer">
      <span id="last-updated">Last updated: --</span>
    </footer>
  </div>

  <script src="popup.js" type="module"></script>
</body>
</html>
```

---

## Mention Item Component

### HTML Template

```html
<div class="mention-item ${isRead ? '' : 'unread'}" data-id="${mention.id}">
  <div class="mention-unread-indicator"></div>
  <div class="mention-content">
    <div class="mention-header">
      <img src="${mention.mentionedBy.imageUrl || 'icons/default-avatar.png'}"
           alt="" class="mention-avatar">
      <span class="mention-author">${mention.mentionedBy.displayName}</span>
      <span class="mention-time">${formatRelativeTime(mention.timestamp)}</span>
    </div>
    <div class="mention-title">
      <span class="mention-type-badge ${mention.type}">${mention.type}</span>
      ${mention.itemTitle}
    </div>
    <div class="mention-preview">${mention.commentPreview}</div>
    <div class="mention-meta">
      <span class="mention-org">${mention.orgName}</span>
      <span class="mention-project">${mention.projectName}</span>
    </div>
  </div>
  <div class="mention-actions">
    <button class="mark-read-btn icon-btn" title="Mark as read">
      <svg><!-- check icon --></svg>
    </button>
  </div>
</div>
```

### Interaction

- Click on mention item → Opens ADO URL in new tab, marks as read
- Click mark-read button → Marks as read without opening
- Hover → Shows full timestamp in tooltip

---

## JavaScript Implementation

### Main Popup Script

```javascript
// popup.js

import { MESSAGE_TYPES } from './shared/constants.js';

// State
let currentState = null;
let currentView = 'mentions';

// DOM Elements
const elements = {
  mentionsList: document.getElementById('mentions-list'),
  emptyState: document.getElementById('empty-state'),
  loadingState: document.getElementById('loading-state'),
  unreadBadge: document.getElementById('unread-badge'),
  filterOrg: document.getElementById('filter-org'),
  lastUpdated: document.getElementById('last-updated'),
  // ... more elements
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  setupEventListeners();
});

async function loadState() {
  showLoading(true);

  try {
    currentState = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_STATE
    });

    renderMentions();
    renderOrgFilter();
    updateUnreadBadge();
    updateLastUpdated();
  } catch (error) {
    showError('Failed to load mentions');
    console.error(error);
  } finally {
    showLoading(false);
  }
}

function renderMentions() {
  const filter = elements.filterOrg.value;
  const readIds = new Set(currentState.readIds);

  let mentions = currentState.mentions;

  // Apply filter
  if (filter) {
    mentions = mentions.filter(m => m.orgUrl === filter);
  }

  if (mentions.length === 0) {
    elements.mentionsList.innerHTML = '';
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  elements.mentionsList.innerHTML = mentions.map(mention =>
    renderMentionItem(mention, readIds.has(mention.id))
  ).join('');
}

function renderMentionItem(mention, isRead) {
  return `
    <div class="mention-item ${isRead ? '' : 'unread'}" data-id="${escapeHtml(mention.id)}">
      <div class="mention-unread-indicator"></div>
      <div class="mention-content">
        <div class="mention-header">
          <span class="mention-author">${escapeHtml(mention.mentionedBy.displayName)}</span>
          <span class="mention-time" title="${mention.timestamp}">
            ${formatRelativeTime(mention.timestamp)}
          </span>
        </div>
        <div class="mention-title">
          <span class="mention-type-badge ${mention.type}">${mention.type}</span>
          ${escapeHtml(mention.itemTitle)}
        </div>
        <div class="mention-preview">${escapeHtml(mention.commentPreview)}</div>
        <div class="mention-meta">
          <span class="mention-org">${escapeHtml(mention.orgName)}</span>
          <span class="mention-project">${escapeHtml(mention.projectName)}</span>
        </div>
      </div>
      <button class="mark-read-btn icon-btn" title="Mark as read" data-id="${escapeHtml(mention.id)}">
        ✓
      </button>
    </div>
  `;
}
```

### Event Handlers

```javascript
// popup.js (continued)

function setupEventListeners() {
  // Mention item click → open URL
  elements.mentionsList.addEventListener('click', async (e) => {
    const item = e.target.closest('.mention-item');
    if (!item) return;

    // Ignore if clicking the mark-read button
    if (e.target.closest('.mark-read-btn')) return;

    const mentionId = item.dataset.id;
    const mention = currentState.mentions.find(m => m.id === mentionId);

    if (mention) {
      // Open URL
      await chrome.tabs.create({ url: mention.url });

      // Mark as read
      await markAsRead(mentionId);
    }
  });

  // Mark read button click
  elements.mentionsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mark-read-btn');
    if (!btn) return;

    e.stopPropagation();
    await markAsRead(btn.dataset.id);
  });

  // Mark all read
  document.getElementById('mark-all-read-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.MARK_ALL_READ });
    await loadState();
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.classList.add('spinning');

    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.REFRESH_NOW });
    await loadState();

    btn.disabled = false;
    btn.classList.remove('spinning');
  });

  // Settings toggle
  document.getElementById('settings-btn').addEventListener('click', () => {
    toggleView(currentView === 'mentions' ? 'config' : 'mentions');
  });

  // Filter change
  elements.filterOrg.addEventListener('change', () => {
    renderMentions();
  });

  // Add org button
  document.getElementById('add-org-btn').addEventListener('click', () => {
    showOrgModal();
  });

  // Org form submit
  document.getElementById('org-form').addEventListener('submit', handleOrgFormSubmit);
}

async function markAsRead(mentionId) {
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.MARK_AS_READ,
    mentionId
  });

  // Update local state
  currentState.readIds.push(mentionId);
  renderMentions();
  updateUnreadBadge();
}

function toggleView(view) {
  currentView = view;
  document.getElementById('mentions-view').classList.toggle('active', view === 'mentions');
  document.getElementById('config-view').classList.toggle('active', view === 'config');
}
```

### Organization Configuration

```javascript
// popup.js (continued)

async function handleOrgFormSubmit(e) {
  e.preventDefault();

  const orgUrl = document.getElementById('org-url').value;
  const pat = document.getElementById('org-pat').value;
  const statusEl = document.getElementById('org-status');

  statusEl.textContent = 'Validating connection...';
  statusEl.className = 'status-message info';

  try {
    // Validate connection
    const result = await chrome.runtime.sendMessage({
      type: 'VALIDATE_ORG',
      orgUrl,
      pat
    });

    if (!result.valid) {
      statusEl.textContent = result.error || 'Invalid credentials';
      statusEl.className = 'status-message error';
      return;
    }

    // Save organization
    await chrome.runtime.sendMessage({
      type: 'ADD_ORG',
      orgUrl,
      pat
    });

    statusEl.textContent = `Connected as ${result.user}`;
    statusEl.className = 'status-message success';

    // Close modal and refresh
    setTimeout(() => {
      hideOrgModal();
      loadState();
    }, 1000);

  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.className = 'status-message error';
  }
}

function showOrgModal(editingOrg = null) {
  const modal = document.getElementById('org-modal');
  const title = document.getElementById('org-modal-title');
  const form = document.getElementById('org-form');

  form.reset();
  title.textContent = editingOrg ? 'Edit Organization' : 'Add Organization';

  if (editingOrg) {
    document.getElementById('org-url').value = editingOrg.orgUrl;
    // Don't pre-fill PAT for security
  }

  modal.classList.remove('hidden');
}

function hideOrgModal() {
  document.getElementById('org-modal').classList.add('hidden');
}
```

---

## Utility Functions

```javascript
// popup.js or utils.js

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateUnreadBadge() {
  const readIds = new Set(currentState.readIds);
  const unreadCount = currentState.mentions.filter(m => !readIds.has(m.id)).length;

  if (unreadCount > 0) {
    elements.unreadBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    elements.unreadBadge.classList.remove('hidden');
  } else {
    elements.unreadBadge.classList.add('hidden');
  }
}

function updateLastUpdated() {
  const timestamps = Object.values(currentState.lastPoll);
  if (timestamps.length === 0) {
    elements.lastUpdated.textContent = 'Never updated';
    return;
  }

  const latest = Math.max(...timestamps);
  elements.lastUpdated.textContent = `Updated ${formatRelativeTime(new Date(latest).toISOString())}`;
}

function showLoading(show) {
  elements.loadingState.classList.toggle('hidden', !show);
  elements.mentionsList.classList.toggle('hidden', show);
}

function showError(message) {
  // Could use a toast or inline error
  console.error(message);
}
```

---

## CSS Styling

### Core Styles

```css
/* popup.css */

:root {
  --azure-blue: #0078D4;
  --azure-blue-dark: #106EBE;
  --unread-indicator: #0078D4;
  --text-primary: #323130;
  --text-secondary: #605E5C;
  --bg-primary: #FFFFFF;
  --bg-secondary: #F3F2F1;
  --border-color: #EDEBE9;
  --error-color: #A80000;
  --success-color: #107C10;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-primary);
  width: 380px;
  max-height: 500px;
}

.popup-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Header */
.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  width: 24px;
  height: 24px;
}

.header-left h1 {
  font-size: 16px;
  font-weight: 600;
}

.unread-badge {
  background: var(--azure-blue);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
}

.hidden {
  display: none !important;
}

/* Main content */
.popup-main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.view {
  display: none;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.view.active {
  display: flex;
}

/* Mention list */
.list-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-color);
}

.mentions-list {
  flex: 1;
  overflow-y: auto;
}

/* Mention item */
.mention-item {
  display: flex;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.15s;
}

.mention-item:hover {
  background: var(--bg-secondary);
}

.mention-item.unread {
  background: #F0F7FF;
}

.mention-unread-indicator {
  width: 4px;
  margin-right: 12px;
  border-radius: 2px;
}

.mention-item.unread .mention-unread-indicator {
  background: var(--unread-indicator);
}

.mention-content {
  flex: 1;
  min-width: 0;
}

.mention-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.mention-author {
  font-weight: 600;
  color: var(--text-primary);
}

.mention-time {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}

.mention-title {
  font-size: 13px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-type-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 4px;
  border-radius: 3px;
  margin-right: 4px;
}

.mention-type-badge.workitem {
  background: #E6F2E6;
  color: #107C10;
}

.mention-type-badge.pullrequest {
  background: #FFF4CE;
  color: #8A6914;
}

.mention-preview {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.mention-meta {
  font-size: 11px;
  color: var(--text-secondary);
}

.mention-meta span:not(:last-child)::after {
  content: ' • ';
}

/* Buttons */
.icon-btn {
  background: none;
  border: none;
  padding: 6px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--text-secondary);
}

.icon-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.primary-btn {
  background: var(--azure-blue);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}

.primary-btn:hover {
  background: var(--azure-blue-dark);
}

.text-btn {
  background: none;
  border: none;
  color: var(--azure-blue);
  cursor: pointer;
  font-size: 12px;
}

.text-btn:hover {
  text-decoration: underline;
}

.danger-btn {
  background: var(--error-color);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--text-secondary);
  text-align: center;
}

.empty-hint {
  font-size: 12px;
  margin-top: 8px;
}

/* Loading */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--border-color);
  border-top-color: var(--azure-blue);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Footer */
.popup-footer {
  padding: 8px 16px;
  border-top: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-secondary);
}

/* Modal */
.modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-content {
  background: white;
  padding: 20px;
  border-radius: 8px;
  width: 340px;
  max-height: 90%;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
}

.form-group input[type="text"],
.form-group input[type="password"] {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.status-message {
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
  margin-bottom: 12px;
}

.status-message.error {
  background: #FDE7E9;
  color: var(--error-color);
}

.status-message.success {
  background: #DFF6DD;
  color: var(--success-color);
}

.status-message.info {
  background: #F3F2F1;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
```

---

## Accessibility Considerations

1. **Keyboard navigation**: All interactive elements should be focusable and activatable via keyboard
2. **Screen reader support**: Use appropriate ARIA labels
3. **Color contrast**: Ensure sufficient contrast for text and indicators
4. **Focus indicators**: Visible focus states for keyboard users

```html
<!-- Example accessible mention item -->
<article
  class="mention-item unread"
  tabindex="0"
  role="listitem"
  aria-label="Unread mention from John Smith in Bug: Login fails">
  ...
</article>
```

---

## Module Exports

The popup UI is self-contained (no exports), but shares constants with background:

```javascript
// src/shared/constants.js
export const MESSAGE_TYPES = {
  GET_STATE: 'GET_STATE',
  MARK_AS_READ: 'MARK_AS_READ',
  MARK_ALL_READ: 'MARK_ALL_READ',
  REFRESH_NOW: 'REFRESH_NOW',
  VALIDATE_ORG: 'VALIDATE_ORG',
  ADD_ORG: 'ADD_ORG',
  REMOVE_ORG: 'REMOVE_ORG',
  UPDATE_PREFERENCES: 'UPDATE_PREFERENCES'
};
```
