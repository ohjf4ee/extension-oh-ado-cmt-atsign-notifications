/**
 * Azure DevOps REST API client.
 *
 * Handles authentication, rate limiting, and provides typed wrappers
 * for the specific API calls needed by this extension.
 */

import { API_CONFIG } from '../config.js';

/**
 * Custom error class for ADO API errors.
 */
export class AdoApiError extends Error {
  constructor(status, message, endpoint = null) {
    super(`ADO API Error (${status}): ${message}`);
    this.name = 'AdoApiError';
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

/**
 * Returns a user-friendly error message for display.
 * Always appends the actual error details for debugging.
 */
export function getUserFriendlyError(error) {
  const rawMsg = error?.message || String(error) || 'Unknown error';
  // Extract just the core message, trimming the "ADO API Error (xxx):" prefix if present
  const actualMsg = rawMsg.replace(/^ADO API Error \(\d+\):\s*/, '').substring(0, 200);

  if (error instanceof AdoApiError) {
    const endpoint = error.endpoint || '';

    if (error.isAuthError) {
      if (endpoint.includes('/git/')) {
        return `Auth failed for Git/PR (${error.status}). Check PAT has Code (Read) scope. ${actualMsg}`;
      }
      return `Auth failed (${error.status}). Check PAT scopes/expiration. ${actualMsg}`;
    }
    if (error.isRateLimited) {
      return `Rate limited (${error.status}). ${actualMsg}`;
    }
    if (error.isServerError) {
      return `Server error (${error.status}). ${actualMsg}`;
    }
    if (error.isNotFound) {
      return `Not found (${error.status}). ${actualMsg}`;
    }
    return `API error (${error.status}). ${actualMsg}`;
  }

  // Network errors or other non-API errors
  if (rawMsg.includes('Failed to fetch') || rawMsg.includes('NetworkError')) {
    return `Network error. ${rawMsg}`;
  }

  return rawMsg;
}

/**
 * Normalizes various org URL formats to a standard form.
 *
 * Handles:
 * - "myorg" → "https://dev.azure.com/myorg"
 * - "dev.azure.com/myorg" → "https://dev.azure.com/myorg"
 * - "https://dev.azure.com/myorg/" → "https://dev.azure.com/myorg"
 */
export function normalizeOrgUrl(url) {
  let normalized = url.trim();

  // If it's just an org name (no dots), assume dev.azure.com
  if (!normalized.includes('.')) {
    normalized = `https://dev.azure.com/${normalized}`;
  } else if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }

  // Remove trailing slash
  return normalized.replace(/\/$/, '');
}

/**
 * Extracts the organization name from a normalized org URL.
 */
export function extractOrgName(orgUrl) {
  const match = orgUrl.match(/dev\.azure\.com\/([^\/]+)/);
  return match ? match[1] : orgUrl;
}

/**
 * Azure DevOps API client.
 */
export class AdoApiClient {
  /**
   * @param {string} orgUrl - Organization URL (will be normalized)
   * @param {string} pat - Personal Access Token (plaintext)
   */
  constructor(orgUrl, pat) {
    this.orgUrl = normalizeOrgUrl(orgUrl);
    this.orgName = extractOrgName(this.orgUrl);
    // Trim whitespace from PAT (common copy-paste issue)
    const cleanPat = pat.trim();
    this.authHeader = 'Basic ' + btoa(':' + cleanPat);
    this.retryAfterUntil = 0;
    console.log('AdoApiClient created for:', this.orgUrl);
    console.log('PAT length:', cleanPat.length);
  }

