/**
 * Content script that observes Azure DevOps pages for comment submissions.
 * When the user adds a comment, it notifies the background service to refresh mentions.
 */

const MESSAGE_TYPE_COMMENT_ADDED = 'COMMENT_ADDED';

/**
 * Debounce function to avoid multiple rapid triggers.
 */
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Notifies the background service that a comment was added.
 */
const notifyCommentAdded = debounce(() => {
  console.log('ADO Notifications: Comment activity detected, triggering refresh');
  chrome.runtime.sendMessage({ type: MESSAGE_TYPE_COMMENT_ADDED }).catch(() => {
    // Extension context may be invalidated, ignore
  });
}, 2000); // 2 second debounce to batch rapid changes

/**
 * Observes the DOM for comment submission indicators.
 * ADO uses various patterns for comment submission:
 * - Work items: Click on "Save" or Ctrl+Enter in comment box
 * - PRs: Click "Comment" or "Reply" buttons
 */
function setupObserver() {
  // Watch for network requests that indicate comment submission
  // by observing DOM changes that typically follow a successful comment post
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Look for new comment nodes being added
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Work item comments - look for new discussion items
        if (node.classList?.contains('discussion-item') ||
            node.classList?.contains('wit-comment') ||
            node.querySelector?.('.discussion-item, .wit-comment')) {
          notifyCommentAdded();
          return;
        }

        // PR comments - look for new comment threads or replies
        if (node.classList?.contains('vc-discussion-thread-comment') ||
            node.classList?.contains('repos-pr-comment') ||
            node.querySelector?.('.vc-discussion-thread-comment, .repos-pr-comment')) {
          notifyCommentAdded();
          return;
        }
      }
    }
  });

  // Observe the entire document for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Also listen for click events on comment submission buttons
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, [role="button"]');
    if (!target) return;

    const buttonText = target.textContent?.toLowerCase() || '';
    const ariaLabel = target.getAttribute('aria-label')?.toLowerCase() || '';

    // Check for common comment submission button patterns
    if (buttonText.includes('save') && buttonText.includes('comment') ||
        buttonText === 'comment' ||
        buttonText === 'reply' ||
        ariaLabel.includes('save comment') ||
        ariaLabel.includes('post comment') ||
        ariaLabel.includes('add comment')) {
      // Delay to allow the comment to be posted
      setTimeout(notifyCommentAdded, 1500);
    }
  }, true);

  // Listen for keyboard shortcuts (Ctrl+Enter is common for submitting comments)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      const activeEl = document.activeElement;
      // Check if we're in a comment input area
      if (activeEl?.closest('.discussion-input, .comment-input, [data-comment-input], .mentions-input-container')) {
        setTimeout(notifyCommentAdded, 1500);
      }
    }
  }, true);

  console.log('ADO Notifications: Comment observer initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupObserver);
} else {
  setupObserver();
}
