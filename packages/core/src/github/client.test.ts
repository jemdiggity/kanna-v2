import { describe, it, expect } from "vitest";
import { parseGitHubRemote } from "./client.js";

describe("parseGitHubRemote", () => {
  it("parses SSH URL with .git suffix", () => {
    const result = parseGitHubRemote("git@github.com:octocat/hello-world.git");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseGitHubRemote("git@github.com:octocat/hello-world");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses HTTPS URL with .git suffix", () => {
    const result = parseGitHubRemote(
      "https://github.com/octocat/hello-world.git"
    );
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses HTTPS URL without .git suffix", () => {
    const result = parseGitHubRemote("https://github.com/octocat/hello-world");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("returns null for a non-GitHub URL", () => {
    expect(parseGitHubRemote("https://gitlab.com/octocat/hello-world.git")).toBeNull();
  });

  it("returns null for a generic SSH URL", () => {
    expect(parseGitHubRemote("git@bitbucket.org:octocat/hello-world.git")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseGitHubRemote("")).toBeNull();
  });

  it("returns null for a plain path", () => {
    expect(parseGitHubRemote("/home/user/project")).toBeNull();
  });
});
