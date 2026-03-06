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
 */
export function getUserFriendlyError(error) {
  if (error instanceof AdoApiError) {
    if (error.isAuthError) {
      return 'Authentication failed. Please check your PAT and ensure it has not expired.';
    }
    if (error.isRateLimited) {
      return 'Azure DevOps is temporarily limiting requests. Please wait a moment.';
    }
    if (error.isServerError) {
      return 'Azure DevOps is experiencing issues. Please try again later.';
    }
    if (error.isNotFound) {
      return 'The requested resource was not found. Please check your organization URL.';
    }
  }
  return 'Unable to connect to Azure DevOps. Please check your network connection.';
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
    this.authHeader = 'Basic ' + btoa(':' + pat);
    this.retryAfterUntil = 0;
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
   * Gets the authenticated user's profile.
   * Note: Uses app.vssps.visualstudio.com (the global profile service), not dev.azure.com.
   */
  async getCurrentUser() {
    return this.fetch(`https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=${API_CONFIG.version}`);
  }

  /**
   * Validates that the connection and PAT are working.
   */
  async validateConnection() {
    try {
      const user = await this.getCurrentUser();
      const projects = await this.fetch(`/_apis/projects?$top=1&api-version=${API_CONFIG.version}`);

      return {
        valid: true,
        user: {
          displayName: user.displayName,
          emailAddress: user.emailAddress,
          id: user.id,
          publicAlias: user.publicAlias,
        },
        hasProjects: projects.count > 0,
      };
    } catch (error) {
      return {
        valid: false,
        error: getUserFriendlyError(error),
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
}
