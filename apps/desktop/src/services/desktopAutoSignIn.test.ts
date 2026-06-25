import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDesktopAutoSignIn } from "./desktopAutoSignIn";
import type { DesktopAuthSession, DesktopAuthState } from "./desktopAuth";

function createSession(state: DesktopAuthState = { status: "signedOut" }): DesktopAuthSession {
  return {
    initialize: vi.fn(),
    getState: vi.fn(() => state),
    subscribe: vi.fn(),
    signInWithEmailPassword: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn(),
  };
}

function createReadEnv(values: Record<string, string | undefined>) {
  return vi.fn(async (name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`missing env: ${name}`);
    }
    return value;
  });
}

describe("runDesktopAutoSignIn", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("signs in when a dev staging desktop is signed out and credentials are present", async () => {
    const session = createSession();

    await runDesktopAutoSignIn({
      dev: true,
      session,
      getState: () => ({ status: "signedOut" }),
      readEnv: createReadEnv({
        KANNA_CLOUD_ENV: "staging",
        KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "secret",
      }),
    });

    expect(session.signInWithEmailPassword).toHaveBeenCalledWith({
      email: "dev@example.com",
      password: "secret",
    });
  });

  it("does nothing when already signed in", async () => {
    const session = createSession({
      status: "signedIn",
      user: { uid: "user-1", email: "dev@example.com", displayName: null },
    });
    const readEnv = createReadEnv({
      KANNA_CLOUD_ENV: "staging",
      KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
      KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "secret",
    });

    await runDesktopAutoSignIn({
      dev: true,
      session,
      getState: () => session.getState(),
      readEnv,
    });

    expect(session.signInWithEmailPassword).not.toHaveBeenCalled();
    expect(readEnv).not.toHaveBeenCalled();
  });

  it("does nothing outside dev staging", async () => {
    const session = createSession();

    await runDesktopAutoSignIn({
      dev: false,
      session,
      getState: () => ({ status: "signedOut" }),
      readEnv: createReadEnv({
        KANNA_CLOUD_ENV: "staging",
        KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "secret",
      }),
    });

    expect(session.signInWithEmailPassword).not.toHaveBeenCalled();

    const productionSession = createSession();

    await runDesktopAutoSignIn({
      dev: true,
      session: productionSession,
      getState: () => ({ status: "signedOut" }),
      readEnv: createReadEnv({
        KANNA_CLOUD_ENV: "production",
        KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "secret",
      }),
    });

    expect(productionSession.signInWithEmailPassword).not.toHaveBeenCalled();
  });

  it("does nothing when credentials are incomplete", async () => {
    const session = createSession();

    await runDesktopAutoSignIn({
      dev: true,
      session,
      getState: () => ({ status: "signedOut" }),
      readEnv: createReadEnv({
        KANNA_CLOUD_ENV: "staging",
        KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
      }),
    });

    expect(session.signInWithEmailPassword).not.toHaveBeenCalled();
  });

  it("does not retry a failed auto sign-in for the same session", async () => {
    const session = createSession();
    vi.mocked(session.signInWithEmailPassword).mockRejectedValue(new Error("auth failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readEnv = createReadEnv({
      KANNA_CLOUD_ENV: "staging",
      KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
      KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "secret",
    });

    await runDesktopAutoSignIn({
      dev: true,
      session,
      getState: () => ({ status: "signedOut" }),
      readEnv,
    });
    await runDesktopAutoSignIn({
      dev: true,
      session,
      getState: () => ({ status: "signedOut" }),
      readEnv,
    });

    expect(session.signInWithEmailPassword).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[cloud] desktop auto sign-in failed:", expect.any(Error));
  });
});
