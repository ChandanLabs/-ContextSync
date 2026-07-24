/**
 * ContextSync — Background Service Worker (background.js)
 *
 * Responsibilities:
 *  - Maintain a persistent WebSocket connection to the local CLI server (ws://localhost:3000).
 *  - Auto-reconnect every 5 seconds on disconnect (handles server restarts gracefully).
 *  - Forward incoming payloads to the active tab's content script via chrome.tabs.sendMessage.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL            = 'ws://localhost:3000';
const RECONNECT_DELAY   = 5000; // milliseconds

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let socket = null;

/** @type {boolean} Prevents stacking multiple reconnect timers. */
let isReconnecting = false;

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection to the local CLI server and attaches all
 * necessary event handlers. Should only be called once per connection cycle.
 */
function connectLocalServer() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log('[ContextSync] Socket already open or connecting — skipping new attempt.');
    return;
  }

  console.log(`[ContextSync] Connecting to local server at ${WS_URL} …`);
  socket = new WebSocket(WS_URL);

  // ── Open ──────────────────────────────────────────────────────────────────

  socket.onopen = () => {
    isReconnecting = false;
    console.log('[ContextSync] ✅ Connected to local CLI server.');
  };

  // ── Message ───────────────────────────────────────────────────────────────

  socket.onmessage = (event) => {
    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      console.error('[ContextSync] ❌ Failed to parse incoming message:', event.data, err);
      return;
    }

    if (!payload || typeof payload.text !== 'string') {
      console.warn('[ContextSync] ⚠️  Received payload missing "text" field — ignoring.', payload);
      return;
    }

    // Locate the currently active, focused tab in the current window.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.error('[ContextSync] chrome.tabs.query error:', chrome.runtime.lastError.message);
        return;
      }

      if (!tabs || tabs.length === 0) {
        console.warn('[ContextSync] ⚠️  No active tab found — message not delivered.');
        return;
      }

      const activeTab = tabs[0];

      // Guard: only inject into pages we have access to (avoid chrome:// tabs, etc.).
      if (!activeTab.id || !activeTab.url) {
        console.warn('[ContextSync] ⚠️  Active tab has no id/url — skipping message delivery.');
        return;
      }

      chrome.tabs.sendMessage(
        activeTab.id,
        { action: 'pasteContext', text: payload.text },
        (response) => {
          // Consume runtime errors to prevent unchecked error state crashes.
          if (chrome.runtime.lastError) {
            console.warn(
              '[ContextSync] sendMessage error (tab may not have content script yet):',
              chrome.runtime.lastError.message
            );
            return;
          }

          if (response && response.status === 'ok') {
            console.log('[ContextSync] ✅ Payload delivered to content script successfully.');
          }
        }
      );
    });
  };

  // ── Error ─────────────────────────────────────────────────────────────────

  socket.onerror = (event) => {
    // 'error' is always followed by 'close', so we only log here.
    console.error('[ContextSync] ❌ WebSocket error — will attempt reconnect after close.', event);
  };

  // ── Close / Reconnect ─────────────────────────────────────────────────────

  socket.onclose = (event) => {
    socket = null;
    console.warn(
      `[ContextSync] 🔌 Connection closed (code: ${event.code}, reason: "${event.reason || 'none'}"). ` +
      `Retrying in ${RECONNECT_DELAY / 1000}s …`
    );

    if (!isReconnecting) {
      isReconnecting = true;
      setTimeout(() => {
        isReconnecting = false;
        connectLocalServer();
      }, RECONNECT_DELAY);
    }
  };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Initiate connection as soon as the service worker starts.
connectLocalServer();

// Keep the service worker alive by re-establishing on install/activate events.
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