  /**
   * Makes an authenticated API request.
   */
  async fetch(endpoint, options = {}) {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.orgUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Handle rate limiting
    this.handleRateLimitHeaders(response);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API request failed:', {
        url,
        status: response.status,
        statusText: response.statusText,
        body: errorText.substring(0, 500),
      });
      throw new AdoApiError(response.status, errorText, endpoint);
    }

    return response.json();
  }

  /**
   * Processes rate limit headers from response.
   */
  handleRateLimitHeaders(response) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const waitSeconds = parseInt(retryAfter, 10);
      this.retryAfterUntil = Date.now() + (waitSeconds * 1000);
      console.warn(`ADO rate limited. Retry after ${waitSeconds}s`);
    }
  }

  /**
   * Returns true if we're currently rate limited.
   */
  isRateLimited() {
    return Date.now() < this.retryAfterUntil;
  }

  /**
   * Returns milliseconds until rate limit expires.
   */
  getRetryAfterMs() {
    return Math.max(0, this.retryAfterUntil - Date.now());
  }

  /**
   * Makes a request with automatic retry on transient failures.
   */
  async fetchWithRetry(endpoint, options = {}, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Wait if rate limited
      if (this.isRateLimited()) {
        await this.sleep(this.getRetryAfterMs());
      }

      try {
        return await this.fetch(endpoint, options);
      } catch (error) {
        lastError = error;

        // Only retry on rate limit or server errors
        if (error instanceof AdoApiError &&
            (error.isRateLimited || error.isServerError)) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.log(`Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
          await this.sleep(backoffMs);
        } else {
          // Non-retryable error
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Helper to sleep for a given number of milliseconds.
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // API Methods
  // ===========================================================================

  /**
   * Gets the authenticated user's info from the org's connection data.
   * Note: Uses the org-scoped connectionData endpoint which works with org-scoped PATs,
   * unlike the global profile endpoint at app.vssps.visualstudio.com.
   */
  async getCurrentUser() {
    const connectionData = await this.fetch(`/_apis/connectionData`);
    const user = connectionData.authenticatedUser || {};
    console.log('connectionData.authenticatedUser:', JSON.stringify(user, null, 2));
    const result = {
      displayName: user.providerDisplayName || user.customDisplayName || '',
      emailAddress: user.properties?.Account?.$value || '',
      id: user.id || '',
      publicAlias: user.publicAlias || '',
    };
    console.log('getCurrentUser result:', result);
    return result;
  }

  /**
   * Validates that the connection and PAT are working.
   */
  async validateConnection() {
    try {
      // Use the org-scoped connection info endpoint
      // This works with org-scoped PATs (unlike the global profile endpoint)
      // Note: connectionData endpoint doesn't need api-version parameter
      const connectionData = await this.fetch(`/_apis/connectionData`);

      // Extract user info from connectionData
      const authenticatedUser = connectionData.authenticatedUser || {};

      return {
        valid: true,
        user: {
          displayName: authenticatedUser.providerDisplayName || authenticatedUser.customDisplayName || this.orgName,
          emailAddress: authenticatedUser.properties?.Account?.$value || '',
          id: authenticatedUser.id || '',
          publicAlias: authenticatedUser.publicAlias || '',
        },
      };
    } catch (error) {
      console.error('validateConnection failed:', error);
      console.error('Org URL:', this.orgUrl);
      console.error('Error status:', error.status);
      console.error('Error endpoint:', error.endpoint);

      // Build detailed error info for display
      let details = '';
      if (error instanceof AdoApiError) {
        details = `Status: ${error.status}`;
        if (error.endpoint) {
          details += ` | Endpoint: ${error.endpoint}`;
        }
      } else if (error.message) {
        details = error.message;
      }

      return {
        valid: false,
        error: getUserFriendlyError(error),
        details: details,
      };
    }
  }

  /**
   * Lists all projects the user has access to.
   */
  async listProjects() {
    const response = await this.fetch(`/_apis/projects?api-version=${API_CONFIG.version}`);
    return response.value;
  }

  /**
   * Executes a WIQL query and returns work item references.
   *
   * @param {string} wiql - The WIQL query string
   * @param {string} [project] - Optional project to scope the query
   * @returns {Promise<Array<{id: number, url: string}>>}
   */
  async executeWiql(wiql, project = null) {
    const endpoint = project
      ? `/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_CONFIG.version}`
      : `/_apis/wit/wiql?api-version=${API_CONFIG.version}`;

    const response = await this.fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ query: wiql }),
    });

    return response.workItems || [];
  }

  /**
   * Gets a single work item by ID.
   *
   * @param {number} id - Work item ID
   * @param {string[]} [fields] - Optional list of fields to retrieve
   */
  async getWorkItem(id, fields = null) {
    let endpoint = `/_apis/wit/workitems/${id}?api-version=${API_CONFIG.version}`;
    if (fields && fields.length > 0) {
      endpoint += `&fields=${fields.join(',')}`;
    }
    return this.fetch(endpoint);
  }

  /**
   * Gets multiple work items by ID (batch).
   * Max 200 items per request.
   *
   * @param {number[]} ids - Array of work item IDs
   * @param {string[]} [fields] - Optional list of fields to retrieve
   */
  async getWorkItems(ids, fields = null) {
    if (ids.length === 0) {
      return [];
    }

    if (ids.length > API_CONFIG.maxWorkItemsPerBatch) {
      throw new Error(`Max ${API_CONFIG.maxWorkItemsPerBatch} work items per batch`);
    }

    let endpoint = `/_apis/wit/workitems?ids=${ids.join(',')}&api-version=${API_CONFIG.version}`;
    if (fields && fields.length > 0) {
      endpoint += `&fields=${fields.join(',')}`;
    }

    const response = await this.fetch(endpoint);
    return response.value || [];
  }

  /**
   * Gets all comments on a work item.
   *
   * @param {string} project - Project name or ID (required for comments API)
   * @param {number} workItemId - Work item ID
   */
  async getWorkItemComments(project, workItemId) {
    const response = await this.fetch(
      `/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`
    );
    return response.comments || [];
  }

  // ===========================================================================
  // Pull Request API Methods
  // ===========================================================================

  /**
   * Gets pull requests from all repositories in a project.
   *
   * @param {string} project - Project name or ID
   * @param {Object} options - Query options
   * @param {string} [options.creatorId] - Filter by creator ID
   * @param {string} [options.reviewerId] - Filter by reviewer ID
   * @param {string} [options.status='active'] - PR status: active, completed, abandoned, all
   * @param {number} [options.top=100] - Max results to return
   * @returns {Promise<Array>} Pull request objects
   */
  async getPullRequests(project, options = {}) {
    const {
      creatorId,
      reviewerId,
      status = 'active',
      top = 100,
    } = options;

    let endpoint = `/${encodeURIComponent(project)}/_apis/git/pullrequests?api-version=${API_CONFIG.version}`;
    endpoint += `&searchCriteria.status=${status}`;
    endpoint += `&$top=${top}`;

    if (creatorId) {
      endpoint += `&searchCriteria.creatorId=${creatorId}`;
    }
    if (reviewerId) {
      endpoint += `&searchCriteria.reviewerId=${reviewerId}`;
    }

    const response = await this.fetch(endpoint);
    return response.value || [];
  }

  /**
   * Gets all comment threads for a pull request.
   *
   * @param {string} project - Project name or ID
   * @param {string} repositoryId - Repository ID or name
   * @param {number} pullRequestId - Pull request ID
   * @returns {Promise<Array>} Thread objects with comments
   */
  async getPullRequestThreads(project, repositoryId, pullRequestId) {
    const endpoint = `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads?api-version=${API_CONFIG.version}`;
    const response = await this.fetch(endpoint);
    return response.value || [];
  }

  /**
   * Gets detailed information about a pull request.
   *
   * @param {string} project - Project name or ID
   * @param {string} repositoryId - Repository ID or name
   * @param {number} pullRequestId - Pull request ID
   * @returns {Promise<Object>} Pull request details
   */
  async getPullRequest(project, repositoryId, pullRequestId) {
    const endpoint = `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}?api-version=${API_CONFIG.version}`;
    return this.fetch(endpoint);
  }

  /**
   * Gets all repositories in a project.
   *
   * @param {string} project - Project name or ID
   * @returns {Promise<Array>} Repository objects
   */
  async getRepositories(project) {
    const endpoint = `/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_CONFIG.version}`;
    const response = await this.fetch(endpoint);
    return response.value || [];
  }
}
