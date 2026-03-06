# Mention Detection Module

## Purpose

Detects @ mentions of the current user across various Azure DevOps surfaces. This module contains the business logic for finding mentions, separate from the API client (01-ado-api) and the scheduling logic (03-background-service).

## Dependencies

- **01-ado-api** - For making API calls to Azure DevOps
- **Storage module** - For caching current user info

## Responsibilities

1. Query for mentions using WIQL `@recentMentions` macro
2. Parse work item comments to extract mention details
3. (Stub) Scan PR threads for mentions
4. (Stub) Observe DOM for real-time mention detection
5. Normalize mention data into a consistent format
6. Deduplicate mentions across sources

---

## Mention Data Model

### Unified Mention Record

All detection strategies produce this common format:

```typescript
interface Mention {
  // Unique identifier: "{orgUrl}:{type}:{itemId}:{commentId}"
  id: string;

  // Source organization
  orgUrl: string;
  orgName: string;

  // Where the mention occurred
  type: 'workitem' | 'pullrequest' | 'commit';  // Extensible for future
  itemId: number;
  itemTitle: string;
  projectName: string;

  // Comment details
  commentId: number | null;
  commentHtml: string;        // Raw HTML (for rendering)
  commentPreview: string;     // Plain text preview (truncated)

  // Who mentioned the user
  mentionedBy: {
    displayName: string;
    uniqueName: string;       // email or username
    imageUrl?: string;
  };

  // When
  timestamp: string;          // ISO 8601

  // Navigation
  url: string;                // Direct link to the mention

  // State (managed by background service, not detection module)
  // isRead: boolean;         // NOT part of detection output
}
```

### Helper Functions

```javascript
function createMentionId(orgUrl, type, itemId, commentId) {
  return `${orgUrl}:${type}:${itemId}:${commentId || 'item'}`;
}

function parseMentionId(id) {
  const parts = id.split(':');
  return {
    orgUrl: parts.slice(0, -3).join(':'),  // Handle : in URL
    type: parts[parts.length - 3],
    itemId: parseInt(parts[parts.length - 2], 10),
    commentId: parts[parts.length - 1] === 'item' ? null : parseInt(parts[parts.length - 1], 10)
  };
}
```

---

## Detection Strategy 1: WIQL @recentMentions (Primary)

### Overview

Azure DevOps provides a built-in WIQL macro `@recentMentions` that returns work items where the current user was mentioned in the last 30 days. This is the most efficient detection method.

### WIQL Query

```sql
SELECT [System.Id], [System.Title], [System.TeamProject], [System.ChangedDate]
FROM workitems
WHERE [System.Id] IN (@recentMentions)
ORDER BY [System.ChangedDate] DESC
```

### Implementation

```javascript
// src/ado/mentions.js

async function detectWorkItemMentions(apiClient, projects = null) {
  // Get current user for reference
  const currentUser = await apiClient.getCurrentUser();

  // Query for mentions
  const wiql = `
    SELECT [System.Id], [System.Title], [System.TeamProject], [System.ChangedDate]
    FROM workitems
    WHERE [System.Id] IN (@recentMentions)
    ORDER BY [System.ChangedDate] DESC
  `;

  const workItemRefs = await apiClient.executeWiql(wiql);

  if (workItemRefs.length === 0) {
    return [];
  }

  // Batch fetch work item details
  const workItemIds = workItemRefs.map(wi => wi.id);
  const workItems = await apiClient.getWorkItems(workItemIds, [
    'System.Id',
    'System.Title',
    'System.TeamProject',
    'System.ChangedDate',
    'System.WorkItemType'
  ]);

  // For each work item, find the specific mention(s) in comments
  const mentions = [];
  for (const workItem of workItems) {
    const itemMentions = await extractMentionsFromWorkItem(
      apiClient,
      workItem,
      currentUser
    );
    mentions.push(...itemMentions);
  }

  return mentions;
}
```

### Extracting Mentions from Comments

Work item comments contain HTML with `data-vss-mention` attributes for @ mentions:

```html
<div>
  Hey <a href="#" data-vss-mention="version:2.0,id:abc123">@John Smith</a>,
  can you review this?
</div>
```

