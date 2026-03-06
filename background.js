/**
 * Background service worker entry point.
 * This file bootstraps the extension's background functionality.
 */

import { initializeBackgroundService } from './src/background/index.js';

// Initialize the background service
initializeBackgroundService();
