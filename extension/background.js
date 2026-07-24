/**
 * ContextSync — Background Service Worker (background.js)
 *
 * IMPORTANT — MV3 Service Worker Lifecycle:
 *   Chrome MV3 service workers are NOT persistent. Chrome kills them after
 *   ~20-30 seconds of inactivity. A plain `setTimeout` reconnect loop is also
 *   killed along with the worker, so the WebSocket never re-establishes.
 *
 *   FIX: We use `chrome.alarms` (the only MV3-approved keepalive mechanism)
 *   to fire an event every 25 seconds. Each alarm wakes the service worker
 *   and re-checks / re-establishes the WebSocket if needed.
 *
 * Responsibilities:
 *  - Maintain a WebSocket connection to the local CLI server (ws://localhost:3000).
 *  - Use chrome.alarms to keep the service worker alive and auto-reconnect.
 *  - Forward incoming payloads to the active tab's content script.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL          = 'ws://localhost:3000';
const ALARM_NAME      = 'ctx-sync-keepalive';
const ALARM_PERIOD    = 0.4;   // minutes (~24 seconds — safely under Chrome's 30s kill threshold)
const RECONNECT_DELAY = 3000;  // ms — wait before retrying after a close

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let socket = null;

/** @type {boolean} Prevents stacking multiple manual reconnect timers. */
let isReconnecting = false;

// ─── Alarm-based Keepalive ────────────────────────────────────────────────────

/**
 * Creates (or re-creates) a periodic alarm that fires every ~24 seconds.
 * Each alarm tick wakes the service worker AND re-checks the socket health.
 */
function ensureKeepaliveAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD });
      console.log(`[ContextSync] ⏰ Keepalive alarm created (every ${ALARM_PERIOD * 60}s).`);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // If socket is dead or missing, reconnect now.
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    console.log('[ContextSync] ⏰ Alarm fired — socket is not open. Reconnecting …');
    connectLocalServer();
  } else {
    // Socket is healthy — send a ping to confirm the connection is still live.
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
        console.log('[ContextSync] ⏰ Alarm fired — socket healthy, ping sent.');
      }
    } catch (err) {
      console.warn('[ContextSync] ⚠️  Ping failed:', err.message);
    }
  }
});

// ─── Core WebSocket ───────────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection to the local CLI server and attaches all
 * necessary event handlers. Safe to call multiple times — guards against
 * duplicate connections.
 */
function connectLocalServer() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log('[ContextSync] Socket already open or connecting — skipping.');
    return;
  }

  console.log(`[ContextSync] Connecting to ${WS_URL} …`);

  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[ContextSync] ❌ Failed to create WebSocket:', err.message);
    socket = null;
    scheduleReconnect();
    return;
  }

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

    // Ignore internal ping/pong control messages.
    if (payload && payload.type === 'ping') return;

    if (!payload || typeof payload.text !== 'string') {
      console.warn('[ContextSync] ⚠️  Payload missing "text" field — ignoring.', payload);
      return;
    }

    console.log('[ContextSync] 📨 Received text payload — forwarding to active tab …');
    forwardToActiveTab(payload.text);
  };

  // ── Error ─────────────────────────────────────────────────────────────────

  socket.onerror = (event) => {
    console.error('[ContextSync] ❌ WebSocket error. Reconnect will happen on close.', event.type);
  };

  // ── Close ─────────────────────────────────────────────────────────────────

  socket.onclose = (event) => {
    const wasClean = event.wasClean;
    console.warn(
      `[ContextSync] 🔌 Connection closed (code: ${event.code}, clean: ${wasClean}). ` +
      `Scheduling reconnect in ${RECONNECT_DELAY / 1000}s …`
    );
    socket = null;
    scheduleReconnect();
  };
}

/**
 * Schedules a one-shot reconnect attempt, guarded against stacking.
 */
function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;

  setTimeout(() => {
    isReconnecting = false;
    connectLocalServer();
  }, RECONNECT_DELAY);
}

// ─── Tab Messaging ────────────────────────────────────────────────────────────

/**
 * Finds the active, focused tab and sends the text payload to its content script.
 * Uses both `currentWindow: true` and a URL filter to ensure we only target
 * ChatGPT/Claude tabs. Falls back to querying all windows if none found in the
 * current window.
 *
 * @param {string} text
 */
