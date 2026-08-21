import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

const portalFirebase = vi.hoisted(() => ({
  observeUser: vi.fn((callback: (user: null) => void) => {
    callback(null);
    return () => undefined;
  }),
  register: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  reloadUser: vi.fn(),
  entitlement: vi.fn(async () => null),
  createCheckoutSession: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock("../src/firebase", () => ({ portalFirebase }));

import App from "../src/App.vue";
import SignInPage from "../src/pages/SignInPage.vue";

describe("App", () => {
  it("mounts cold and renders the sign-in screen", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/sign-in", component: SignInPage, meta: { public: true } },
        { path: "/register", component: { template: "<div>Create account</div>" }, meta: { public: true } },
        { path: "/account", component: { template: "<div>Account</div>" } },
      ],
    });
    await router.push("/sign-in");
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get("h1").text()).toBe("Sign in");
    expect(portalFirebase.observeUser).toHaveBeenCalledOnce();
  });
});
