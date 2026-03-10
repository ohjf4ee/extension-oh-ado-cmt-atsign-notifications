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
  // Format can be either:
  //   data-vss-mention="version:2.0,{guid}" (newer format)
  //   data-vss-mention="version:2.0,id:{guid}" (older format with id: prefix)
  const mentionPattern = /data-vss-mention="version:[^,]*,(?:id:)?([^"]+)"/gi;
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
 * Builds a URL to a pull request or PR comment.
 *
 * @param {string} orgUrl - Organization URL
 * @param {string} projectName - Project name
 * @param {string} repositoryName - Repository name
 * @param {number} pullRequestId - Pull request ID
 * @param {Object} [options] - URL options
 * @param {string} [options.filePath] - File path for file comments
 * @param {boolean} [options.isOverview] - Whether to link to overview tab
 */
export function buildPRCommentUrl(orgUrl, projectName, repositoryName, pullRequestId, options = {}) {
  const project = encodeURIComponent(projectName);
  const repo = encodeURIComponent(repositoryName);
  let url = `${orgUrl}/${project}/_git/${repo}/pullrequest/${pullRequestId}`;

  if (options.filePath) {
    url += `?_a=files&path=${encodeURIComponent(options.filePath)}`;
  } else if (options.isOverview) {
    url += '?_a=overview';
  }

  return url;
}

/**
 * Checks if a comment was created by the current user.
 */
function isCommentByUser(comment, currentUser) {
  if (!comment.createdBy) return false;

  // Check by user ID
  if (comment.createdBy.id === currentUser.id) return true;

  // Check by uniqueName (email)
  if (currentUser.emailAddress &&
      comment.createdBy.uniqueName?.toLowerCase() === currentUser.emailAddress.toLowerCase()) {
    return true;
  }

  return false;
}

/**
 * Extracts mentions from a work item's comments.
 */
async function extractMentionsFromWorkItem(apiClient, workItem, currentUser) {
  const projectName = workItem.fields['System.TeamProject'];
  const comments = await apiClient.getWorkItemComments(projectName, workItem.id);
  const mentions = [];

  for (const comment of comments) {
    if (!commentMentionsUser(comment.text, currentUser)) continue;

    const mentionTimestamp = new Date(comment.createdDate).getTime();

    // Find the user's first comment after this mention (chronologically next)
    let userCommentedAfter = false;
    let userReplyPreview = null;
    let earliestReplyTime = Infinity;
    for (const c of comments) {
      const isUserComment = isCommentByUser(c, currentUser);
      const commentTime = new Date(c.createdDate).getTime();
      const isAfter = commentTime > mentionTimestamp;
      if (isUserComment && isAfter && commentTime < earliestReplyTime) {
        userCommentedAfter = true;
        earliestReplyTime = commentTime;
        userReplyPreview = extractPreview(c.text, 200);
      }
    }

    mentions.push({
      id: createMentionId(apiClient.orgUrl, 'workitem', workItem.id, comment.id),
      orgUrl: apiClient.orgUrl,
      orgName: apiClient.orgName,
      type: 'workitem',
      subtype: 'mention',
      itemId: workItem.id,
      itemTitle: workItem.fields['System.Title'],
      itemType: workItem.fields['System.WorkItemType'],
      projectName,
      repositoryName: null,
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
      userCommentedAfter,
      userReplyPreview,
    });
  }

  return mentions;
}

/**
 * Detects work item mentions using the WIQL @recentMentions macro.
 *
 * This is the primary detection strategy. The @recentMentions macro
 * returns work items where the current user was mentioned in the last 30 days.
 *
 * @param {AdoApiClient} apiClient - Authenticated API client
 * @param {Object} currentUser - Current user info from apiClient.getCurrentUser()
 */
export async function detectWorkItemMentions(apiClient, currentUser) {
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
  const warnings = [];
  for (const workItem of allWorkItems) {
    try {
      const mentions = await extractMentionsFromWorkItem(apiClient, workItem, currentUser);
      allMentions.push(...mentions);
    } catch (error) {
      // Log but continue with other work items
      console.error(`Error extracting mentions from work item ${workItem.id}:`, error);
      warnings.push(`Work item #${workItem.id}: ${error.message || 'fetch failed'}`);
    }
  }

  return { mentions: allMentions, warnings };
}

