# Code Review Cleanup - Round 2

## Overview
Address remaining issues from code review, in priority order.

---

## Phase 1: High Priority - Data Cleanup Bug

### Task 1.1: Fix `removeOrganization` to clean PR storage keys
- **File**: [src/storage.js](src/storage.js)
- **Issue**: When removing an org, PR-related storage keys are not cleaned up
- **Action**: In `removeOrganization()`, also delete entries from:
  - `LAST_PR_POLL[orgUrl]`
  - `PR_THREAD_CACHE[orgUrl]`
  - `LAST_ASSIGNMENT_CHECK[orgUrl]`

---

## Phase 2: Medium Priority - Dead Code Removal

### Task 2.1: Remove `CURRENT_USERS` storage key (never written)
- **Files**:
  - [src/config.js](src/config.js) - Remove `CURRENT_USERS` from `STORAGE_KEYS`
  - [src/storage.js](src/storage.js) - Remove from `loadState()` fetching and return value
  - [src/storage.js](src/storage.js) - Remove cleanup in `removeOrganization()`

---

## Phase 3: Low Priority - Code Quality

### Task 3.1: Remove unused `ado/index.js` barrel export
- **File**: [src/ado/index.js](src/ado/index.js)
- **Action**: Delete the file entirely (no imports use it)

### Task 3.2: Fix content script hardcoded message type
- **File**: [src/content/comment-observer.js](src/content/comment-observer.js)
- **Issue**: Uses `'COMMENT_ADDED'` string literal instead of shared constant
- **Action**: Add a comment noting the intentional duplication (content scripts can't import ES modules in MV3), or investigate using a build step

### Task 3.3: Reduce verbose console.log statements
- **Files**: Multiple
- **Action**: Review and remove/consolidate verbose logs:
  - [api-client.js:265-268](src/ado/api-client.js) - Consolidate 4 error logs into 1
  - [polling.js](src/background/polling.js) - Keep error logs, consider removing routine "Polling..." logs
  - [notifications.js:39](src/background/notifications.js) - Remove or guard verbose badge update log

### Task 3.4: Extract duplicate reply detection logic (optional)
- **Files**: [src/ado/mentions.js](src/ado/mentions.js)
- **Issue**: Reply detection duplicated in `extractMentionsFromWorkItem()` and `extractMentionsFromPR()`
- **Action**: Consider extracting, but field differences make it awkward - may skip

---

## Phase 4: Documentation - Rate Limiting & Performance Notes

### Task 4.1: Add rate limiting / throttling section to README
- **File**: [README.md](README.md)
- **Action**: Add section about:
  - Current behavior (honors `Retry-After` headers)
  - Known limitations (sequential project iteration for PRs)
  - Future improvements placeholder (retry with backoff, parallel batching)
  - How users might notice throttling (errors in settings, delayed updates)

### Task 4.2: Add code comments about potential optimizations
- **Files**:
  - [src/ado/api-client.js](src/ado/api-client.js) - Note that `fetchWithRetry` exists but isn't used yet
  - [src/ado/mentions.js](src/ado/mentions.js) - Note about sequential project iteration

---

## Execution Order

1. Phase 1 - Fix data cleanup bug (Task 1.1)
2. Phase 2 - Remove dead code (Task 2.1)
3. Phase 3 - Code quality improvements (Tasks 3.1-3.3, skip 3.4)
4. Phase 4 - Documentation (Tasks 4.1-4.2)
5. Test extension loads and basic functionality works

---

## Files Modified (Summary)

| File | Changes |
|------|---------|
| src/storage.js | Clean PR storage on org removal; remove CURRENT_USERS |
| src/config.js | Remove CURRENT_USERS key |
| src/ado/index.js | Delete file |
| src/content/comment-observer.js | Add comment about intentional duplication |
| src/ado/api-client.js | Consolidate error logs; add optimization comment |
| src/background/polling.js | Reduce verbose logs |
| src/background/notifications.js | Remove verbose badge log |
| src/ado/mentions.js | Add optimization comment |
| README.md | Add rate limiting section |
