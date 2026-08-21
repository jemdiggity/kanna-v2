import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { User } from "firebase/auth";
import CheckoutReturnPage from "../src/pages/CheckoutReturnPage.vue";
import SubscribePage from "../src/pages/SubscribePage.vue";
import AccountPage from "../src/pages/AccountPage.vue";
import VerifyEmailPage from "../src/pages/VerifyEmailPage.vue";
import { providePortalSession } from "../src/session";
import type { PortalFirebase } from "../src/firebase";

function api(overrides: Partial<PortalFirebase> = {}): PortalFirebase {
  return {
    observeUser: vi.fn(() => () => undefined),
    register: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    reloadUser: vi.fn(),
    entitlement: vi.fn(async () => null),
    createCheckoutSession: vi.fn(async () => ({
      sessionId: "cs_test_portal",
      url: "https://checkout.stripe.test/session",
      customerId: "cus_test_portal",
      plan: "monthly",
    })),
    deleteAccount: vi.fn(async () => undefined),
    ...overrides
  } as PortalFirebase;
}

describe("checkout pages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends the shared monthly checkout request without choosing a currency", async () => {
    const mockApi = api();
    const redirect = vi.fn();
    const host = { template: "<SubscribePage :redirect=\"redirect\" />", components: { SubscribePage }, setup() { providePortalSession(mockApi); return { redirect }; } };
    const mounted = mount(host);
    await mounted.get("button").trigger("click");
    expect(mockApi.createCheckoutSession).toHaveBeenCalledWith({
      plan: "monthly",
    });
    expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("shows an error and does not redirect when Stripe returns a null URL", async () => {
    const mockApi = api({
      createCheckoutSession: vi.fn(async () => ({
        sessionId: "cs_test_null",
        url: null,
        customerId: "cus_test_null",
        plan: "monthly" as const,
      })),
    });
    const redirect = vi.fn();
    const host = {
      template: '<SubscribePage :redirect="redirect" />',
      components: { SubscribePage },
      setup() { providePortalSession(mockApi); return { redirect }; },
    };
    const wrapper = mount(host);

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("did not return a Checkout URL");
    expect(redirect).not.toHaveBeenCalled();
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
  });

  it.each([
    ["ja-JP", "¥500/month"],
    ["en-US", "$5/month"],
    ["en-CA", "C$5/month"],
    ["en-AU", "A$5/month"],
    ["en-GB", "£5/month"],
    ["de-DE", "€5/month"],
    ["es-MX", "$5/month"],
  ])("maps browser locale %s to the formatted local price %s", (locale, expectedPrice) => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue(locale);
    const mockApi = api();
    const host = {
      template: "<SubscribePage />",
      components: { SubscribePage },
      setup() { providePortalSession(mockApi); }
    };
    const wrapper = mount(host);

    expect(wrapper.get(".price").text()).toBe(expectedPrice);
    expect(wrapper.get(".local-currency").text()).toBe("Charged in your local currency at checkout.");
    expect(wrapper.find(".currencies").exists()).toBe(false);
    expect(wrapper.find("select").exists()).toBe(false);
  });

  it("keeps a non-default build price as an explicit headline override", () => {
    vi.stubEnv("VITE_KANNA_CLOUD_PRICE", "$12/month");
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("ja-JP");
    const mockApi = api();
    const host = {
      template: "<SubscribePage />",
      components: { SubscribePage },
      setup() { providePortalSession(mockApi); }
    };

    const wrapper = mount(host);

    expect(wrapper.get(".price").text()).toBe("$12/month");
  });

  it("renders the cancelled return state", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div />" } },
        { path: "/subscribe", component: { template: "<div />" } }
      ]
    });
    const host = {
      template: '<CheckoutReturnPage result="canceled" />',
      components: { CheckoutReturnPage },
      setup() {
        providePortalSession(api());
      }
    };
    const wrapper = mount(host, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("Checkout cancelled");
    expect(wrapper.text()).toContain("No charge was made");
  });

  it("confirms the active subscription without displaying the Stripe session id", () => {
    const host = {
      template: '<CheckoutReturnPage result="success" session-id="cs_test_return" />',
      components: { CheckoutReturnPage },
      setup() { providePortalSession(api()); },
    };
    const wrapper = mount(host, { global: { stubs: { RouterLink: true } } });

    expect(wrapper.text()).toContain("Your subscription is active.");
    expect(wrapper.text()).not.toContain("cs_test_return");
    expect(wrapper.get("router-link-stub").attributes("to")).toBe("/account");
  });
});

describe("email verification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances automatically when a polling refresh reports a verified user", async () => {
    vi.useFakeTimers();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/verify-email", component: { template: "<div />" } },
        { path: "/subscribe", component: { template: "<div />" } },
      ],
    });
    await router.push("/verify-email");
    await router.isReady();
    const verifiedUser = { uid: "user-1", email: "owner@example.com", emailVerified: true } as User;
    const mockApi = api({ reloadUser: vi.fn(async () => verifiedUser) });
    const host = {
      template: "<VerifyEmailPage />",
      components: { VerifyEmailPage },
      setup() {
        const session = providePortalSession(mockApi);
        session.user.value = { ...verifiedUser, emailVerified: false } as typeof session.user.value;
      },
    };
    const wrapper = mount(host, { global: { plugins: [router] } });

    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();

    expect(mockApi.reloadUser).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe("/subscribe");
    wrapper.unmount();
  });
});

describe("account deletion", () => {
  it("requires typed confirmation, calls the backend, and signs out through the shared API", async () => {
    const deleteAccount = vi.fn(async () => undefined);
    const mockApi = api({ deleteAccount });
    const host = {
      template: "<AccountPage />",
      components: { AccountPage },
      setup() {
        const session = providePortalSession(mockApi);
        session.user.value = {
          uid: "user-1",
          email: "owner@example.com",
          emailVerified: true,
        } as typeof session.user.value;
        session.entitlement.value = {
          status: "active",
          source: "stripe",
          capabilities: [],
          currentPeriodEndsAt: null,
          graceEndsAt: null,
          environment: "staging",
        };
      }
    };
    const wrapper = mount(host);

    await wrapper.get(".danger-button").trigger("click");
    expect(wrapper.text()).toContain("subscription is canceled immediately");
    expect(wrapper.text()).toContain("cloud desktop pairings");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();

    await wrapper.get(".delete-confirmation input").setValue("DELETE");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
    await wrapper.get(".delete-confirmation").trigger("submit");
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(mockApi.signOut).toHaveBeenCalledOnce();
  });
});
