# ADO API Client Module

## Purpose

Provides a reusable, well-encapsulated client for interacting with Azure DevOps REST APIs. This module handles authentication, rate limiting, and provides clean wrappers for the specific API calls needed by this extension.

## Dependencies

- **Storage module** - For retrieving encrypted PATs and org configurations
- **No other extension modules** - This is a foundational layer

## Responsibilities

1. Authenticate requests using Personal Access Tokens (PAT)
2. Respect and handle API rate limits
3. Provide typed wrappers for required REST endpoints
4. Handle errors gracefully with meaningful messages

---

## Authentication

### PAT-Based Authentication

Azure DevOps REST APIs accept Basic authentication with a PAT:

```
Authorization: Basic base64(":PAT_TOKEN")
```

Note: The username portion is empty; only the PAT is used.

### Implementation

```javascript
// src/ado/api-client.js

class AdoApiClient {
  constructor(orgUrl, pat) {
    this.orgUrl = normalizeOrgUrl(orgUrl);
    this.authHeader = 'Basic ' + btoa(':' + pat);
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.orgUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    await this.handleRateLimit(response);

    if (!response.ok) {
      throw new AdoApiError(response.status, await response.text());
    }

    return response.json();
  }
}
```

### URL Normalization

```javascript
function normalizeOrgUrl(url) {
  // Handle various input formats:
  // - "myorg" → "https://dev.azure.com/myorg"
  // - "dev.azure.com/myorg" → "https://dev.azure.com/myorg"
  // - "https://dev.azure.com/myorg/" → "https://dev.azure.com/myorg"

  let normalized = url.trim();

  if (!normalized.includes('.')) {
    // Just an org name
    normalized = `https://dev.azure.com/${normalized}`;
  } else if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }

  // Remove trailing slash
  return normalized.replace(/\/$/, '');
}
```

---

## Rate Limiting

### ADO Rate Limit Behavior

- **Limit**: 200 TSTUs (Throughput Units) per 5-minute sliding window
- **Response Headers** (when throttled):
  - `Retry-After`: Seconds to wait before retrying
  - `X-RateLimit-Resource`: Which resource is limited
  - `X-RateLimit-Delay`: Milliseconds the request was delayed

### Implementation Strategy

```javascript
class AdoApiClient {
  constructor(orgUrl, pat) {
    // ...
    this.retryAfterUntil = 0; // Timestamp when we can retry
  }

