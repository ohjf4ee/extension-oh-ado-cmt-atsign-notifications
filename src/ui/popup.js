/**
 * Popup UI main script.
 */

import { MESSAGE_TYPES } from '../config.js';

// =============================================================================
// State
// =============================================================================

let currentState = null;
let currentView = 'mentions';

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  // Views
  mentionsView: document.getElementById('mentions-view'),
  configView: document.getElementById('config-view'),

  // Mentions view
  mentionsList: document.getElementById('mentions-list'),
  emptyState: document.getElementById('empty-state'),
  noOrgsState: document.getElementById('no-orgs-state'),
  loadingState: document.getElementById('loading-state'),
  filterOrg: document.getElementById('filter-org'),
  markAllReadBtn: document.getElementById('mark-all-read-btn'),
  authErrorBanner: document.getElementById('auth-error-banner'),
  authErrorSettingsBtn: document.getElementById('auth-error-settings-btn'),

  // Header
  unreadBadge: document.getElementById('unread-badge'),
  refreshBtn: document.getElementById('refresh-btn'),
  settingsBtn: document.getElementById('settings-btn'),

  // Config view
  orgList: document.getElementById('org-list'),
  addOrgBtn: document.getElementById('add-org-btn'),
  notificationsToggle: document.getElementById('notifications-toggle'),
  clearDataBtn: document.getElementById('clear-data-btn'),
  backBtn: document.getElementById('back-btn'),

  // Modal
  orgModal: document.getElementById('org-modal'),
  orgModalTitle: document.getElementById('org-modal-title'),
  orgForm: document.getElementById('org-form'),
  orgUrl: document.getElementById('org-url'),
  orgPat: document.getElementById('org-pat'),
  consentCheckbox: document.getElementById('consent-checkbox'),
  orgStatus: document.getElementById('org-status'),
  cancelOrgBtn: document.getElementById('cancel-org-btn'),
  saveOrgBtn: document.getElementById('save-org-btn'),
  createPatLink: document.getElementById('create-pat-link'),

  // Footer
  lastUpdated: document.getElementById('last-updated'),
};

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Notify background that popup opened (stops badge blinking)
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.POPUP_OPENED });

  await loadState();
  setupEventListeners();
});

// =============================================================================
// State Management
// =============================================================================

async function loadState() {
  showLoading(true);

  try {
    currentState = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_STATE,
    });

    renderMentions();
    renderOrgFilter();
    renderOrgList();
    updateUnreadBadge();
    updateLastUpdated();
    updateNotificationsToggle();
    updateAuthErrorBanner();

    // Show appropriate empty state
    if (currentState.organizations.length === 0) {
      elements.noOrgsState.classList.remove('hidden');
      elements.emptyState.classList.add('hidden');
      elements.mentionsList.classList.add('hidden');
    }
  } catch (error) {
    console.error('Failed to load state:', error);
    showError('Failed to load mentions');
  } finally {
    showLoading(false);
  }
}

// =============================================================================
// Rendering
// =============================================================================

