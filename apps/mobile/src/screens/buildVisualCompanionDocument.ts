import type { CompanionDocumentKind } from "@kanna/agent-protocol";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src https: data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "navigate-to 'none'"
].join("; ");

const SECURITY_HEAD = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`
].join("");

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

// This script is constant. Companion HTML is composed beside it, never embedded
// in a JavaScript literal.
const COMPANION_BRIDGE = `<script id="kanna-companion-bridge">
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

export interface BuildVisualCompanionDocumentInput {
  documentKind: CompanionDocumentKind;
  html: string;
}

export function buildVisualCompanionDocument({
  documentKind,
  html
}: BuildVisualCompanionDocumentInput): string {
  if (documentKind === "full_document") {
    // Prefix the policy instead of searching attacker-controlled markup for a
    // head tag. The explicit Kanna head is parsed before the nested source
    // document, and an anchored doctype removal keeps the output well-formed.
    const source = html.replace(/^\s*<!doctype\s+html[^>]*>/i, "");
    return [
      "<!doctype html><html><head>",
      SECURITY_HEAD,
      "</head>",
      source,
      COMPANION_BRIDGE,
      "</html>"
    ].join("");
  }

  return [
    "<!doctype html><html><head>",
    SECURITY_HEAD,
    FRAGMENT_STYLE,
    "</head><body><main id=\"kanna-companion-content\">",
    html,
    "</main>",
    COMPANION_BRIDGE,
    "</body></html>"
  ].join("");
}
