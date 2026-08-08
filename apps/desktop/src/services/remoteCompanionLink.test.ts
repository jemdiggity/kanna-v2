import { describe, expect, it } from "vitest";
import { resolveRemoteCompanionLink } from "./remoteCompanionLink";

describe("resolveRemoteCompanionLink", () => {
  it("recognizes only the exact normalized active loopback origin", () => {
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://LOCALHOST:52341/files/view.css?theme=dark#top",
      sourceOrigin: "http://localhost:52341/",
    })).toEqual({ kind: "companion" });

    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost:52342",
      sourceOrigin: "http://localhost:52341",
    })).toEqual({ kind: "ordinary", url: "http://localhost:52342/" });

    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://127.0.0.1:52341",
      sourceOrigin: "http://localhost:52341",
    })).toEqual({ kind: "ordinary", url: "http://127.0.0.1:52341/" });

    expect(resolveRemoteCompanionLink({
      clickedUrl: "https://example.com",
      sourceOrigin: "http://localhost:52341",
    })).toEqual({ kind: "ordinary", url: "https://example.com/" });
  });

  it("does not translate arbitrary localhost links when the source is absent or invalid", () => {
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost:52341",
    })).toEqual({ kind: "ordinary", url: "http://localhost:52341/" });

    for (const sourceOrigin of [
      "http://localhost",
      "http://example.com:52341",
      "https://localhost:52341",
      "http://localhost:52341/path",
      "http://localhost:52341/?query=1",
      "http://user@localhost:52341",
      "http://localhost:0",
      "http://127.1:52341",
      "http://2130706433:52341",
      "http://[0:0:0:0:0:0:0:1]:52341",
    ]) {
      expect(resolveRemoteCompanionLink({
        clickedUrl: "http://localhost:52341",
        sourceOrigin,
      })).toEqual({ kind: "ordinary", url: "http://localhost:52341/" });
    }
  });

  it("rejects unsafe or unsupported clicked URLs without producing an opener URL", () => {
    for (const clickedUrl of [
      "not a URL",
      "file:///tmp/companion.html",
      "javascript:alert(1)",
      "http://user:secret@localhost:52341",
    ]) {
      expect(resolveRemoteCompanionLink({
        clickedUrl,
        sourceOrigin: "http://localhost:52341",
      })).toEqual({ kind: "invalid" });
    }
  });

  it("requires an explicit valid port even when URL normalization would hide a default port", () => {
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost:80",
      sourceOrigin: "http://localhost:80",
    })).toEqual({ kind: "companion" });
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost",
      sourceOrigin: "http://localhost",
    })).toEqual({ kind: "ordinary", url: "http://localhost/" });
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost:0",
      sourceOrigin: "http://localhost:0",
    })).toEqual({ kind: "ordinary", url: "http://localhost:0/" });
  });

  it("supports each validated loopback spelling without treating spellings as aliases", () => {
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://127.0.0.1:3210/a",
      sourceOrigin: "http://127.0.0.1:3210",
    })).toEqual({ kind: "companion" });
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://[::1]:3210/a",
      sourceOrigin: "http://[::1]:3210",
    })).toEqual({ kind: "companion" });
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://localhost:3210/a",
      sourceOrigin: "http://127.0.0.1:3210",
    })).toEqual({ kind: "ordinary", url: "http://localhost:3210/a" });
    expect(resolveRemoteCompanionLink({
      clickedUrl: "http://127.1:3210/a",
      sourceOrigin: "http://127.0.0.1:3210",
    })).toEqual({ kind: "ordinary", url: "http://127.0.0.1:3210/a" });
  });
});
