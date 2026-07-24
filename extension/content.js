/**
 * ContextSync — Content Script (content.js)
 *
 * Responsibilities:
 *  - Listen for "pasteContext" messages from the background service worker.
 *  - Render a polished floating "📋 Inject Context" action button in the DOM.
 *  - On button click, locate the chat input (textarea or contenteditable element),
 *    inject the captured terminal text, and dispatch synthetic events so that the
 *    React/Next.js SPA recognises the new value and activates its submit controls.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

/** Holds the most recent text payload received from the CLI server. */
let latestTerminalText = '';

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== 'pasteContext') return false;

  if (typeof message.text !== 'string' || message.text.trim() === '') {
    console.warn('[ContextSync] Received pasteContext with empty or invalid text — ignoring.');
    sendResponse({ status: 'ignored', reason: 'empty text' });
    return false;
  }

  latestTerminalText = message.text;
  console.log('[ContextSync] 📥 Context received — creating inject button.');

  createFloatingButton();

  sendResponse({ status: 'ok' });
  return false; // synchronous response — no async port needed
});

// ─── UI: Floating Button ──────────────────────────────────────────────────────

/**
 * Renders a visually rich floating action button anchored to the bottom-right
 * corner of the viewport. Idempotent — calling it multiple times is safe.
 */
function createFloatingButton() {
  // Guard: prevent duplicating the button on rapid successive messages.
  if (document.getElementById('ctx-sync-btn')) {
    console.log('[ContextSync] Button already present — updating stored text only.');
    return;
  }

  // ── Container / Button element ───────────────────────────────────────────

  const btn = document.createElement('button');
  btn.id          = 'ctx-sync-btn';
  btn.textContent = '📋 Inject Context';
  btn.title       = 'Click to inject your terminal context into the chat input';

  // ── Base styles ───────────────────────────────────────────────────────────

  Object.assign(btn.style, {
    // Positioning
    position:   'fixed',
    bottom:     '100px',
    right:      '20px',
    zIndex:     '99999',

    // Sizing & spacing
    padding:        '12px 20px',
    borderRadius:   '12px',
    border:         'none',
    minWidth:       '160px',

    // Typography
    fontFamily:  "'Segoe UI', 'Inter', 'Helvetica Neue', Arial, sans-serif",
    fontSize:    '14px',
    fontWeight:  '600',
    letterSpacing: '0.3px',
    color:       '#ffffff',

    // Emerald green palette
    background:     'linear-gradient(135deg, #10b981 0%, #059669 100%)',
    boxShadow:      '0 4px 20px rgba(16, 185, 129, 0.45), 0 2px 8px rgba(0, 0, 0, 0.18)',

    // Interaction
    cursor:         'pointer',
    userSelect:     'none',
    outline:        'none',

    // Transition for hover / active micro-animations
    transition:     'transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease',

    // Entry animation trigger (opacity starts at 0, see keyframe below)
    opacity:        '0',
    transform:      'translateY(12px)',
  });

  // ── Inject keyframe animation via a shared <style> tag ───────────────────

  injectGlobalStyles();

  // ── Trigger entrance animation on next paint ──────────────────────────────

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      btn.style.opacity   = '1';
      btn.style.transform = 'translateY(0)';
    });
  });

  // ── Hover micro-interactions ──────────────────────────────────────────────

  btn.addEventListener('mouseenter', () => {
    btn.style.transform  = 'translateY(-2px) scale(1.03)';
    btn.style.boxShadow  = '0 8px 28px rgba(16, 185, 129, 0.55), 0 4px 12px rgba(0, 0, 0, 0.22)';
    btn.style.background = 'linear-gradient(135deg, #34d399 0%, #10b981 100%)';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.transform  = 'translateY(0) scale(1)';
    btn.style.boxShadow  = '0 4px 20px rgba(16, 185, 129, 0.45), 0 2px 8px rgba(0, 0, 0, 0.18)';
    btn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
  });

  btn.addEventListener('mousedown', () => {
    btn.style.transform = 'translateY(1px) scale(0.98)';
  });

  btn.addEventListener('mouseup', () => {
    btn.style.transform = 'translateY(-2px) scale(1.03)';
  });

  // ── Click: inject context into the chat input ─────────────────────────────

  btn.addEventListener('click', () => {
    injectContextIntoInput();
  });

  document.body.appendChild(btn);
  console.log('[ContextSync] ✅ Floating inject button rendered.');
}

// ─── Style Injection ──────────────────────────────────────────────────────────

/**
 * Appends a single <style> block (idempotent) that provides the entrance
 * keyframe animation for the floating button.
 */
