#!/usr/bin/env node
/**
 * ContextSync — Local WebSocket Broadcast Server (server.js)
 *
 * Usage:
 *   node server.js
 *   echo "fix this function" | node server.js   (one-shot pipe mode)
 *   ctx                                          (if installed globally via npm link)
 *
 * Behaviour:
 *   - Starts a WebSocket server on ws://localhost:3000.
 *   - Tracks all connected Chrome Extension clients in `activeConnectedClients`.
 *   - Reads lines from stdin and broadcasts each line as a JSON payload to all clients.
 *   - Logs connection events and broadcast status to stdout.
 */

'use strict';

// ─── Imports ──────────────────────────────────────────────────────────────────

const { WebSocketServer, WebSocket } = require('ws');
const readline = require('readline');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = 3000;

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Mutable array tracking every currently open WebSocket client connection.
 * Entries are added on 'connection' and removed on each socket's 'close'.
 * @type {WebSocket[]}
 */
const activeConnectedClients = [];

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
  const line = '─'.repeat(58);
  console.log('');
  console.log(`  ╔${line}╗`);
  console.log(`  ║          ContextSync — Local Broadcast Server          ║`);
  console.log(`  ╠${line}╣`);
  console.log(`  ║  WebSocket endpoint : ws://localhost:${PORT}              ║`);
  console.log(`  ║  Waiting for Chrome Extension to connect …             ║`);
  console.log(`  ║  Type or pipe text below and press Enter to send.      ║`);
  console.log(`  ╚${line}╝`);
  console.log('');
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  printBanner();
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ContextSync] ❌  Port ${PORT} is already in use.`);
    console.error(`[ContextSync]     Stop the existing server or change the PORT constant.`);
  } else {
    console.error('[ContextSync] ❌  WebSocket server error:', err.message);
  }
  process.exit(1);
});

wss.on('connection', (clientSocket, request) => {
  const clientIp = request.socket.remoteAddress || 'unknown';

  // Register the new client.
  activeConnectedClients.push(clientSocket);

  console.log(
    `[ContextSync] 🔌  Extension connected from ${clientIp}. ` +
    `Total clients: ${activeConnectedClients.length}`
  );

  // ── Per-socket error handling ─────────────────────────────────────────────

  clientSocket.on('error', (err) => {
    console.error('[ContextSync] ⚠️   Client socket error:', err.message);
  });

  // ── Cleanup on disconnect ─────────────────────────────────────────────────

  clientSocket.on('close', (code, reason) => {
    const idx = activeConnectedClients.indexOf(clientSocket);
    if (idx !== -1) {
      activeConnectedClients.splice(idx, 1);
    }

    console.log(
      `[ContextSync] 🔌  Extension disconnected (code: ${code}, reason: "${reason || 'none'}"). ` +
      `Remaining clients: ${activeConnectedClients.length}`
    );
  });

  // ── Optional: handle messages from the extension (future extensibility) ───

  clientSocket.on('message', (data) => {
    // Reserved for future bidirectional communication (e.g., status ACKs).
    console.log('[ContextSync] 📨  Message from extension:', data.toString());
  });
});

// ─── stdin / readline Interface ───────────────────────────────────────────────

const rl = readline.createInterface({
  input:    process.stdin,
  output:   process.stdout,
  terminal: false, // Allows clean pipe usage (echo "..." | node server.js)
});

/**
 * Broadcasts a text string to every currently open client.
 * Silently skips clients that are not in OPEN state.
 *
 * @param {string} text - The raw text string entered in the terminal.
 */
function broadcastText(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    console.log('[ContextSync] ⚠️   Empty input — nothing broadcast.');
    return;
  }

  if (activeConnectedClients.length === 0) {
    console.warn('[ContextSync] ⚠️   No connected clients. Is the Chrome Extension active?');
    return;
  }

  const jsonPayload = JSON.stringify({ text: trimmed });
  let sentCount     = 0;
  let skippedCount  = 0;

  for (const clientSocket of activeConnectedClients) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(jsonPayload, (err) => {
        if (err) {
          console.error('[ContextSync] ❌  Send error to client:', err.message);
        }
      });
      sentCount++;
    } else {
      skippedCount++;
    }
  }

  // ── Execution status block ────────────────────────────────────────────────

  const sep = '─'.repeat(50);
  console.log('');
  console.log(`  ${sep}`);
  console.log(`  📤  Broadcast Status`);
  console.log(`  ${sep}`);
  console.log(`  Payload  : ${trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed}`);
  console.log(`  Sent to  : ${sentCount} client(s)`);
  if (skippedCount > 0) {
    console.log(`  Skipped  : ${skippedCount} client(s) not in OPEN state`);
  }
  console.log(`  ${sep}`);
  console.log('');
}

// ── Listen for lines typed (or piped) into the terminal ──────────────────────

rl.on('line', (input) => {
  broadcastText(input);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

rl.on('close', () => {
  console.log('\n[ContextSync] 👋  stdin closed. Shutting down server gracefully …');

  // Notify all connected clients before closing.
  const shutdownPayload = JSON.stringify({ text: '[ContextSync server shutting down]' });
  for (const clientSocket of activeConnectedClients) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(shutdownPayload);
      clientSocket.close(1001, 'Server shutting down');
    }
  }

  wss.close(() => {
    console.log('[ContextSync] ✅  Server closed. Goodbye.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[ContextSync] 🛑  SIGINT received — initiating graceful shutdown …');
  rl.close(); // triggers the 'close' handler above
});

process.on('SIGTERM', () => {
  console.log('\n[ContextSync] 🛑  SIGTERM received — initiating graceful shutdown …');
  rl.close();
});