```javascript
async function extractMentionsFromWorkItem(apiClient, workItem, currentUser) {
  const comments = await apiClient.getWorkItemComments(workItem.id);
  const mentions = [];

  for (const comment of comments) {
    if (commentMentionsUser(comment.text, currentUser)) {
      mentions.push({
        id: createMentionId(apiClient.orgUrl, 'workitem', workItem.id, comment.id),
        orgUrl: apiClient.orgUrl,
        orgName: extractOrgName(apiClient.orgUrl),
        type: 'workitem',
        itemId: workItem.id,
        itemTitle: workItem.fields['System.Title'],
        projectName: workItem.fields['System.TeamProject'],
        commentId: comment.id,
        commentHtml: comment.text,
        commentPreview: extractPreview(comment.text, 150),
        mentionedBy: {
          displayName: comment.createdBy.displayName,
          uniqueName: comment.createdBy.uniqueName,
          imageUrl: comment.createdBy.imageUrl
        },
        timestamp: comment.createdDate,
        url: buildWorkItemCommentUrl(apiClient.orgUrl, workItem, comment.id)
      });
    }
  }

  return mentions;
}
```

### Mention Parsing Utilities

```javascript
function commentMentionsUser(html, currentUser) {
  // Parse HTML for data-vss-mention attributes
  const mentionPattern = /data-vss-mention="[^"]*id:([^",]+)/g;
  let match;

  while ((match = mentionPattern.exec(html)) !== null) {
    const mentionedUserId = match[1];
    if (mentionedUserId === currentUser.id ||
        mentionedUserId === currentUser.publicAlias) {
      return true;
    }
  }

  // Fallback: Check for @displayName or @email patterns
  const userPatterns = [
    currentUser.displayName,
    currentUser.emailAddress,
    currentUser.publicAlias
  ].filter(Boolean);

  for (const pattern of userPatterns) {
    if (html.includes(`@${pattern}`) || html.includes(`>${pattern}</a>`)) {
      return true;
    }
  }

  return false;
}

function extractPreview(html, maxLength) {
  // Strip HTML tags
  const text = html.replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();

  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + '...';
}

function extractOrgName(orgUrl) {
  // "https://dev.azure.com/myorg" → "myorg"
  const match = orgUrl.match(/dev\.azure\.com\/([^\/]+)/);
  return match ? match[1] : orgUrl;
}

function buildWorkItemCommentUrl(orgUrl, workItem, commentId) {
  const project = encodeURIComponent(workItem.fields['System.TeamProject']);
  return `${orgUrl}/${project}/_workitems/edit/${workItem.id}#${commentId}`;
}
```

---

## Detection Strategy 2: PR Thread Scanning (Stub)

### Overview

For pull request mentions, we need to:
1. Find PRs where the user is involved (reviewer, author)
2. Scan comment threads for @ mentions

This is more expensive than WIQL because there's no `@recentMentions` equivalent for PRs.

### Stub Implementation

```javascript
// src/ado/mentions.js

async function detectPRMentions(apiClient, currentUser) {
  // STUB: Return empty array for Phase 1
  // Future implementation will:
  // 1. Query PRs where user is reviewer or author
  // 2. For each PR, get comment threads
  // 3. Parse threads for mentions
  console.log('PR mention detection not yet implemented');
  return [];
}

// Future implementation sketch:
async function _detectPRMentions_future(apiClient, currentUser) {
  const projects = await apiClient.listProjects();
  const mentions = [];

  for (const project of projects) {
    // Get PRs where user is reviewer
    const prs = await apiClient.fetch(
      `/${project.name}/_apis/git/pullrequests?` +
      `searchCriteria.reviewerId=${currentUser.id}&` +
      `searchCriteria.status=active&` +
      `api-version=7.1`
    );

    for (const pr of prs.value) {
      const threads = await apiClient.fetch(
        `/${project.name}/_apis/git/repositories/${pr.repository.id}/` +
        `pullRequests/${pr.pullRequestId}/threads?api-version=7.1`
      );

      for (const thread of threads.value) {
        for (const comment of thread.comments) {
          if (commentMentionsUser(comment.content, currentUser)) {
            mentions.push(/* ... */);
          }
        }
      }
    }
  }

  return mentions;
}
```

---

## Detection Strategy 3: Content Script DOM Observation (Stub)

### Overview

When the user is actively viewing an ADO page, a content script can observe the DOM for new comments appearing and detect mentions in real-time.

### Stub Implementation

```javascript
// contentScript.js (entry point)

// STUB: Minimal implementation for Phase 1
// Just logs that the content script loaded

console.log('ADO Mention Notifications: Content script loaded');

// Future implementation will:
// 1. Use MutationObserver to detect new comment elements
// 2. Parse comments for mentions
// 3. Send detected mentions to background service worker
// 4. Highlight or mark mentions visually (optional)
```

### Future Implementation Sketch

```javascript
// contentScript.js (future)