function renderMentions() {
  const filter = elements.filterOrg.value;
  const readIds = new Set(currentState.readIds);

  let mentions = currentState.mentions;

  // Apply org filter
  if (filter) {
    mentions = mentions.filter(m => m.orgUrl === filter);
  }

  // Hide list controls and show no-orgs state if no orgs configured
  if (currentState.organizations.length === 0) {
    elements.mentionsList.innerHTML = '';
    elements.mentionsList.classList.add('hidden');
    elements.emptyState.classList.add('hidden');
    elements.noOrgsState.classList.remove('hidden');
    return;
  }

  elements.noOrgsState.classList.add('hidden');

  if (mentions.length === 0) {
    elements.mentionsList.innerHTML = '';
    elements.mentionsList.classList.add('hidden');
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  elements.mentionsList.classList.remove('hidden');
  elements.mentionsList.innerHTML = mentions
    .map(mention => renderMentionItem(mention, readIds.has(mention.id)))
    .join('');
}

function renderMentionItem(mention, isRead) {
  const replyText = mention.userReplyPreview
    ? `You commented: ${escapeHtml(mention.userReplyPreview)}`
    : 'You commented';
  const youCommentedIndicator = mention.userCommentedAfter
    ? `<span class="mention-replied-indicator" title="${escapeHtml(replyText)}">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.854 5.354-4.5 4.5a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.793l4.146-4.147a.5.5 0 0 1 .708.708z"/></svg>
        <span class="mention-replied-text">${replyText}</span>
      </span>`
    : '';

  const actionButton = isRead
    ? `<button class="mark-unread-btn icon-btn" title="Mark as unread" data-id="${escapeHtml(mention.id)}">○</button>`
    : `<button class="mark-read-btn icon-btn" title="Mark as read" data-id="${escapeHtml(mention.id)}">✓</button>`;

  return `
    <article class="mention-item ${isRead ? '' : 'unread'}" data-id="${escapeHtml(mention.id)}" data-url="${escapeHtml(mention.url)}">
      <div class="mention-unread-indicator"></div>
      <div class="mention-content">
        <div class="mention-meta">
          <span>${escapeHtml(mention.orgName)}</span>
          <span>${escapeHtml(mention.projectName)}</span>
        </div>
        <div class="mention-title">
          <span class="mention-type-badge ${mention.type}">${mention.type}</span>
          <span>${escapeHtml(mention.itemTitle)}</span>
        </div>
        <div class="mention-header">
          <span class="mention-author">${escapeHtml(mention.mentionedBy.displayName)}</span>
          <span class="mention-time" title="${escapeHtml(mention.timestamp)}">
            ${formatRelativeTime(mention.timestamp)}
          </span>
        </div>
        <div class="mention-preview">${escapeHtml(mention.commentPreview)}</div>
        ${youCommentedIndicator}
      </div>
      <div class="mention-actions">
        ${actionButton}
      </div>
    </article>
  `;
}

function renderOrgFilter() {
  const orgs = currentState.organizations;
  elements.filterOrg.innerHTML = '<option value="">All organizations</option>';

  for (const org of orgs) {
    const option = document.createElement('option');
    option.value = org.orgUrl;
    option.textContent = org.orgName;
    elements.filterOrg.appendChild(option);
  }
}

function renderOrgList() {
  const orgs = currentState.organizations;

  if (orgs.length === 0) {
    elements.orgList.innerHTML = '<p class="hint">No organizations configured yet.</p>';
    return;
  }

  elements.orgList.innerHTML = orgs
    .map(org => {
      const isAuthError = org.lastError && org.lastError.includes('Authentication failed');
      const statusClass = isAuthError ? 'auth-error' : (org.lastError ? 'error' : '');
      const statusText = org.lastError
        ? escapeHtml(org.lastError)
        : (org.enabled ? 'Active' : 'Disabled');

      return `
      <div class="org-card ${isAuthError ? 'has-auth-error' : ''}" data-url="${escapeHtml(org.orgUrl)}">
        <div class="org-info">
          <div class="org-name-row">
            ${isAuthError ? '<span class="org-error-icon">⚠</span>' : ''}
            <span class="org-name">${escapeHtml(org.orgName)}</span>
          </div>
          <span class="org-status ${statusClass}">${statusText}</span>
        </div>
        <div class="org-actions">
          <button class="icon-btn toggle-org-btn" title="${org.enabled ? 'Disable' : 'Enable'}">
            ${org.enabled ? '⏸' : '▶'}
          </button>
          <button class="icon-btn remove-org-btn" title="Remove">✕</button>
        </div>
      </div>
    `;
    })
    .join('');
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

function updateNotificationsToggle() {
  elements.notificationsToggle.checked = currentState.preferences.notificationsEnabled;
}

function updateAuthErrorBanner() {
  const orgsWithAuthErrors = currentState.organizations.filter(org =>
    org.lastError && org.lastError.includes('Authentication failed')
  );

  if (orgsWithAuthErrors.length > 0) {
    elements.authErrorBanner.classList.remove('hidden');
  } else {
    elements.authErrorBanner.classList.add('hidden');
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

function setupEventListeners() {
  // Mention item click → open URL
  elements.mentionsList.addEventListener('click', async (e) => {
    // Ignore if clicking the mark-read/unread buttons
    if (e.target.closest('.mark-read-btn') || e.target.closest('.mark-unread-btn')) {
      return;
    }

    const item = e.target.closest('.mention-item');
    if (!item) return;

    const url = item.dataset.url;
    const mentionId = item.dataset.id;

    // Open URL
    await chrome.tabs.create({ url });

    // Mark as read
    await markAsRead(mentionId);
  });

  // Mark read button click
  elements.mentionsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mark-read-btn');
    if (!btn) return;

    e.stopPropagation();
    await markAsRead(btn.dataset.id);
  });

  // Mark unread button click
  elements.mentionsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mark-unread-btn');
    if (!btn) return;

    e.stopPropagation();
    await markAsUnread(btn.dataset.id);
  });

  // Mark all read
  elements.markAllReadBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.MARK_ALL_READ });
    await loadState();
  });

  // Refresh
  elements.refreshBtn.addEventListener('click', async () => {
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.classList.add('spinning');

    try {
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.REFRESH_NOW });
      await loadState();
    } finally {
      elements.refreshBtn.disabled = false;
      elements.refreshBtn.classList.remove('spinning');
    }
  });

  // Settings toggle
  elements.settingsBtn.addEventListener('click', () => {
    toggleView('config');
  });

  // Auth error banner Fix button
  elements.authErrorSettingsBtn.addEventListener('click', () => {
    toggleView('config');
  });

  // Back to mentions
  elements.backBtn.addEventListener('click', () => {
    toggleView('mentions');
  });

  // Filter change
  elements.filterOrg.addEventListener('change', () => {
    renderMentions();
  });

  // Add org button
  elements.addOrgBtn.addEventListener('click', () => {
    showOrgModal();
  });

  // Org form submit
  elements.orgForm.addEventListener('submit', handleOrgFormSubmit);

  // Cancel org modal
  elements.cancelOrgBtn.addEventListener('click', () => {
    hideOrgModal();
  });

  // Modal backdrop click
  elements.orgModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    hideOrgModal();
  });

  // Create PAT link
  elements.createPatLink.addEventListener('click', (e) => {
    e.preventDefault();
    const orgUrl = elements.orgUrl.value.trim();
    let patUrl = 'https://dev.azure.com/_usersSettings/tokens';

    if (orgUrl) {
      // Try to build org-specific URL
      const match = orgUrl.match(/dev\.azure\.com\/([^\/]+)/);
      if (match) {
        patUrl = `https://dev.azure.com/${match[1]}/_usersSettings/tokens`;
      }
    }

    chrome.tabs.create({ url: patUrl });
  });

  // Notifications toggle
  elements.notificationsToggle.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.UPDATE_PREFERENCES,
      preferences: {
        notificationsEnabled: elements.notificationsToggle.checked,
      },
    });
  });

  // Clear data
  elements.clearDataBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all extension data? This cannot be undone.')) {
      await chrome.storage.local.clear();
      await loadState();
      toggleView('mentions');
    }
  });

  // Org list actions (event delegation)
  elements.orgList.addEventListener('click', async (e) => {
    const card = e.target.closest('.org-card');
    if (!card) return;

    const orgUrl = card.dataset.url;

    if (e.target.closest('.remove-org-btn')) {
      if (confirm('Remove this organization?')) {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.REMOVE_ORG,
          orgUrl,
        });
        await loadState();
      }
    } else if (e.target.closest('.toggle-org-btn')) {
      const org = currentState.organizations.find(o => o.orgUrl === orgUrl);
      if (org) {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.UPDATE_ORG,
          orgUrl,
          updates: { enabled: !org.enabled },
        });
        await loadState();
      }
    }
  });
}

