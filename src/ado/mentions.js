/**
 * Mention detection module.
 *
 * Detects @ mentions of the current user in Azure DevOps.
 * Primary strategy: WIQL @recentMentions macro.
 * Future: PR thread scanning, content script DOM observation (stubbed).
 */

import { API_CONFIG } from '../config.js';

/**
 * Creates a unique mention ID.
 */
export function createMentionId(orgUrl, type, itemId, commentId) {
  return `${orgUrl}:${type}:${itemId}:${commentId || 'item'}`;
}

/**
 * Parses a mention ID back into its components.
 */
export function parseMentionId(id) {
  const lastColonIndex = id.lastIndexOf(':');
  const secondLastColonIndex = id.lastIndexOf(':', lastColonIndex - 1);
  const thirdLastColonIndex = id.lastIndexOf(':', secondLastColonIndex - 1);

  return {
    orgUrl: id.substring(0, thirdLastColonIndex),
    type: id.substring(thirdLastColonIndex + 1, secondLastColonIndex),
    itemId: parseInt(id.substring(secondLastColonIndex + 1, lastColonIndex), 10),
    commentId: id.substring(lastColonIndex + 1) === 'item'
      ? null
      : parseInt(id.substring(lastColonIndex + 1), 10),
  };
}

/**
 * Checks if a comment HTML contains a mention of the given user.
 *
 * ADO comments use `data-vss-mention` attributes for @ mentions:
 * <a href="#" data-vss-mention="version:2.0,id:abc123">@John Smith</a>
 */
export function commentMentionsUser(html, currentUser) {
  if (!html || !currentUser) {
    return false;
  }

  // Check for data-vss-mention attribute with user ID
  const mentionPattern = /data-vss-mention="[^"]*id:([^",\s]+)/gi;
  let match;

  while ((match = mentionPattern.exec(html)) !== null) {
    const mentionedUserId = match[1];
    if (mentionedUserId === currentUser.id ||
        mentionedUserId === currentUser.publicAlias) {
      return true;
    }
  }

  // Fallback: Check for @displayName or @email patterns in text
  const userPatterns = [
    currentUser.displayName,
    currentUser.emailAddress,
    currentUser.publicAlias,
  ].filter(Boolean);

  const lowerHtml = html.toLowerCase();
  for (const pattern of userPatterns) {
    if (pattern && lowerHtml.includes(`@${pattern.toLowerCase()}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a plain text preview from HTML content.
 */
export function extractPreview(html, maxLength = 150) {
  if (!html) {
    return '';
  }

  // Strip HTML tags and decode entities
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Builds a URL to a work item comment.
 */
export function buildWorkItemCommentUrl(orgUrl, projectName, workItemId, commentId) {
  const project = encodeURIComponent(projectName);
  let url = `${orgUrl}/${project}/_workitems/edit/${workItemId}`;
  if (commentId) {
    url += `#${commentId}`;
  }
  return url;
}

/**
 * Extracts mentions from a work item's comments.
 */
async function extractMentionsFromWorkItem(apiClient, workItem, currentUser) {
  const projectName = workItem.fields['System.TeamProject'];
  const comments = await apiClient.getWorkItemComments(projectName, workItem.id);
  const mentions = [];

  for (const comment of comments) {
    if (commentMentionsUser(comment.text, currentUser)) {

      mentions.push({
        id: createMentionId(apiClient.orgUrl, 'workitem', workItem.id, comment.id),
        orgUrl: apiClient.orgUrl,
        orgName: apiClient.orgName,
        type: 'workitem',
        itemId: workItem.id,
        itemTitle: workItem.fields['System.Title'],
        itemType: workItem.fields['System.WorkItemType'],
        projectName,
        commentId: comment.id,
        commentHtml: comment.text,
        commentPreview: extractPreview(comment.text),
        mentionedBy: {
          displayName: comment.createdBy.displayName,
          uniqueName: comment.createdBy.uniqueName,
          imageUrl: comment.createdBy.imageUrl,
        },
        timestamp: comment.createdDate,
        url: buildWorkItemCommentUrl(apiClient.orgUrl, projectName, workItem.id, comment.id),
      });
    }
  }

  return mentions;
}

/**
 * Detects work item mentions using the WIQL @recentMentions macro.
 *
 * This is the primary detection strategy. The @recentMentions macro
 * returns work items where the current user was mentioned in the last 30 days.
 */
export async function detectWorkItemMentions(apiClient) {
  // Get current user for mention matching
  const currentUser = await apiClient.getCurrentUser();

  // Query for work items where user was mentioned
  const wiql = `
    SELECT [System.Id], [System.Title], [System.TeamProject], [System.ChangedDate], [System.WorkItemType]
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

  // Handle batching if more than max per request
  const allWorkItems = [];
  for (let i = 0; i < workItemIds.length; i += API_CONFIG.maxWorkItemsPerBatch) {
    const batchIds = workItemIds.slice(i, i + API_CONFIG.maxWorkItemsPerBatch);
    const batchItems = await apiClient.getWorkItems(batchIds, [
      'System.Id',
      'System.Title',
      'System.TeamProject',
      'System.ChangedDate',
      'System.WorkItemType',
    ]);
    allWorkItems.push(...batchItems);
  }

  // Extract mentions from each work item's comments
  const allMentions = [];
  for (const workItem of allWorkItems) {
    try {
      const mentions = await extractMentionsFromWorkItem(apiClient, workItem, currentUser);
      allMentions.push(...mentions);
    } catch (error) {
      // Log but continue with other work items
      console.error(`Error extracting mentions from work item ${workItem.id}:`, error);
    }
  }

  return allMentions;
}

/**
 * Detects PR mentions. (STUB - not implemented in Phase 1)
 */
export async function detectPRMentions(apiClient) {
  // STUB: Return empty array for Phase 1
  // Future implementation will:
  // 1. Query PRs where user is reviewer or author
  // 2. For each PR, get comment threads
  // 3. Parse threads for mentions
  console.log('PR mention detection not yet implemented');
  return [];
}

/**
 * Main detection function - detects all mentions for an organization.
 *
 * @param {AdoApiClient} apiClient - Authenticated API client
 * @param {Object} options - Detection options
 * @param {boolean} [options.includeWorkItems=true] - Include work item mentions
 * @param {boolean} [options.includePRs=false] - Include PR mentions (stubbed)
 * @returns {Promise<Mention[]>} Array of normalized mention records
 */
export async function detectMentions(apiClient, options = {}) {
  const {
    includeWorkItems = true,
    includePRs = false,
  } = options;

  const allMentions = [];

  if (includeWorkItems) {
    const wiMentions = await detectWorkItemMentions(apiClient);
    allMentions.push(...wiMentions);
  }

  if (includePRs) {
    const prMentions = await detectPRMentions(apiClient);
    allMentions.push(...prMentions);
  }

  // Deduplicate by ID (safety measure)
  const seen = new Set();
  return allMentions.filter(m => {
    if (seen.has(m.id)) {
      return false;
    }
    seen.add(m.id);
    return true;
  });
}