/**
 * Detects work items assigned to the current user.
 *
 * @param {AdoApiClient} apiClient - Authenticated API client
 * @param {Object} currentUser - Current user info from apiClient.getCurrentUser()
 * @param {string|null} lastCheckTime - ISO timestamp of last check (null for first run)
 * @returns {Promise<{assignments: Array, warnings: string[]}>} Assignment notification records with warnings
 */
export async function detectWorkItemAssignments(apiClient, currentUser, lastCheckTime = null) {
  // Build the date filter clause
  // WIQL only accepts date-only values (no time), so convert ISO timestamp to date
  let sinceClause;
  if (lastCheckTime) {
    // Extract just the date portion (YYYY-MM-DD) from ISO timestamp
    const dateOnly = lastCheckTime.split('T')[0];
    sinceClause = `AND [System.ChangedDate] >= '${dateOnly}'`;
  } else {
    // On first run, look back 2 days
    sinceClause = `AND [System.ChangedDate] >= @Today - 2`;
  }

  const wiql = `
    SELECT [System.Id], [System.Title], [System.TeamProject],
           [System.AssignedTo], [System.ChangedDate], [System.WorkItemType],
           [System.ChangedBy]
    FROM workitems
    WHERE [System.AssignedTo] = @Me
      ${sinceClause}
    ORDER BY [System.ChangedDate] DESC
  `;

  const warnings = [];
  let workItemRefs;
  try {
    workItemRefs = await apiClient.executeWiql(wiql);
  } catch (error) {
    console.error('Error querying assigned work items:', error);
    warnings.push(`Assignment query failed: ${error.message || 'WIQL error'}`);
    return { assignments: [], warnings };
  }

  if (workItemRefs.length === 0) {
    return { assignments: [], warnings };
  }

  // Batch fetch work item details
  const workItemIds = workItemRefs.map(wi => wi.id);
  const allWorkItems = [];

  for (let i = 0; i < workItemIds.length; i += API_CONFIG.maxWorkItemsPerBatch) {
    const batchIds = workItemIds.slice(i, i + API_CONFIG.maxWorkItemsPerBatch);
    try {
      const batchItems = await apiClient.getWorkItems(batchIds, [
        'System.Id',
        'System.Title',
        'System.TeamProject',
        'System.AssignedTo',
        'System.ChangedDate',
        'System.WorkItemType',
        'System.ChangedBy',
      ]);
      allWorkItems.push(...batchItems);
    } catch (error) {
      console.error(`Error fetching assignment batch starting at ${batchIds[0]}:`, error);
      warnings.push(`Assignment batch #${batchIds[0]}: ${error.message || 'fetch failed'}`);
    }
  }

  const assignments = [];

  for (const workItem of allWorkItems) {
    const projectName = workItem.fields['System.TeamProject'];
    const changedBy = workItem.fields['System.ChangedBy'];

    // Skip if the user assigned it to themselves
    if (changedBy?.uniqueName?.toLowerCase() === currentUser.emailAddress?.toLowerCase() ||
        changedBy?.id === currentUser.id) {
      continue;
    }

    assignments.push({
      id: createMentionId(apiClient.orgUrl, 'workitem', workItem.id, 'assignment'),
      orgUrl: apiClient.orgUrl,
      orgName: apiClient.orgName,
      type: 'workitem',
      subtype: 'assignment',
      itemId: workItem.id,
      itemTitle: workItem.fields['System.Title'],
      itemType: workItem.fields['System.WorkItemType'],
      projectName,
      repositoryName: null,
      commentId: null,
      commentHtml: null,
      commentPreview: 'You were assigned this work item',
      mentionedBy: changedBy ? {
        displayName: changedBy.displayName || 'Unknown',
        uniqueName: changedBy.uniqueName || '',
        imageUrl: changedBy.imageUrl || null,
      } : {
        displayName: 'Unknown',
        uniqueName: '',
        imageUrl: null,
      },
      timestamp: workItem.fields['System.ChangedDate'],
      url: buildWorkItemCommentUrl(apiClient.orgUrl, projectName, workItem.id, null),
      userCommentedAfter: false,
      userReplyPreview: null,
    });
  }

  return { assignments, warnings };
}