async function markAsRead(mentionId) {
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.MARK_AS_READ,
    mentionId,
  });

  // Update local state
  if (!currentState.readIds.includes(mentionId)) {
    currentState.readIds.push(mentionId);
  }
  renderMentions();
  updateUnreadBadge();
}

async function markAsUnread(mentionId) {
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.MARK_AS_UNREAD,
    mentionId,
  });

  // Update local state
  const index = currentState.readIds.indexOf(mentionId);
  if (index > -1) {
    currentState.readIds.splice(index, 1);
  }
  renderMentions();
  updateUnreadBadge();
}

async function handleOrgFormSubmit(e) {
  e.preventDefault();

  const orgUrl = elements.orgUrl.value.trim();
  const pat = elements.orgPat.value;

  setOrgStatus('Validating connection...', 'info');
  elements.saveOrgBtn.disabled = true;

  try {
    // Validate connection
    const result = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.VALIDATE_ORG,
      orgUrl,
      pat,
    });

    if (!result.valid) {
      let errorMsg = result.error || 'Invalid credentials';
      if (result.details) {
        errorMsg += `\n(${result.details})`;
      }
      setOrgStatus(errorMsg, 'error');
      elements.saveOrgBtn.disabled = false;
      return;
    }

    // Save organization
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ADD_ORG,
      orgUrl,
      pat,
    });

    setOrgStatus(`Connected as ${result.user.displayName}`, 'success');

    // Close modal and refresh after short delay
    setTimeout(async () => {
      hideOrgModal();
      await loadState();
    }, 1000);

  } catch (error) {
    setOrgStatus(error.message || 'Failed to add organization', 'error');
    elements.saveOrgBtn.disabled = false;
  }
}

// =============================================================================
// UI Helpers
// =============================================================================

function toggleView(view) {
  currentView = view;
  elements.mentionsView.classList.toggle('active', view === 'mentions');
  elements.configView.classList.toggle('active', view === 'config');
}

function showOrgModal() {
  elements.orgForm.reset();
  elements.orgStatus.classList.add('hidden');
  elements.saveOrgBtn.disabled = false;
  elements.orgModal.classList.remove('hidden');
  elements.orgUrl.focus();
}

function hideOrgModal() {
  elements.orgModal.classList.add('hidden');
}

function setOrgStatus(message, type) {
  elements.orgStatus.textContent = message;
  elements.orgStatus.className = `status-message ${type}`;
  elements.orgStatus.classList.remove('hidden');
}

function showLoading(show) {
  elements.loadingState.classList.toggle('hidden', !show);
  if (show) {
    elements.mentionsList.classList.add('hidden');
    elements.emptyState.classList.add('hidden');
    elements.noOrgsState.classList.add('hidden');
  }
}

function showError(message) {
  console.error(message);
  // Could add a toast notification here
}

// =============================================================================
// Utility Functions
// =============================================================================

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
  if (text === null || text === undefined) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}