const MENTION_SELECTORS = [
  // Work item discussion
  '.discussion-messages .message-content',
  // PR comments
  '.vc-discussion-thread-comment .comment-content',
  // File comments
  '.code-comment .comment-content'
];

function observeNewComments() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          checkForMentions(node);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

async function checkForMentions(element) {
  // Get current user from storage
  const { currentUser } = await chrome.storage.local.get('currentUser');
  if (!currentUser) return;

  for (const selector of MENTION_SELECTORS) {
    const comments = element.querySelectorAll(selector);
    for (const comment of comments) {
      if (commentMentionsUser(comment.innerHTML, currentUser)) {
        // Send to background service worker
        chrome.runtime.sendMessage({
          type: 'MENTION_DETECTED',
          payload: {
            html: comment.innerHTML,
            url: window.location.href,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }
}

observeNewComments();
```

---

## Main Detection Orchestrator

```javascript
// src/ado/mentions.js

/**
 * Detect all mentions for a given organization.
 * Returns normalized Mention records.
 */
async function detectMentions(apiClient, options = {}) {
  const {
    includeWorkItems = true,
    includePRs = false,       // Disabled by default (stub)
  } = options;

  const currentUser = await apiClient.getCurrentUser();
  const allMentions = [];

  if (includeWorkItems) {
    const wiMentions = await detectWorkItemMentions(apiClient, currentUser);
    allMentions.push(...wiMentions);
  }

  if (includePRs) {
    const prMentions = await detectPRMentions(apiClient, currentUser);
    allMentions.push(...prMentions);
  }

  // Deduplicate by ID (shouldn't happen, but safety)
  const seen = new Set();
  return allMentions.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export {
  detectMentions,
  detectWorkItemMentions,
  detectPRMentions,
  createMentionId,
  parseMentionId,
  commentMentionsUser,
  extractPreview
};
```

---

## Module Exports Summary

```javascript
// src/ado/mentions.js
export {
  // Main entry point
  detectMentions,

  // Individual detection strategies
  detectWorkItemMentions,
  detectPRMentions,        // Stub

  // Utilities
  createMentionId,
  parseMentionId,
  commentMentionsUser,
  extractPreview,
  buildWorkItemCommentUrl
};

// src/ado/index.js (barrel export)
export * from './api-client.js';
export * from './mentions.js';
```

---

## Performance Considerations

### API Call Budget per Detection Cycle

For a single organization with `N` recent mentions:
- 1 WIQL query → returns work item IDs
- 1 batch work item fetch (up to 200 items)
- `N` comment fetches (one per work item)

**Optimization**: Cache work item details and only fetch comments for items that changed since last poll.

### Caching Strategy

```javascript
const mentionCache = {
  lastPoll: null,
  workItemChangeDates: new Map(),  // workItemId → lastChangedDate
};

async function detectWorkItemMentions_cached(apiClient, currentUser) {
  const wiql = `
    SELECT [System.Id], [System.ChangedDate]
    FROM workitems
    WHERE [System.Id] IN (@recentMentions)
    ORDER BY [System.ChangedDate] DESC
  `;

  const workItemRefs = await apiClient.executeWiql(wiql);
  const workItems = await apiClient.getWorkItems(
    workItemRefs.map(wi => wi.id),
    ['System.Id', 'System.ChangedDate', 'System.Title', 'System.TeamProject']
  );

  // Only fetch comments for items that changed
  const changedItems = workItems.filter(wi => {
    const lastKnown = mentionCache.workItemChangeDates.get(wi.id);
    return !lastKnown || wi.fields['System.ChangedDate'] > lastKnown;
  });

  // ... fetch comments only for changedItems ...

  // Update cache
  for (const wi of workItems) {
    mentionCache.workItemChangeDates.set(wi.id, wi.fields['System.ChangedDate']);
  }
}
```

---

## Testing Notes

### Manual Testing with az CLI

```bash
# Test WIQL @recentMentions
az boards query --wiql "SELECT [System.Id] FROM workitems WHERE [System.Id] IN (@recentMentions)" --output table

# Get work item comments
az boards work-item show --id 12345 --expand comments
```

### Edge Cases to Handle

1. **No mentions**: Return empty array, not error
2. **Deleted work items**: Skip gracefully if work item no longer exists
3. **Permission errors**: Log and skip individual items, don't fail entire detection
4. **HTML encoding**: Comment text may contain encoded entities (`&lt;`, `&amp;`)
5. **Multiple mentions in one comment**: Only create one Mention record per comment (dedup by commentId)
