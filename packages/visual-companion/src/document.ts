import type { CompanionDocumentKind } from "@kanna/agent-protocol";
import type { CompanionDeliveryTarget } from "./types";

function securityHead(
  target: CompanionDeliveryTarget,
  scriptNonce?: string
): string {
  const stylePolicy =
    target.kind === "react-native"
      ? "style-src 'unsafe-inline'"
      : "style-src 'self' 'unsafe-inline'";
  const scriptPolicy =
    target.kind === "react-native"
      ? "script-src 'unsafe-inline'"
      : `script-src 'self' 'nonce-${scriptNonce}'`;
  const connectPolicy =
    target.kind === "react-native"
      ? "connect-src 'none'"
      : "connect-src 'self'";
  const contentSecurityPolicy = [
    "default-src 'none'",
    stylePolicy,
    scriptPolicy,
    target.kind === "react-native"
      ? "img-src https: data:"
      : "img-src 'self' https: data:",
    ...(target.kind === "websocket" ? ["font-src 'self'"] : []),
    connectPolicy,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'"
  ].join("; ");
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`
  ].join("");
}

const FRAGMENT_STYLE = `<style id="kanna-companion-frame-style">
:root {
  color-scheme: dark;
  --bg-primary: #101722;
  --bg-secondary: #182334;
  --bg-tertiary: #243146;
  --border: #34445d;
  --text-primary: #f4f8ff;
  --text-secondary: #a8b6ca;
  --text-tertiary: #8292a9;
  --accent: #73b7ff;
  --success: #55c982;
  --error: #ff746c;
  --selected-bg: rgba(115, 183, 255, 0.14);
  --selected-border: #73b7ff;
}
html, body { min-height: 100%; margin: 0; }
body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
*, *::before, *::after { box-sizing: border-box; }
img, video, canvas, svg { height: auto; max-width: 100%; }
#kanna-companion-content { margin: 0 auto; max-width: 960px; padding: 20px; width: 100%; }
h2 { font-size: 1.5rem; margin: 0 0 0.5rem; }
h3 { font-size: 1.05rem; margin: 0 0 0.25rem; }
.subtitle { color: var(--text-secondary); margin-bottom: 1.5rem; }
.section { margin-bottom: 2rem; }
.label {
  color: var(--text-secondary);
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  margin-bottom: 0.5rem;
  text-transform: uppercase;
}
.options { display: flex; flex-direction: column; gap: 0.75rem; }
.option {
  align-items: flex-start;
  background: var(--bg-secondary);
  border: 2px solid var(--border);
  border-radius: 12px;
  display: flex;
  gap: 1rem;
  padding: 1rem 1.25rem;
}
.option.selected, [data-choice].selected {
  background: var(--selected-bg);
  border-color: var(--selected-border);
  outline: 2px solid var(--selected-border);
  outline-offset: 2px;
}
.option .letter {
  align-items: center;
  background: var(--bg-tertiary);
  border-radius: 6px;
  color: var(--text-secondary);
  display: flex;
  flex-shrink: 0;
  font-size: 0.85rem;
  font-weight: 600;
  height: 1.75rem;
  justify-content: center;
  width: 1.75rem;
}
.option.selected .letter { background: var(--accent); color: #07111f; }
.option .content { flex: 1; }
.option .content p, .card-body p { color: var(--text-secondary); font-size: 0.85rem; margin: 0; }
.cards {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
}
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.card.selected { border: 2px solid var(--selected-border); }
.card-image {
  align-items: center;
  aspect-ratio: 16 / 10;
  background: var(--bg-tertiary);
  display: flex;
  justify-content: center;
}
.card-body { padding: 1rem; }
.mockup {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 1.5rem;
  overflow: hidden;
}
.mockup-header {
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 0.75rem;
  padding: 0.5rem 1rem;
}
.mockup-body { padding: 1.5rem; }
.split { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.pros-cons { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 1rem 0; }
.pros, .cons { background: var(--bg-secondary); border-radius: 8px; padding: 1rem; }
.pros h4 { color: var(--success); }
.cons h4 { color: var(--error); }
.placeholder {
  background: var(--bg-tertiary);
  border: 2px dashed var(--border);
  border-radius: 8px;
  color: var(--text-tertiary);
  padding: 2rem;
  text-align: center;
}
@media (max-width: 700px) {
  .split, .pros-cons { grid-template-columns: 1fr; }
}
</style>`;

const IMAGE_PLACEHOLDER_STYLE = `<style id="kanna-companion-image-style">
.kanna-companion-image-placeholder {
  align-items: center;
  background: rgba(255, 116, 108, 0.08);
  border: 1px dashed rgba(255, 116, 108, 0.55);
  border-radius: 8px;
  color: #ffaaa5;
  display: flex;
  min-height: 72px;
  overflow-wrap: anywhere;
  padding: 12px;
}
</style>`;

const WEBSOCKET_STATUS_STYLE = `<style id="kanna-companion-status-style">
#kanna-companion-indicator {
  align-items: center;
  bottom: 16px;
  display: flex;
  gap: 8px;
  position: fixed;
  right: 16px;
  z-index: 2147483647;
}
#kanna-companion-status {
  background: rgba(16, 23, 34, 0.94);
  border: 1px solid #34445d;
  border-radius: 999px;
  color: #a8b6ca;
  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 8px 12px;
}
#kanna-companion-status[data-status="sent"] { border-color: #55c982; color: #55c982; }
#kanna-companion-status[data-status="error"] { border-color: #ff746c; color: #ff746c; }
#kanna-companion-retry {
  background: #182334;
  border: 1px solid #73b7ff;
  border-radius: 999px;
  color: #f4f8ff;
  cursor: pointer;
  font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 8px 12px;
}
#kanna-companion-retry[hidden] { display: none; }
</style>`;

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function websocketStatus(
  target: Extract<CompanionDeliveryTarget, { kind: "websocket" }>
): string {
  return [
    '<div id="kanna-companion-indicator">',
    '<div id="kanna-companion-status" data-status="connecting" aria-live="polite">',
    escapeHtmlText(target.strings.connecting),
    "</div>",
    '<button id="kanna-companion-retry" type="button" hidden disabled>',
    escapeHtmlText(target.strings.retry),
    "</button></div>"
  ].join("");
}

// This script is constant. Companion HTML is composed beside it, never embedded
// in a JavaScript literal.
const REACT_NATIVE_BRIDGE = `<script id="kanna-companion-bridge">
(function() {
  'use strict';
  var eventCounter = 0;
  window.selectedChoice = null;

  window.toggleSelect = function(el) {
    if (!el || !el.dataset) return;
    var container = el.closest('.options') || el.closest('.cards');
    var multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach(function(option) {
        option.classList.remove('selected');
      });
    }
    if (multi) {
      el.classList.toggle('selected');
    } else {
      el.classList.add('selected');
    }
    window.selectedChoice = el.dataset.choice;
  };

  document.addEventListener('submit', function(event) {
    event.preventDefault();
  });

  function truncateUtf8(value, maxBytes) {
    var result = '';
    var bytes = 0;
    for (var character of value) {
      var codePoint = character.codePointAt(0) || 0;
      var characterBytes = codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
      if (bytes + characterBytes > maxBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  }

  document.addEventListener('click', function(event) {
    var origin = event.target;
    var target = origin && origin.closest ? origin.closest('[data-choice]') : null;
    if (!target || !target.dataset || typeof target.dataset.choice !== 'string') return;
    if (!target.hasAttribute('onclick')) window.toggleSelect(target);

    eventCounter += 1;
    var message = {
      type: 'companion-event',
      event: {
        event_id: 'mobile-' + Date.now() + '-' + eventCounter,
        type: 'click',
        choice: truncateUtf8(target.dataset.choice, 256),
        text: truncateUtf8((target.textContent || '').trim(), 4096),
        id: target.id ? truncateUtf8(target.id, 256) : null,
        timestamp: Date.now()
      }
    };
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  });
})();
</script>`;

function websocketBridge(
  target: Extract<CompanionDeliveryTarget, { kind: "websocket" }>,
  scriptNonce: string
): string {
  const { path, sessionId, revision } = target;
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#") ||
    /[<>\u0000-\u0020]/u.test(path)
  ) {
    throw new Error("companion WebSocket path must be same-origin");
  }
  const hasWellFormedUtf16 = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        return false;
      }
    }
    return true;
  };
  const validIdentity = (value: string) =>
    value.length > 0 &&
    hasWellFormedUtf16(value) &&
    new TextEncoder().encode(value).length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
  if (!validIdentity(sessionId) || !validIdentity(revision)) {
    throw new Error("companion WebSocket document identity is invalid");
  }
  const encodedPath = JSON.stringify(path).replace(/</gu, "\\u003c");
  const encodedSessionId = JSON.stringify(sessionId).replace(/</gu, "\\u003c");
  const encodedRevision = JSON.stringify(revision).replace(/</gu, "\\u003c");
  const encodedStrings = JSON.stringify(target.strings).replace(/</gu, "\\u003c");
  return `<script id="kanna-companion-bridge" nonce="${scriptNonce}">
(function() {
  'use strict';
  var eventCounter = 0;
  var pendingEventId = null;
  var pendingEvent = null;
  var retryEvent = null;
  var remoteStatus = 'connecting';
  var remoteAvailable = false;
  var socket = null;
  var socketGeneration = 0;
  var reconnectAttempt = 0;
  var reconnectScheduled = false;
  var reconnectDelays = [250, 500, 1000, 2000];
  var labels = ${encodedStrings};
  var liveContentReplaced = false;
  var socketUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://')
    + window.location.host + ${encodedPath}
    + '?sessionId=' + encodeURIComponent(${encodedSessionId})
    + '&revision=' + encodeURIComponent(${encodedRevision});
  var retryButton = document.getElementById('kanna-companion-retry');
  var content = document.getElementById('kanna-companion-content');
  window.selectedChoice = null;

  function setStatus(status, text) {
    var indicator = document.getElementById('kanna-companion-status');
    if (!indicator) return;
    indicator.dataset.status = status;
    indicator.textContent = text;
  }

  function lifecycleLabel(status) {
    return typeof labels[status] === 'string'
      ? labels[status]
      : labels.error;
  }

  function clearSelectionMarkers() {
    if (!content || !content.querySelectorAll) return;
    content.querySelectorAll('.selected').forEach(function(element) {
      element.classList.remove('selected');
    });
    window.selectedChoice = null;
  }

  function setContentInteractive(interactive, lifecycle) {
    if (!content) return;
    content.inert = !interactive;
    if (interactive) {
      delete content.dataset.kannaCompanionLifecycle;
      content.removeAttribute('aria-disabled');
    } else {
      content.dataset.kannaCompanionLifecycle = lifecycle;
      content.setAttribute('aria-disabled', 'true');
      clearSelectionMarkers();
    }
  }

  function replaceWithLifecycle(status) {
    if (!content) return;
    var title = document.createElement('h1');
    var detail = document.createElement('p');
    title.textContent = lifecycleLabel(status);
    detail.textContent =
      status === 'unavailable' ? labels.unavailableDetail : labels.errorDetail;
    content.replaceChildren(title, detail);
    liveContentReplaced = true;
    setContentInteractive(false, status);
  }

  function canSendSelection() {
    return (
      socket !== null &&
      socket.readyState === WebSocket.OPEN &&
      remoteAvailable &&
      !liveContentReplaced
    );
  }

  function setRetry(event) {
    retryEvent = event;
    if (!retryButton) return;
    var available =
      event !== null &&
      socket !== null &&
      socket.readyState === WebSocket.OPEN &&
      remoteAvailable;
    retryButton.hidden = !available;
    retryButton.disabled = !available;
  }

  function clearInteraction() {
    pendingEventId = null;
    pendingEvent = null;
    setRetry(null);
  }

  function preservePendingForRetry() {
    if (pendingEvent !== null) retryEvent = pendingEvent;
    pendingEventId = null;
    pendingEvent = null;
    setRetry(retryEvent);
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every(function(key) {
      return allowed.indexOf(key) !== -1;
    });
  }

  window.toggleSelect = function(el) {
    if (!el || !el.dataset) return;
    var container = el.closest('.options') || el.closest('.cards');
    var multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach(function(option) {
        option.classList.remove('selected');
      });
    }
    if (multi) {
      el.classList.toggle('selected');
    } else {
      el.classList.add('selected');
    }
    window.selectedChoice = el.dataset.choice;
  };

  document.addEventListener('submit', function(event) {
    event.preventDefault();
  });

  function truncateUtf8(value, maxBytes) {
    var result = '';
    var bytes = 0;
    for (var character of value) {
      var codePoint = character.codePointAt(0) || 0;
      var characterBytes = codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
      if (bytes + characterBytes > maxBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  }

  function utf8ByteLength(value) {
    var bytes = 0;
    for (var character of value) {
      var codePoint = character.codePointAt(0) || 0;
      bytes += codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    }
    return bytes;
  }

  function sendSelection(selection, existingEvent) {
    if (!canSendSelection()) {
      if (existingEvent) setRetry(existingEvent);
      if (
        (socket === null || socket.readyState !== WebSocket.OPEN) &&
        remoteStatus === 'available'
      ) {
        remoteStatus = 'reconnecting';
      }
      setStatus(remoteStatus, lifecycleLabel(remoteStatus));
      return;
    }
    var event = existingEvent;
    if (!event) {
      eventCounter += 1;
      var now = Date.now();
      event = {
        event_id: 'browser-' + now + '-' + eventCounter,
        type: 'click',
        choice: selection.choice,
        text: selection.text,
        id: selection.id,
        timestamp: now
      };
    }
    pendingEventId = event.event_id;
    pendingEvent = event;
    setRetry(null);
    try {
      socket.send(JSON.stringify({ type: 'companion-event', event: event }));
      setStatus('sending', labels.sending);
    } catch (_) {
      pendingEventId = null;
      pendingEvent = null;
      setRetry(event);
      setStatus('error', labels.selectionFailed);
    }
  }

  if (retryButton) {
    retryButton.addEventListener('click', function(event) {
      event.preventDefault();
      var eventToRetry = retryEvent;
      if (!eventToRetry) {
        clearInteraction();
        setStatus(remoteStatus, lifecycleLabel(remoteStatus));
        return;
      }
      sendSelection({
        choice: eventToRetry.choice,
        text: eventToRetry.text,
        id: eventToRetry.id
      }, eventToRetry);
    });
  }

  function isCurrentSocket(candidate, generation) {
    return socket === candidate && socketGeneration === generation;
  }

  function scheduleReconnect(generation) {
    if (reconnectScheduled || generation !== socketGeneration) return;
    var delay =
      reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
    reconnectAttempt += 1;
    reconnectScheduled = true;
    setTimeout(function() {
      if (!reconnectScheduled || generation !== socketGeneration) return;
      reconnectScheduled = false;
      connectSocket();
    }, delay);
  }

  function connectSocket() {
    socketGeneration += 1;
    var generation = socketGeneration;
    var nextSocket = new WebSocket(socketUrl);
    socket = nextSocket;
    remoteStatus = 'connecting';
    remoteAvailable = false;
    preservePendingForRetry();
    setContentInteractive(false, remoteStatus);
    setStatus(remoteStatus, lifecycleLabel(remoteStatus));

    nextSocket.addEventListener('open', function() {
      if (!isCurrentSocket(nextSocket, generation)) return;
      remoteStatus = 'connecting';
      remoteAvailable = false;
      preservePendingForRetry();
      setContentInteractive(false, remoteStatus);
      setStatus(remoteStatus, lifecycleLabel(remoteStatus));
    });
    nextSocket.addEventListener('close', function() {
      if (!isCurrentSocket(nextSocket, generation)) return;
      socket = null;
      remoteStatus = 'reconnecting';
      remoteAvailable = false;
      preservePendingForRetry();
      setContentInteractive(false, remoteStatus);
      setStatus(remoteStatus, lifecycleLabel(remoteStatus));
      scheduleReconnect(generation);
    });
    nextSocket.addEventListener('error', function() {
      if (!isCurrentSocket(nextSocket, generation)) return;
      remoteStatus = 'error';
      remoteAvailable = false;
      preservePendingForRetry();
      setContentInteractive(false, remoteStatus);
      setStatus(remoteStatus, lifecycleLabel(remoteStatus));
    });
    nextSocket.addEventListener('message', function(messageEvent) {
      if (!isCurrentSocket(nextSocket, generation)) return;
      if (
        typeof messageEvent.data !== 'string' ||
        utf8ByteLength(messageEvent.data) > 8192
      ) return;
      var message;
      try {
        message = JSON.parse(messageEvent.data);
      } catch (_) {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'reload') {
        if (!hasOnlyKeys(message, ['type'])) return;
        remoteStatus = 'reconnecting';
        remoteAvailable = false;
        clearInteraction();
        window.location.reload();
        return;
      }
      if (message.type === 'status') {
        if (
          !hasOnlyKeys(message, ['type', 'status', 'message']) ||
          !(
            message.message === undefined ||
            (typeof message.message === 'string' &&
              utf8ByteLength(message.message) <= 4096)
          )
        ) return;
        if (
          message.status === 'available' ||
          message.status === 'reconnecting' ||
          message.status === 'unavailable' ||
          message.status === 'error'
        ) {
          if (message.status === 'available') {
            reconnectAttempt = 0;
            if (remoteAvailable) return;
            if (liveContentReplaced) {
              window.location.reload();
              return;
            }
            remoteStatus = message.status;
            remoteAvailable = true;
            setContentInteractive(true, remoteStatus);
            setRetry(retryEvent);
          } else if (message.status === 'reconnecting') {
            remoteStatus = message.status;
            remoteAvailable = false;
            preservePendingForRetry();
            setContentInteractive(false, remoteStatus);
          } else {
            remoteStatus = message.status;
            remoteAvailable = false;
            clearInteraction();
            replaceWithLifecycle(remoteStatus);
          }
          setStatus(remoteStatus, lifecycleLabel(remoteStatus));
        }
        return;
      }
      if (
        message.type !== 'event_result' ||
        !hasOnlyKeys(message, ['type', 'event_id', 'accepted', 'code', 'message']) ||
        typeof message.event_id !== 'string' ||
        typeof message.accepted !== 'boolean' ||
        !(
          message.code === undefined ||
          (typeof message.code === 'string' &&
            utf8ByteLength(message.code) <= 128)
        ) ||
        !(
          message.message === undefined ||
          (typeof message.message === 'string' &&
            utf8ByteLength(message.message) <= 4096)
        ) ||
        message.event_id !== pendingEventId
      ) return;

      var completedEvent = pendingEvent;
      pendingEventId = null;
      pendingEvent = null;
      if (message.accepted) {
        setRetry(null);
        setStatus('sent', labels.sent);
      } else {
        setRetry(completedEvent);
        setStatus('error', message.message || labels.selectionFailed);
      }
    });
  }

  connectSocket();

  document.addEventListener('click', function(event) {
    var origin = event.target;
    var target = origin && origin.closest ? origin.closest('[data-choice]') : null;
    if (!target || !target.dataset || typeof target.dataset.choice !== 'string') return;
    var selection = {
      choice: truncateUtf8(target.dataset.choice, 256),
      text: truncateUtf8((target.textContent || '').trim(), 4096),
      id: target.id ? truncateUtf8(target.id, 256) : null
    };
    if (!canSendSelection()) {
      sendSelection(selection);
      return;
    }
    if (!target.hasAttribute('onclick')) window.toggleSelect(target);
    setRetry(null);
    sendSelection(selection);
  });
})();
</script>`;
}

function sanitizedSourceDocument(
  html: string,
  scriptNonce: string | undefined,
  allowNetworkImages: boolean
): string {
  const encoded = JSON.stringify(html).replace(/</gu, "\\u003c");
  const nonceAttribute = scriptNonce ? ` nonce="${scriptNonce}"` : "";
  return [
    '<main id="kanna-companion-content"></main>',
    `<script id="kanna-companion-source" type="application/json">${encoded}</script>`,
    `<script id="kanna-companion-render"${nonceAttribute}>
(function() {
  'use strict';
  var source = document.getElementById('kanna-companion-source');
  var target = document.getElementById('kanna-companion-content');
  if (!source || !target) return;
  var parsed;
  try {
    parsed = new DOMParser().parseFromString(JSON.parse(source.textContent || '""'), 'text/html');
  } catch (_) {
    return;
  }
  var allowedElements = new Set([
    'html', 'head', 'body', 'title', 'style',
    'main', 'section', 'article', 'header', 'footer', 'nav', 'aside',
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'blockquote',
    'hr', 'br', 'strong', 'em', 'b', 'i', 'u', 'small', 's', 'mark',
    'sub', 'sup', 'figure', 'figcaption', 'picture', 'source', 'img',
    'button', 'input', 'label', 'select', 'option', 'textarea',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup',
    'col', 'caption', 'details', 'summary', 'progress', 'meter',
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
    'polygon', 'text', 'tspan', 'defs', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker',
    'desc'
  ]);
  var allowedAttributes = new Set([
    'id', 'class', 'title', 'role', 'tabindex', 'hidden', 'dir', 'lang',
    'style', 'alt', 'width', 'height', 'loading', 'decoding', 'src',
    'type', 'disabled', 'name', 'value', 'checked', 'selected',
    'multiple', 'placeholder', 'rows', 'cols', 'for', 'scope',
    'colspan', 'rowspan', 'open', 'max', 'min', 'low', 'high', 'optimum',
    'viewbox', 'preserveaspectratio', 'd', 'x', 'y', 'x1', 'y1', 'x2',
    'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
    'stroke-dashoffset', 'stroke-opacity', 'opacity', 'display',
    'visibility', 'font-family', 'font-size', 'font-style', 'font-weight',
    'text-anchor', 'dominant-baseline', 'offset', 'stop-color',
    'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
    'patternunits', 'patterncontentunits', 'patterntransform',
    'markerwidth', 'markerheight', 'refx', 'refy', 'orient',
    'markerunits', 'clippathunits', 'maskunits', 'maskcontentunits',
    'clip-path', 'clip-rule', 'mask', 'filter'
  ]);
  var safeFileSource = /^\\/files\\/[A-Za-z0-9._-]+$/;
  var safeInlineImage = /^data:image\\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;
  var safeNetworkImage = ${allowNetworkImages ? "/^https:\\/\\/[^\\s\"'<>]+$/i" : "/(?!)/"};
  var unsafeStyle = /(?:@import|expression\\s*\\(|url\\s*\\(|-moz-binding)/i;
  parsed.querySelectorAll('*').forEach(function(node) {
    var elementName = node.localName.toLowerCase();
    if (!allowedElements.has(elementName)) {
      node.replaceChildren();
      node.remove();
      return;
    }
    if (elementName === 'style' && unsafeStyle.test(node.textContent || '')) {
      node.replaceChildren();
      node.remove();
      return;
    }
    var rejectedImageSource = null;
    Array.from(node.attributes).forEach(function(attribute) {
      var name = attribute.name.toLowerCase();
      var value = attribute.value;
      var allowed = allowedAttributes.has(name) ||
        name.startsWith('aria-') ||
        name.startsWith('data-');
      if (
        !allowed ||
        name.startsWith('on') ||
        name.endsWith(':href') ||
        (name === 'src' && elementName !== 'img' && elementName !== 'source') ||
        (name === 'src' &&
          !safeFileSource.test(value) &&
          !safeInlineImage.test(value) &&
          !safeNetworkImage.test(value)) ||
        (name === 'style' && unsafeStyle.test(value)) ||
        (['fill', 'stroke', 'clip-path', 'mask', 'filter'].includes(name) &&
          /url\\s*\\(/i.test(value) &&
          !/^url\\(#[A-Za-z0-9_-]+\\)$/i.test(value))
      ) {
        if (name === 'src' && elementName === 'img') {
          rejectedImageSource = value;
        }
        node.removeAttribute(attribute.name);
      }
    });
    if (elementName === 'img' && rejectedImageSource !== null) {
      var placeholder = parsed.createElement('span');
      var placeholderText = 'Image unavailable: ' + rejectedImageSource
        + ' (local image was not prepared safely).';
      placeholder.className = 'kanna-companion-image-placeholder';
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', placeholderText);
      placeholder.textContent = placeholderText;
      node.replaceWith(placeholder);
    }
  });
  Array.from(parsed.head.children).forEach(function(node) {
    document.head.appendChild(node);
  });
  Array.from(parsed.body.childNodes).forEach(function(node) {
    target.appendChild(node);
  });
  source.remove();
})();
</script>`
  ].join("");
}

function browserScriptNonce(seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `kanna-${(hash >>> 0).toString(36)}`;
}

export interface BuildCompanionDocumentInput {
  documentKind: CompanionDocumentKind;
  html: string;
  target: CompanionDeliveryTarget;
}

export function buildCompanionDocument({
  documentKind,
  html,
  target
}: BuildCompanionDocumentInput): string {
  const scriptNonce =
    target.kind === "websocket"
      ? browserScriptNonce(
          `${target.path}\u0000${target.sessionId}\u0000${target.revision}\u0000${html}`
        )
      : undefined;
  const head = [
    securityHead(target, scriptNonce),
    IMAGE_PLACEHOLDER_STYLE,
    target.kind === "websocket" ? WEBSOCKET_STATUS_STYLE : ""
  ].join("");
  const bridge =
    target.kind === "react-native"
      ? REACT_NATIVE_BRIDGE
      : websocketBridge(target, scriptNonce!);
  if (target.kind === "websocket") {
    return [
      "<!doctype html><html><head>",
      head,
      documentKind === "fragment" ? FRAGMENT_STYLE : "",
      "</head><body>",
      sanitizedSourceDocument(html, scriptNonce, false),
      websocketStatus(target),
      bridge,
      "</body></html>"
    ].join("");
  }

  return [
    "<!doctype html><html><head>",
    head,
    documentKind === "fragment" ? FRAGMENT_STYLE : "",
    "</head><body>",
    sanitizedSourceDocument(html, undefined, true),
    bridge,
    "</body></html>"
  ].join("");
}
