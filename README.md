# ADO Notifications

A browser extension that notifies you of @mentions and assignments in Azure DevOps work items and pull requests.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Edge](https://img.shields.io/badge/Edge-Compatible-green)
![Chrome](https://img.shields.io/badge/Chrome-Compatible-green)

## Features

- **Work item @mentions** - Notifications when someone @mentions you in work item comments
- **Work item assignments** - Notifications when work items are assigned to you
- **Pull request @mentions** - Notifications when someone @mentions you in PR comments (overview or file-level)
- **Pull request reviewer assignments** - Notifications when you're added as a PR reviewer
- **Badge notifications** - Unread notification count displayed on the extension icon
- **Browser notifications** - Optional push notifications for new items (opt-in)
- **Multi-organization support** - Monitor multiple Azure DevOps organizations
- **Read tracking** - Mark items as read; state persists across sessions
- **Reply detection** - See when you've already replied to a mention
- **Content script integration** - Automatically refreshes when you post comments in ADO
- **Secure credential storage** - PATs encrypted with AES-256-GCM

## Installation

### From Source (Developer Mode)

1. Clone this repository:

   ```bash
   git clone https://github.com/ohjf4ee/extension-oh-ado-notifications.git
   ```

2. Open your browser's extension management page:
   - **Edge**: `edge://extensions`
   - **Chrome**: `chrome://extensions`

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the cloned repository folder

5. The extension icon will appear in your toolbar

## Setup

1. Click the extension icon to open the popup
2. Click the **Settings** (gear) icon
3. Click **+ Add Organization**
4. Enter your Azure DevOps organization URL (e.g., `https://dev.azure.com/myorg` or just `myorg`)
5. Create a Personal Access Token (PAT) with these scopes:
   - **Work Items: Read** - Required for work item mentions and assignments
   - **Code: Read** - Required for pull request mentions and reviewer assignments
   - Click the "Create a PAT" link for quick access to the token creation page
6. Paste your PAT and check the consent box
7. Click **Save**

The extension will begin polling for notifications immediately.

## How It Works

### Work Items

- Uses Azure DevOps' WIQL `@recentMentions` macro to find work items where you've been mentioned in the last 30 days
- Queries for work items assigned to you that changed recently
- Fetches comments to identify specific @mentions of your user account

### Pull Requests

- Scans PRs where you are a reviewer or author
- Checks comment threads for @mentions in both overview and file-level comments
- Detects when you've been added as a reviewer

### Polling

- Default poll interval: **5 minutes** (configurable per organization)
- Minimum interval: **1 minute**
- Automatic backoff after consecutive failures
- Respects ADO rate limits with automatic retry handling

### Rate Limiting & Throttling

Azure DevOps enforces rate limits (200 TSTUs per 5-minute window). The extension handles this as follows:

**Current behavior:**

- Honors `Retry-After` headers from ADO API responses
- Implements a circuit breaker: after 3 consecutive failures, the extension enters a 15-minute backoff period
- Skips polling for an organization if it's currently rate-limited

**How you might notice throttling:**

- Errors displayed in the Settings page for affected organizations
- Delayed updates (mentions not appearing immediately)
- "Rate limited" messages in the browser console (DevTools)

**Known limitations:**

- PR mention detection iterates through all projects sequentially, which may be slow for organizations with many projects
- Work item batch fetches are sequential to avoid overwhelming the API

**Future improvements (infrastructure exists but not yet active):**

- Automatic retry with exponential backoff for transient failures
- Parallel project iteration with rate limit awareness

### Content Script

A content script runs on Azure DevOps pages to detect when you post comments, triggering an immediate refresh so mentions you've replied to update their status.

## Privacy & Security

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

- **PATs are encrypted** using AES-256-GCM with PBKDF2 key derivation before storage
- **Data stays local** - All data is stored in your browser's local storage
- **No external servers** - The extension only communicates with Azure DevOps APIs
- **Minimal permissions** - Only requests the permissions necessary to function

### Required Permissions

| Permission | Purpose |
| ---------- | ------- |
| `storage` | Store encrypted credentials and notification history |
| `alarms` | Schedule periodic polling |
| `notifications` | Display browser notifications (optional feature) |
| `host_permissions` | Access Azure DevOps APIs |

## Development

### Project Structure

```text
├── manifest.json               # Extension manifest (MV3)
├── background.js               # Service worker entry point
├── src/
│   ├── config.js               # Configuration constants
│   ├── storage.js              # Encrypted storage module
│   ├── ado/
│   │   ├── api-client.js       # Azure DevOps REST API client
│   │   └── mentions.js         # Mention/assignment detection logic
│   ├── background/
│   │   ├── index.js            # Background service initialization
│   │   ├── polling.js          # Polling scheduler
│   │   ├── messages.js         # Message handling
│   │   ├── notifications.js    # Badge and push notifications
│   │   └── state.js            # State management
│   ├── content/
│   │   └── comment-observer.js # DOM observer for comment submissions
│   └── ui/
│       ├── popup.html          # Popup UI markup
│       ├── popup.css           # Popup styles
│       └── popup.js            # Popup logic
├── icons/                      # Extension icons
└── design/                     # Architecture documentation
```

### Building

No build step required. The extension runs directly from source.

### Testing Locally

1. Load the extension in developer mode (see Installation)
2. Make changes to the source files
3. Click the refresh icon on the extension card in `edge://extensions`
4. Test your changes

## Troubleshooting

### "Authentication failed" error

- Verify your PAT has not expired
- Ensure the PAT has **Work Items: Read** and **Code: Read** scopes
- Check that the organization URL is correct

### No notifications appearing

- Confirm you have been @mentioned or assigned a work item/PR recently
- Click the refresh button to force an immediate poll
- Check the browser console for errors (right-click extension icon → Inspect)

### Extension not polling

- Check that the organization is enabled in Settings
- The service worker may have been suspended; clicking the extension icon will wake it

### PR mentions not detected

- Ensure your PAT has the **Code: Read** scope
- PR mentions are only detected for PRs where you are a reviewer or author

## License

This project is not yet licensed. All rights reserved.

## Acknowledgments

- Built for use with [Azure DevOps](https://azure.microsoft.com/en-us/products/devops)
- Uses the [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