  async handleRateLimit(response) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const waitSeconds = parseInt(retryAfter, 10);
      this.retryAfterUntil = Date.now() + (waitSeconds * 1000);
      console.warn(`ADO rate limited. Retry after ${waitSeconds}s`);
    }
  }

  isRateLimited() {
    return Date.now() < this.retryAfterUntil;
  }

  getRetryAfterMs() {
    return Math.max(0, this.retryAfterUntil - Date.now());
  }
}
```

### Exponential Backoff for Failures

```javascript
async fetchWithRetry(endpoint, options = {}, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check rate limit before attempting
    if (this.isRateLimited()) {
      await this.sleep(this.getRetryAfterMs());
    }

    try {
      return await this.fetch(endpoint, options);
    } catch (error) {
      lastError = error;

      if (error.status === 429 || error.status >= 500) {
        // Retryable error - exponential backoff
        const backoffMs = Math.pow(2, attempt) * 1000;
        await this.sleep(backoffMs);
      } else {
        // Non-retryable error
        throw error;
      }
    }
  }

  throw lastError;
}
```

---

## API Endpoints

### Required Endpoints

| Purpose | Method | Endpoint | API Version |
|---------|--------|----------|-------------|
| Get current user | GET | `/_apis/profile/profiles/me` | 7.1 |
| Validate connection | GET | `/_apis/projects?$top=1` | 7.1 |
| Execute WIQL query | POST | `/{project}/_apis/wit/wiql` | 7.1 |
| Get work item details | GET | `/_apis/wit/workitems/{id}` | 7.1 |
| Get work item comments | GET | `/_apis/wit/workItems/{id}/comments` | 7.1-preview.4 |
| List projects | GET | `/_apis/projects` | 7.1 |

### Future Endpoints (for PR mentions)

| Purpose | Method | Endpoint | API Version |
|---------|--------|----------|-------------|
| List PRs for reviewer | GET | `/{project}/_apis/git/pullrequests` | 7.1 |
| Get PR threads | GET | `/_apis/git/repositories/{repo}/pullRequests/{prId}/threads` | 7.1 |

---

## Method Specifications

### getCurrentUser()

Returns the authenticated user's identity.

```javascript
async getCurrentUser() {
  // Note: Uses vssps.dev.azure.com, not dev.azure.com
  const vsspsUrl = this.orgUrl.replace('dev.azure.com', 'vssps.dev.azure.com');
  const response = await fetch(`${vsspsUrl}/_apis/profile/profiles/me?api-version=7.1`, {
    headers: { 'Authorization': this.authHeader }
  });

  return response.json();
  // Returns: { displayName, emailAddress, publicAlias, id, ... }
}
```

### validateConnection()

Tests that the PAT is valid and has necessary permissions.

```javascript
async validateConnection() {
  try {
    const user = await this.getCurrentUser();
    const projects = await this.fetch('/_apis/projects?$top=1&api-version=7.1');
    return {
      valid: true,
      user: user.displayName,
      hasProjects: projects.count > 0
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message
    };
  }
}
```

### listProjects()

Returns all projects the user has access to.

```javascript
async listProjects() {
  const response = await this.fetch('/_apis/projects?api-version=7.1');
  return response.value; // Array of { id, name, ... }
}
```

### executeWiql(wiql, project?)

Executes a WIQL query and returns work item IDs.

```javascript
async executeWiql(wiql, project = null) {
  const endpoint = project
    ? `/${project}/_apis/wit/wiql?api-version=7.1`
    : '/_apis/wit/wiql?api-version=7.1';

  const response = await this.fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ query: wiql })
  });

  return response.workItems; // Array of { id, url }
}
```

### getWorkItem(id, fields?)

Gets a single work item with specified fields.

```javascript
async getWorkItem(id, fields = null) {
  let endpoint = `/_apis/wit/workitems/${id}?api-version=7.1`;
  if (fields) {
    endpoint += `&fields=${fields.join(',')}`;
  }

  return this.fetch(endpoint);
}
```

### getWorkItems(ids, fields?)

Batch get multiple work items (max 200 per call).

```javascript
async getWorkItems(ids, fields = null) {
  if (ids.length === 0) return [];
  if (ids.length > 200) {
    throw new Error('Max 200 work items per batch');
  }

  let endpoint = `/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.1`;
  if (fields) {
    endpoint += `&fields=${fields.join(',')}`;
  }

  const response = await this.fetch(endpoint);
  return response.value;
}
```

### getWorkItemComments(id)

Gets all comments on a work item.

```javascript
async getWorkItemComments(workItemId) {
  const response = await this.fetch(
    `/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`
  );
  return response.comments; // Array of { id, text, createdBy, createdDate, ... }
}
```

---

## Error Handling

### Custom Error Class

```javascript
class AdoApiError extends Error {
  constructor(status, message, endpoint) {
    super(`ADO API Error (${status}): ${message}`);
    this.status = status;
    this.endpoint = endpoint;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isRateLimited() {
    return this.status === 429;
  }

  get isServerError() {
    return this.status >= 500;
  }
}
```

### User-Friendly Error Messages

```javascript
function getUserFriendlyError(error) {
  if (error.isAuthError) {
    return 'Authentication failed. Please check your PAT and ensure it has not expired.';
  }
  if (error.isRateLimited) {
    return 'Azure DevOps is temporarily limiting requests. Please wait a moment.';
  }
  if (error.isServerError) {
    return 'Azure DevOps is experiencing issues. Please try again later.';
  }
  return 'Unable to connect to Azure DevOps. Please check your network connection.';
}
```

---

## Module Exports

```javascript
// src/ado/api-client.js
export { AdoApiClient, AdoApiError, normalizeOrgUrl, getUserFriendlyError };
```

---

## Testing with Azure CLI

For manual testing and exploration of ADO APIs:

```bash
# Login
az login
az devops configure --defaults organization=https://dev.azure.com/YOUR_ORG

# Test WIQL query
az boards query --wiql "SELECT [System.Id] FROM workitems WHERE [System.Id] IN (@recentMentions)"

# Get work item details
az boards work-item show --id 12345

# For APIs not directly supported
az devops invoke --area wit --resource wiql --api-version 7.1 \
  --http-method POST --in-file query.json
```

---

## Security Considerations

1. **PAT Scope**: Recommend users create PATs with minimal scope:
   - Work Items: Read
   - Code: Read (for PR mentions, future phase)
   - User Profile: Read

2. **PAT Expiration**: PATs can expire. The API client should detect 401 errors and prompt for re-authentication.

3. **Never Log PATs**: Ensure PATs are never logged or included in error messages.
