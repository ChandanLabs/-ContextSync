#!/usr/bin/env node
/**
 * ContextSync — One-shot Client Sender (client.js)
 *
 * This is the command developers run from ANY terminal to send context
 * to the already-running ContextSync server.
 *
 * Usage:
 *   ctx "your text here"                   ← inline argument
 *   cat src/auth.js | ctx                  ← pipe a file
 *   git diff | ctx                         ← pipe git output
 *   npm test 2>&1 | ctx                    ← pipe errors
 *   echo "fix line 42" | ctx               ← quick one-liner
 *
 * The server (server.js) must already be running on ws://localhost:3000.
 * This script connects, sends one payload, and exits immediately.
 */

'use strict';

const { WebSocket } = require('ws');

const WS_URL         = 'ws://localhost:3000';
const CONNECT_TIMEOUT = 4000; // ms — give up if server not reachable

// ─── Collect input ─────────────────────────────────────────────────────────

/**
 * Reads all text from stdin (for pipe mode) OR from CLI arguments.
 * Returns a Promise<string>.
 */
function collectInput() {
  return new Promise((resolve) => {
    // If stdin is a TTY (i.e. NOT being piped into), use CLI args instead.
    if (process.stdin.isTTY) {
      const args = process.argv.slice(2).join(' ').trim();
      if (!args) {
        console.error('[ctx] ❌  No input provided.');
        console.error('');
        console.error('  Usage:');
        console.error('    ctx "your text here"');
        console.error('    cat file.js | ctx');
        console.error('    git diff | ctx');
        process.exit(1);
      }
      resolve(args);
      return;
    }

    // Stdin is piped — read all chunks until EOF.
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      const trimmed = data.trim();
      if (!trimmed) {
        console.error('[ctx] ❌  Piped input was empty — nothing sent.');
        process.exit(1);
      }
      resolve(trimmed);
    });
  });
}

// ─── Send to server ──────────────────────────────────────────────────────────

async function send() {
  const text = await collectInput();

  const ws = new WebSocket(WS_URL);

  // Timeout if the server isn't running.
  const timeout = setTimeout(() => {
    console.error(`[ctx] ❌  Could not connect to ContextSync server at ${WS_URL}`);
    console.error('[ctx]     Is the server running? Start it with:  node server.js');
    ws.terminate();
    process.exit(1);
  }, CONNECT_TIMEOUT);

  ws.on('open', () => {
    clearTimeout(timeout);

    const payload = JSON.stringify({ text });
    ws.send(payload, (err) => {
      if (err) {
        console.error('[ctx] ❌  Failed to send payload:', err.message);
        ws.terminate();
        process.exit(1);
      }

      // Pretty-print confirmation.
      const preview = text.length > 80 ? text.slice(0, 77) + '…' : text;
      console.log('');
      console.log('  [ctx] ✅  Sent to ContextSync server');
      console.log(`  Preview : ${preview}`);
      console.log('');

      // Close cleanly after sending.
      ws.close();
    });
  });

  ws.on('close', () => {
    process.exit(0);
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    console.error(`[ctx] ❌  Connection error: ${err.message}`);
    console.error('[ctx]     Make sure the server is running:  node server.js');
    process.exit(1);
  });
}

send();
