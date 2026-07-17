import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { buildVisualCompanionDocument } from "./buildVisualCompanionDocument";

describe("buildVisualCompanionDocument", () => {
  it("wraps fragments in a responsive companion document", () => {
    const fragment = '<section data-note="raw"><button data-choice="a">A</button></section>';
    const document = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: fragment
    });

    expect(document).toMatch(/^<!doctype html>/i);
    expect(document).toContain('<meta name="viewport"');
    expect(document).toContain('<main id="kanna-companion-content">');
    expect(document).toContain(fragment);
    expect(document).toContain(".option.selected");
    expect(document).toContain(".cards {");
    expect(document).toContain(".split {");
  });

  it("adds a restrictive CSP while allowing inline companion UI and remote images", () => {
    const document = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: "<p>Companion</p>"
    });

    expect(document).toContain("default-src 'none'");
    expect(document).toContain("style-src 'unsafe-inline'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("img-src https: data:");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("navigate-to 'none'");
  });

  it("preserves a full document body and injects the policy and bridge", () => {
    const source = [
      "<!doctype html>",
      "<html><head><title>Agent UI</title></head>",
      '<body><article id="kept">Keep me</article></body></html>'
    ].join("");
    const document = buildVisualCompanionDocument({
      documentKind: "full_document",
      html: source
    });

    expect(document).toContain('<article id="kept">Keep me</article>');
    expect(document).toContain("<title>Agent UI</title>");
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
      document.indexOf("</head>")
    );
    expect(document).toContain("kanna-companion-bridge");

    const window = new Window();
    window.document.write(document);
    expect(
      window.document.head.querySelector(
        'meta[http-equiv="Content-Security-Policy"]'
      )
    ).not.toBeNull();
    expect(window.document.body.querySelector("#kept")?.textContent).toBe(
      "Keep me"
    );
    expect(
      window.document.body.querySelector("#kanna-companion-bridge")
    ).not.toBeNull();
  });

  it("defines the companion single- and multi-select contract", () => {
    const document = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: "<div></div>"
    });

    expect(document).toContain("window.toggleSelect = function(el)");
    expect(document).toContain("container.dataset.multiselect !== undefined");
    expect(document).toContain("querySelectorAll('.option, .card')");
    expect(document).toContain("el.classList.toggle('selected')");
    expect(document).toContain("el.classList.add('selected')");
    expect(document).toContain("window.selectedChoice = el.dataset.choice");
  });

  it("posts only a constrained data-choice click event to React Native", () => {
    const document = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>'
    });

    expect(document).toContain("origin.closest('[data-choice]')");
    expect(document).toContain(
      "if (!target.hasAttribute('onclick')) window.toggleSelect(target)"
    );
    expect(document).toContain("type: 'companion-event'");
    expect(document).toContain("type: 'click'");
    expect(document).toContain("choice: target.dataset.choice");
    expect(document).toContain("text: (target.textContent || '').trim().slice(0, 4096)");
    expect(document).toContain("id: target.id ? target.id.slice(0, 256) : null");
    expect(document).toContain("timestamp: Date.now()");
    expect(document).toContain("window.ReactNativeWebView.postMessage(JSON.stringify(message))");
    expect(document).not.toContain("new WebSocket");
    expect(document).not.toContain("window.brainstorm");
  });

  it("keeps hostile script-like HTML out of the constant bridge source", () => {
    const hostile = '<pre>` ${window.pwned} </script><script>window.agentScript = true</script></pre>';
    const baseline = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: ""
    });
    const document = buildVisualCompanionDocument({
      documentKind: "fragment",
      html: hostile
    });

    expect(document).toContain(hostile);
    expect(document.replace(hostile, "")).toBe(baseline);
  });
});