/**
 * Extracts mentions from a single PR's comment threads.
 */
async function extractMentionsFromPR(apiClient, pr, currentUser, threadCache, cutoffTime) {
  const mentions = [];
  const projectName = pr.repository.project.name;
  const repositoryName = pr.repository.name;
  const repositoryId = pr.repository.id;
  const cachedMaxDate = threadCache[pr.pullRequestId] || null;

  let threads;
  try {
    threads = await apiClient.getPullRequestThreads(projectName, repositoryId, pr.pullRequestId);
  } catch (error) {
    console.error(`Error fetching threads for PR ${pr.pullRequestId}:`, error);
    return {
      mentions: [],
      maxDate: cachedMaxDate,
      warning: `PR #${pr.pullRequestId}: ${error.message || 'thread fetch failed'}`,
    };
  }

  let newMaxDate = cachedMaxDate;

  for (const thread of threads) {
    // Skip system threads (status changes, etc.)
    if (thread.isDeleted) continue;

    const threadLastUpdated = thread.lastUpdatedDate;

    // Track the max date for cache update
    if (!newMaxDate || threadLastUpdated > newMaxDate) {
      newMaxDate = threadLastUpdated;
    }

    // Skip threads older than our cache timestamp (optimization)
    if (cachedMaxDate && threadLastUpdated <= cachedMaxDate) {
      continue;
    }

    // Also skip threads older than cutoff time
    if (cutoffTime && new Date(threadLastUpdated).getTime() < cutoffTime) {
      continue;
    }

    const comments = thread.comments || [];

    for (const comment of comments) {
      // Skip deleted or system comments
      if (comment.isDeleted || comment.commentType === 'system') continue;

      // Check if this comment mentions the current user
      if (!commentMentionsUser(comment.content, currentUser)) continue;

      const mentionTimestamp = new Date(comment.publishedDate).getTime();

      // Find user's first reply after this mention
      let userCommentedAfter = false;
      let userReplyPreview = null;
      let earliestReplyTime = Infinity;

      for (const c of comments) {
        if (c.isDeleted || c.commentType === 'system') continue;
        const isUserComment = c.author?.id === currentUser.id ||
          c.author?.uniqueName?.toLowerCase() === currentUser.emailAddress?.toLowerCase();
        const commentTime = new Date(c.publishedDate).getTime();
        const isAfter = commentTime > mentionTimestamp;

        if (isUserComment && isAfter && commentTime < earliestReplyTime) {
          userCommentedAfter = true;
          earliestReplyTime = commentTime;
          userReplyPreview = extractPreview(c.content, 200);
        }
      }

      // Determine if this is a file comment
      const filePath = thread.threadContext?.filePath || null;
      const itemType = filePath ? 'PR File Comment' : 'PR Comment';

      mentions.push({
        id: createMentionId(apiClient.orgUrl, 'pullrequest', pr.pullRequestId, comment.id),
        orgUrl: apiClient.orgUrl,
        orgName: apiClient.orgName,
        type: 'pullrequest',
        subtype: 'mention',
        itemId: pr.pullRequestId,
        itemTitle: pr.title,
        itemType,
        projectName,
        repositoryName,
        commentId: comment.id,
        commentHtml: comment.content,
        commentPreview: extractPreview(comment.content),
        mentionedBy: {
          displayName: comment.author?.displayName || 'Unknown',
          uniqueName: comment.author?.uniqueName || '',
          imageUrl: comment.author?.imageUrl || null,
        },
        timestamp: comment.publishedDate,
        url: buildPRCommentUrl(apiClient.orgUrl, projectName, repositoryName, pr.pullRequestId, {
          filePath,
          isOverview: !filePath,
        }),
        userCommentedAfter,
        userReplyPreview,
      });
    }
  }

  return { mentions, maxDate: newMaxDate, warning: null };
}

/**
 * Checks if user is a reviewer on a PR and creates a partial notification object.
 * Returns null if user is not a reviewer or shouldn't be notified.
 * Caller must set id, orgUrl, orgName, and url fields.
 */