function injectGlobalStyles() {
  const STYLE_ID = 'ctx-sync-styles';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #ctx-sync-btn {
      transition: opacity 0.3s ease, transform 0.3s ease, box-shadow 0.18s ease, background 0.18s ease !important;
    }
    #ctx-sync-btn:focus-visible {
      outline: 2px solid #34d399 !important;
      outline-offset: 3px !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Core Injection Logic ─────────────────────────────────────────────────────

/**
 * Locates the active chat input on the page (supports both <textarea> and
 * contenteditable <div>/<p> elements), injects latestTerminalText into it
 * via execCommand, and dispatches synthetic events to trigger React's internal
 * state handlers so the submit button activates correctly.
 */
function injectContextIntoInput() {
  const textToInject = latestTerminalText;

  if (!textToInject) {
    console.warn('[ContextSync] No stored terminal text to inject.');
    removeFloatingButton();
    return;
  }

  // ── Selector strategy (ordered by specificity for each target site) ───────

  const SELECTORS = [
    // ChatGPT (as of 2024-2025 DOM structure)
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',

    // Claude (as of 2024-2025 DOM structure)
    'div[contenteditable="true"].ProseMirror',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][class*="claude"]',

    // Generic fallbacks
    'textarea',
    '[contenteditable="true"]',
  ];

  let inputEl = null;

  for (const selector of SELECTORS) {
    try {
      const candidate = document.querySelector(selector);
      if (candidate && isVisible(candidate)) {
        inputEl = candidate;
        break;
      }
    } catch (_) {
      // Malformed selector — skip silently.
    }
  }

  if (!inputEl) {
    console.error('[ContextSync] ❌ Could not locate a visible chat input element on this page.');
    showErrorFeedback();
    return;
  }

  console.log('[ContextSync] 🎯 Target input found:', inputEl.tagName, inputEl.className);

  // ── 1. Focus the element ──────────────────────────────────────────────────

  inputEl.focus();

  // ── 2. Insert text via execCommand (triggers native input stack) ──────────

  const inserted = document.execCommand('insertText', false, textToInject);

  if (!inserted) {
    // execCommand can return false on some contenteditable configurations;
    // fall back to a manual value assignment + event dispatch for <textarea>.
    console.warn('[ContextSync] execCommand returned false — using fallback value assignment.');

    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(inputEl, textToInject);
      } else {
        inputEl.value = textToInject;
      }
    } else {
      // contenteditable fallback: set innerText directly
      inputEl.innerText = textToInject;

      // Move caret to end of content
      const range    = document.createRange();
      const sel      = window.getSelection();
      range.selectNodeContents(inputEl);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  // ── 3. Dispatch synthetic events to activate React / framework handlers ───

  const syntheticEvents = [
    new Event('input',  { bubbles: true, cancelable: true }),
    new Event('change', { bubbles: true, cancelable: true }),
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'End' }),
    new KeyboardEvent('keyup',   { bubbles: true, cancelable: true, key: 'End' }),
  ];

  for (const evt of syntheticEvents) {
    inputEl.dispatchEvent(evt);
  }

  console.log('[ContextSync] ✅ Context injected successfully into chat input.');

  // ── 4. Remove the button with a smooth exit animation ────────────────────

  removeFloatingButton();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a DOM element is currently visible (not hidden by CSS or
 * zero dimensions).
 * @param {Element} el
 * @returns {boolean}
 */
function isVisible(el) {
  const rect   = el.getBoundingClientRect();
  const styles = window.getComputedStyle(el);

  return (
    styles.display    !== 'none'    &&
    styles.visibility !== 'hidden'  &&
    styles.opacity    !== '0'       &&
    (rect.width > 0 || rect.height > 0)
  );
}

/**
 * Animates the floating button out and removes it from the DOM.
 */
function removeFloatingButton() {
  const btn = document.getElementById('ctx-sync-btn');
  if (!btn) return;

  btn.style.opacity   = '0';
  btn.style.transform = 'translateY(12px)';

  setTimeout(() => btn.remove(), 320);
}

/**
 * Briefly flashes the button red to indicate a failed injection attempt.
 */
function showErrorFeedback() {
  const btn = document.getElementById('ctx-sync-btn');
  if (!btn) return;

  const originalBg     = btn.style.background;
  const originalShadow = btn.style.boxShadow;

  btn.textContent      = '❌ Input not found';
  btn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
  btn.style.boxShadow  = '0 4px 20px rgba(239, 68, 68, 0.45)';

  setTimeout(() => {
    btn.textContent      = '📋 Inject Context';
    btn.style.background = originalBg;
    btn.style.boxShadow  = originalShadow;
  }, 2500);
}