function forwardToActiveTab(text) {
  // First: try the active tab in the currently focused window.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error('[ContextSync] tabs.query error:', chrome.runtime.lastError.message);
      return;
    }

    const supportedTab = findSupportedTab(tabs);

    if (supportedTab) {
      sendToTab(supportedTab, text);
      return;
    }

    // Fallback: search ALL windows for a supported active tab.
    chrome.tabs.query({ active: true }, (allTabs) => {
      if (chrome.runtime.lastError) {
        console.error('[ContextSync] tabs.query (all) error:', chrome.runtime.lastError.message);
        return;
      }

      const fallbackTab = findSupportedTab(allTabs);

      if (fallbackTab) {
        sendToTab(fallbackTab, text);
      } else {
        // Last resort: send to ALL tabs matching our host permissions.
        chrome.tabs.query({}, (everythingTabs) => {
          if (chrome.runtime.lastError) return;
          const matchingTabs = (everythingTabs || []).filter(t =>
            t.url && (t.url.startsWith('https://chatgpt.com') || t.url.startsWith('https://claude.ai'))
          );

          if (matchingTabs.length === 0) {
            console.warn('[ContextSync] ⚠️  No ChatGPT or Claude tab found. Open one first.');
            return;
          }

          console.log(`[ContextSync] Sending to ${matchingTabs.length} matching tab(s) …`);
          for (const tab of matchingTabs) {
            sendToTab(tab, text);
          }
        });
      }
    });
  });
}

/**
 * From a list of tabs, returns the first one whose URL matches ChatGPT or Claude.
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {chrome.tabs.Tab|null}
 */
function findSupportedTab(tabs) {
  if (!tabs || tabs.length === 0) return null;
  return tabs.find(t =>
    t.url && (t.url.startsWith('https://chatgpt.com') || t.url.startsWith('https://claude.ai'))
  ) || null;
}

/**
 * Sends the text payload to a specific tab's content script.
 * @param {chrome.tabs.Tab} tab
 * @param {string} text
 */
function sendToTab(tab, text) {
  if (!tab.id) return;

  console.log(`[ContextSync] 📤 Sending to tab #${tab.id}: ${tab.url}`);

  chrome.tabs.sendMessage(
    tab.id,
    { action: 'pasteContext', text },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          '[ContextSync] sendMessage error (content script may not be ready):',
          chrome.runtime.lastError.message
        );
        // Attempt scripting injection as a fallback if the content script isn't loaded yet.
        injectContentScriptAndRetry(tab.id, text);
        return;
      }

      if (response && response.status === 'ok') {
        console.log('[ContextSync] ✅ Payload delivered to content script.');
      }
    }
  );
}

/**
 * If sendMessage fails (content script not injected yet — e.g. user opened
 * the tab BEFORE the extension was loaded), programmatically inject it and retry.
 * @param {number} tabId
 * @param {string} text
 */
function injectContentScriptAndRetry(tabId, text) {
  chrome.scripting.executeScript(
    { target: { tabId }, files: ['content.js'] },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[ContextSync] Failed to inject content script:', chrome.runtime.lastError.message);
        return;
      }

      console.log('[ContextSync] Content script injected dynamically — retrying sendMessage …');

      // Short delay to let the script initialise before retrying.
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { action: 'pasteContext', text }, (retryResponse) => {
          if (chrome.runtime.lastError) {
            console.error('[ContextSync] Retry sendMessage failed:', chrome.runtime.lastError.message);
            return;
          }
          if (retryResponse && retryResponse.status === 'ok') {
            console.log('[ContextSync] ✅ Payload delivered on retry.');
          }
        });
      }, 300);
    }
  );
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// 1. Connect immediately when the service worker starts.
connectLocalServer();

// 2. Start the alarm-based keepalive so Chrome doesn't kill the service worker.
ensureKeepaliveAlarm();

// 3. Re-connect and re-establish alarm on install/activate lifecycle events.
self.addEventListener('install',  () => {
  console.log('[ContextSync] Service worker installed.');
  self.skipWaiting();
});

self.addEventListener('activate', () => {
  console.log('[ContextSync] Service worker activated.');
  ensureKeepaliveAlarm();
  connectLocalServer();
  self.clients.claim();
});