function checkReviewerAssignment(pr, currentUser, cutoffTime) {
  // Check if the PR was created after our cutoff
  const prCreatedTime = new Date(pr.creationDate).getTime();
  if (cutoffTime && prCreatedTime < cutoffTime) {
    return null;
  }

  // Find the user's reviewer entry (if any)
  const reviewers = pr.reviewers || [];
  const userReviewerEntry = reviewers.find(r =>
    r.id === currentUser.id ||
    r.uniqueName?.toLowerCase() === currentUser.emailAddress?.toLowerCase()
  );

  if (!userReviewerEntry) {
    return null;
  }

  // Skip if user is the PR author (they wouldn't add themselves as reviewer normally)
  if (pr.createdBy?.id === currentUser.id ||
      pr.createdBy?.uniqueName?.toLowerCase() === currentUser.emailAddress?.toLowerCase()) {
    return null;
  }

  const projectName = pr.repository.project.name;
  const repositoryName = pr.repository.name;
  const isRequired = userReviewerEntry.isRequired === true;
  const reviewerType = isRequired ? 'a required reviewer' : 'an optional reviewer';

  // Return partial object - caller will set id, orgUrl, orgName, and url
  return {
    type: 'pullrequest',
    subtype: 'assignment',
    itemId: pr.pullRequestId,
    itemTitle: pr.title,
    itemType: 'Pull Request',
    projectName,
    repositoryName,
    commentId: null,
    commentHtml: null,
    commentPreview: `You were added as ${reviewerType}`,
    mentionedBy: {
      displayName: pr.createdBy?.displayName || 'Unknown',
      uniqueName: pr.createdBy?.uniqueName || '',
      imageUrl: pr.createdBy?.imageUrl || null,
    },
    timestamp: pr.creationDate,
    userCommentedAfter: false,
    userReplyPreview: null,
  };
}

/**
 * Detects PR mentions and reviewer assignments.
 *
 * @param {AdoApiClient} apiClient - Authenticated API client
 * @param {Object} currentUser - Current user info from apiClient.getCurrentUser()
 * @param {Object} options - Detection options
 * @param {number} [options.lookbackMs] - Lookback time in ms for first run (default 2 days)
 * @param {string|null} [options.lastPRPollTime] - ISO timestamp of last PR poll
 * @param {Object} [options.threadCache] - { prId: maxLastUpdatedDate } map
 * @param {boolean} [options.includeReviewerAssignments] - Include reviewer assignment notifications
 * @returns {Promise<{mentions: Array, newLastPollTime: string, newThreadCache: Object}>}
 */
