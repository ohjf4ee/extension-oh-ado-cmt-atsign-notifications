/**
 * Background service state management.
 *
 * Re-exports storage functions and adds background-specific helpers.
 */

export {
  loadState,
  saveOrganizations,
  saveMentions,
  saveReadIds,
  updateLastPoll,
  savePreferences,
  saveCurrentUser,
  getDecryptedPat,
  addOrganization,
  updateOrganization,
  removeOrganization,
  clearAllData,
  // PR poll state
  getLastPRPoll,
  updateLastPRPoll,
  getPRThreadCache,
  updatePRThreadCache,
  savePRThreadCache,
  clearPRThreadCache,
  // Assignment check state
  getLastAssignmentCheck,
  updateLastAssignmentCheck,
} from '../storage.js';

import { loadState, saveMentions } from '../storage.js';
import { API_CONFIG } from '../config.js';

/**
 * Merges new mentions with existing mentions.
 *
 * @param {Mention[]} existing - Existing mentions array (mutated)
 * @param {Mention[]} incoming - New mentions to merge
 * @returns {{ added: Mention[], updated: Mention[] }}
 */
export function mergeMentions(existing, incoming) {
  const existingById = new Map(existing.map(m => [m.id, m]));
  const added = [];
  const updated = [];

  for (const mention of incoming) {
    const existingMention = existingById.get(mention.id);

    if (!existingMention) {
      // New mention
      existing.push(mention);
      added.push(mention);
    } else {
      // Check if anything changed (timestamp, userCommentedAfter status, or reply preview)
      const timestampChanged = mention.timestamp > existingMention.timestamp;
      const userCommentedChanged = mention.userCommentedAfter !== existingMention.userCommentedAfter;
      const replyPreviewChanged = mention.userReplyPreview !== existingMention.userReplyPreview;

      if (timestampChanged || userCommentedChanged || replyPreviewChanged) {
        Object.assign(existingMention, mention);
        updated.push(existingMention);
      }
    }
  }

  // Sort by timestamp descending (newest first)
  existing.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limit to max mentions to prevent unbounded growth
  if (existing.length > API_CONFIG.maxMentionsToStore) {
    existing.length = API_CONFIG.maxMentionsToStore;
  }

  return { added, updated };
}

/**
 * Gets the count of unread mentions.
 */
export async function getUnreadCount() {
  const state = await loadState();
  return state.mentions.filter(m => !state.readIds.has(m.id)).length;
}
