# ADO @ Mention Notifications Extension - Overview

## Purpose

An Edge browser extension that monitors Azure DevOps for @ mentions of the current user and provides timely notifications.

## Requirements

### Functional Requirements

1. **Mention Detection**
   - Detect @ mentions in work item comments (via WIQL `@recentMentions`)
   - Detect @ mentions in pull request comments (future phase)
   - Detect @ mentions in file/commit comments (future phase)
   - Monitor ADO pages user is viewing for real-time detection (content script)

2. **Notification**
   - Badge count on extension icon (always enabled)
   - Browser push notifications (opt-in)
   - Popup panel showing list of mentions when icon clicked

3. **Multi-Organization Support**
   - Configure multiple ADO organizations
   - Separate PAT per organization
   - Unified mention list across all orgs

4. **Read State Tracking**
   - Track which mentions have been seen/acknowledged
   - Persist read state locally
   - Badge shows unread count only

5. **API Respect**
   - Throttle polling to respect ADO rate limits
   - Adaptive polling intervals based on activity
   - Honor `Retry-After` headers

### Non-Functional Requirements

- Online-only (no offline caching required)
- Manifest V3 compliant
- Encrypted PAT storage

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser Extension                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────┐       ┌─────────────────────────────┐    │
│  │   Background         │       │   Content Script            │    │
│  │   Service Worker     │◄─────►│   (ADO page monitoring)     │    │
│  │   (03-background)    │       │   (part of 02-detection)    │    │
│  └──────────┬───────────┘       └─────────────────────────────┘    │
│             │                                                       │
│             ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              Mention Detection Module                     │      │
│  │              (02-mention-detection)                       │      │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │      │
│  │  │ WIQL        │ │ PR Thread   │ │ Content Script      │ │      │
│  │  │ @recent     │ │ Scanner     │ │ DOM Observer        │ │      │
│  │  │ Mentions    │ │ (stub)      │ │ (stub)              │ │      │
│  │  └─────────────┘ └─────────────┘ └─────────────────────┘ │      │
│  └──────────────────────────┬───────────────────────────────┘      │
│                             │                                       │
│                             ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              ADO API Client Module                        │      │
│  │              (01-ado-api)                                 │      │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │      │
│  │  │ Auth        │ │ Rate        │ │ REST API            │ │      │
│  │  │ (PAT)       │ │ Limiting    │ │ Wrappers            │ │      │
│  │  └─────────────┘ └─────────────┘ └─────────────────────┘ │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                     │
│  ┌──────────────────────┐       ┌─────────────────────────────┐    │
│  │   Popup UI           │       │   Storage                   │    │
│  │   (04-popup-ui)      │       │   (encrypted PATs,          │    │
│  │                      │       │    mention state, prefs)    │    │
│  └──────────────────────┘       └─────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module Dependencies

```
04-popup-ui
    │
    ├──► Storage (read mentions, prefs)
    └──► Background Service (trigger refresh)

03-background-service
    │
    ├──► 02-mention-detection (poll for mentions)
    ├──► Storage (read/write state)
    └──► Chrome APIs (alarms, notifications, badge)

02-mention-detection
    │
    ├──► 01-ado-api (make API calls)
    └──► Storage (org configs)

01-ado-api
    │
    └──► Storage (PATs, org URLs)
```

---

## Design Documents

| Document | Module | Description |
|----------|--------|-------------|
| [01-ado-api.md](01-ado-api.md) | ADO API Client | Authentication, rate limiting, REST wrappers |
| [02-mention-detection.md](02-mention-detection.md) | Mention Detection | WIQL queries, PR scanning, DOM observation |
| [03-background-service.md](03-background-service.md) | Background Service | Polling scheduler, badge, notifications |
| [04-popup-ui.md](04-popup-ui.md) | Popup UI | Mention list, config panel, settings |

---

## Implementation Phases

### Phase 1: MVP - Work Item Mentions

**Goal**: Detect @ mentions in work item comments via WIQL `@recentMentions`

- [ ] Storage module (encrypted PAT, org config)
- [ ] ADO API client (auth, basic WIQL)
- [ ] WIQL `@recentMentions` detection
- [ ] Background polling with chrome.alarms
- [ ] Badge count updates
- [ ] Basic popup with mention list
- [ ] Single organization support

### Phase 2: Multi-Org & Polish

- [ ] Multi-organization configuration
- [ ] Read/unread state tracking
- [ ] Browser push notifications (opt-in)
- [ ] Adaptive polling intervals
- [ ] Rate limit handling with backoff

### Phase 3: PR Mentions (Stub → Implementation)

- [ ] PR thread scanning for mentions
- [ ] PRs where user is reviewer/author

### Phase 4: Content Script Enhancement (Stub → Implementation)

- [ ] DOM observation on active ADO pages
- [ ] Real-time mention detection
- [ ] File/commit comment detection

---

## Key Technical Decisions

### 1. WIQL `@recentMentions` as Primary Source

Azure DevOps provides a built-in WIQL macro that returns work items where the current user was mentioned in the last 30 days. This is the most efficient and reliable method.

```sql
SELECT [System.Id] FROM workitems
WHERE [System.Id] IN (@recentMentions)
ORDER BY [System.ChangedDate] DESC
```

### 2. Manifest V3

Using Manifest V3 for future compatibility. Key implications:
- Service worker instead of persistent background page
- Service worker terminates after ~30s of inactivity
- Must use chrome.alarms for scheduling (min 30s interval)
- State must be persisted to chrome.storage

### 3. Stub Architecture for Future Features

PR mentions and content script detection are designed into the architecture but implemented as stubs initially. This allows:
- Clean interfaces defined upfront
- Easy to add functionality later
- No refactoring needed when expanding scope

### 4. Encrypted PAT Storage

Following the pattern from the Kronos extension:
- AES-256-GCM encryption
- PBKDF2 key derivation
- PATs never stored in plaintext

---

## Data Model Summary

See individual module docs for detailed schemas.

**Key entities:**
- `OrgConfig` - Organization URL, encrypted PAT, settings
- `Mention` - Individual mention record with metadata
- `MentionState` - Read/unread tracking

---

## File Structure (Planned)

```
extension-oh-ado-cmt-atsign-notifications/
├── design/
│   ├── 00-overview.md          (this file)
│   ├── 01-ado-api.md
│   ├── 02-mention-detection.md
│   ├── 03-background-service.md
│   └── 04-popup-ui.md
├── src/
│   ├── config.js               Constants, storage keys
│   ├── storage.js              Encrypted storage wrapper
│   ├── ado/
│   │   ├── api-client.js       ADO REST API client
│   │   ├── mentions.js         Mention detection logic
│   │   └── index.js            Module exports
│   ├── background/
│   │   ├── polling.js          Poll scheduler
│   │   ├── notifications.js    Badge & push notifications
│   │   └── index.js            Service worker entry
│   └── ui/
│       ├── popup.html
│       ├── popup.js
│       ├── config-panel.js
│       └── mention-list.js
├── icons/
├── manifest.json
├── background.js               Service worker entry point
├── contentScript.js            Content script entry point
└── README.md
```

---

## References

- [WIQL @recentMentions macro](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax?view=azure-devops#macros)
- [ADO Rate Limits](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops)
- [Manifest V3 Migration](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [chrome.alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