export async function detectPRMentions(apiClient, currentUser, options = {}) {
  const {
    lookbackMs = 7 * 24 * 60 * 60 * 1000, // 7 days
    lastPRPollTime = null,
    threadCache = {},
    includeReviewerAssignments = true,
  } = options;

  // Determine cutoff time
  let cutoffTime;
  if (lastPRPollTime) {
    cutoffTime = new Date(lastPRPollTime).getTime();
  } else {
    cutoffTime = Date.now() - lookbackMs;
  }

  // Get all projects
  let projects;
  const warnings = [];
  try {
    projects = await apiClient.listProjects();
  } catch (error) {
    console.error('Error listing projects:', error);
    warnings.push(`Failed to list projects: ${error.message || 'API error'}`);
    return { mentions: [], newLastPollTime: new Date().toISOString(), newThreadCache: threadCache, warnings };
  }

  const allMentions = [];
  const newThreadCache = { ...threadCache };
  const seenPRIds = new Set();

  // TODO: Projects are processed sequentially to avoid overwhelming the API.
  // For organizations with many projects, this may be slow. Consider:
  // 1. Parallel processing with concurrency limit (e.g., 3 projects at a time)
  // 2. Caching project list and only checking projects with recent PR activity
  // 3. Using a cross-project PR search if ADO API supports it
  for (const project of projects) {
    try {
      // Get PRs where user is a reviewer
      const reviewerPRs = await apiClient.getPullRequests(project.name, {
        reviewerId: currentUser.id,
        status: 'active',
      });

      // Get PRs where user is the author (to check for mentions in their own PRs)
      const authorPRs = await apiClient.getPullRequests(project.name, {
        creatorId: currentUser.id,
        status: 'active',
      });

      // Combine and dedupe PRs
      const prMap = new Map();
      for (const pr of [...reviewerPRs, ...authorPRs]) {
        prMap.set(pr.pullRequestId, pr);
      }

      for (const pr of prMap.values()) {
        seenPRIds.add(pr.pullRequestId);

        // Extract @mentions from PR threads
        const result = await extractMentionsFromPR(
          apiClient,
          pr,
          currentUser,
          threadCache,
          cutoffTime
        );

        allMentions.push(...result.mentions);

        // Collect warning if thread fetch failed
        if (result.warning) {
          warnings.push(result.warning);
        }

        // Update thread cache with new max date
        if (result.maxDate) {
          newThreadCache[pr.pullRequestId] = result.maxDate;
        }

        // Check for reviewer assignment
        if (includeReviewerAssignments) {
          const reviewerMention = checkReviewerAssignment(pr, currentUser, cutoffTime);
          if (reviewerMention) {
            // Complete the partial object with org-specific fields
            reviewerMention.id = createMentionId(apiClient.orgUrl, 'pullrequest', pr.pullRequestId, 'reviewer');
            reviewerMention.orgUrl = apiClient.orgUrl;
            reviewerMention.orgName = apiClient.orgName;
            reviewerMention.url = buildPRCommentUrl(
              apiClient.orgUrl,
              reviewerMention.projectName,
              reviewerMention.repositoryName,
              pr.pullRequestId,
              { isOverview: true }
            );
            allMentions.push(reviewerMention);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing PRs for project ${project.name}:`, error);
      warnings.push(`Project ${project.name}: ${error.message || 'PR fetch failed'}`);
    }
  }

  // Clean up thread cache - remove entries for PRs not seen in this run
  // (they may have been completed/abandoned)
  for (const prId of Object.keys(newThreadCache)) {
    if (!seenPRIds.has(parseInt(prId, 10))) {
      delete newThreadCache[prId];
    }
  }

  return {
    mentions: allMentions,
    newLastPollTime: new Date().toISOString(),
    newThreadCache,
    warnings,
  };
}

/**
 * Main detection function - detects all mentions for an organization.
 *
 * @param {AdoApiClient} apiClient - Authenticated API client
 * @param {Object} options - Detection options
 * @param {boolean} [options.includeWorkItems=true] - Include work item mentions
 * @param {boolean} [options.includePRs=true] - Include PR mentions
 * @param {boolean} [options.includeAssignments=true] - Include assignments
 * @param {string|null} [options.lastPRPollTime] - ISO timestamp of last PR poll
 * @param {Object} [options.prThreadCache] - PR thread cache
 * @param {string|null} [options.lastAssignmentCheckTime] - ISO timestamp of last assignment check
 * @returns {Promise<{mentions: Mention[], prResult: Object|null, warnings: string[]}>}
 */
export async function detectMentions(apiClient, options = {}) {
  const {
    includeWorkItems = true,
    includePRs = true,
    includeAssignments = true,
    lastPRPollTime = null,
    prThreadCache = {},
    lastAssignmentCheckTime = null,
  } = options;

  // Get current user once and pass to all detection functions
  const currentUser = await apiClient.getCurrentUser();

  const allMentions = [];
  const allWarnings = [];
  let prResult = null;

  // Work item @mentions (uses @recentMentions WIQL)
  if (includeWorkItems) {
    const wiResult = await detectWorkItemMentions(apiClient, currentUser);
    allMentions.push(...wiResult.mentions);
    allWarnings.push(...wiResult.warnings);
  }

  // Work item assignments
  if (includeAssignments) {
    const assignResult = await detectWorkItemAssignments(apiClient, currentUser, lastAssignmentCheckTime);
    allMentions.push(...assignResult.assignments);
    allWarnings.push(...assignResult.warnings);
  }

  // PR @mentions and reviewer assignments
  if (includePRs) {
    prResult = await detectPRMentions(apiClient, currentUser, {
      lastPRPollTime,
      threadCache: prThreadCache,
      includeReviewerAssignments: includeAssignments,
    });
    allMentions.push(...prResult.mentions);
    allWarnings.push(...prResult.warnings);
  }

  // Deduplicate by ID (safety measure)
  const seen = new Set();
  const dedupedMentions = allMentions.filter(m => {
    if (seen.has(m.id)) {
      return false;
    }
    seen.add(m.id);
    return true;
  });

  return {
    mentions: dedupedMentions,
    prResult,
    warnings: allWarnings,
  };
}
