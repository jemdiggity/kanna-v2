import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import CheckoutReturnPage from "../src/pages/CheckoutReturnPage.vue";
import SubscribePage from "../src/pages/SubscribePage.vue";
import AccountPage from "../src/pages/AccountPage.vue";
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
    createCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.test/session" })),
    deleteAccount: vi.fn(async () => undefined),
    ...overrides
  } as PortalFirebase;
}

describe("checkout pages", () => {
  it("calls Checkout with local return URLs", async () => {
    const mockApi = api();
    const redirect = vi.fn();
    const host = { template: "<SubscribePage :redirect=\"redirect\" />", components: { SubscribePage }, setup() { providePortalSession(mockApi); return { redirect }; } };
    const mounted = mount(host);
    await mounted.get("button").trigger("click");
    expect(mockApi.createCheckoutSession).toHaveBeenCalledWith({
      successUrl: `${window.location.origin}/checkout/success`,
      cancelUrl: `${window.location.origin}/checkout/cancelled`
    });
    expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("shows the launch price and every currency it is sold in", async () => {
    // The headline comes from the build environment (`VITE_KANNA_CLOUD_PRICE`,
    // defaulted by `kd cloud deploy`); the matrix is the owner's 2026-08-21
    // pricing ruling — `docs/specs/accounts-and-billing.md`.
    const mockApi = api();
    const host = {
      template: "<SubscribePage />",
      components: { SubscribePage },
      setup() { providePortalSession(mockApi); }
    };
    const wrapper = mount(host);
    expect(wrapper.get(".price").text()).toBe("$5/month");
    const currencies = wrapper.get(".currencies").text();
    for (const amount of ["¥500 JPY", "$5 USD", "$5 CAD", "$5 AUD", "€5 EUR", "£5 GBP"]) {
      expect(currencies).toContain(amount);
    }
    expect(currencies).not.toContain("$10");
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
      template: '<CheckoutReturnPage result="cancelled" />',
      components: { CheckoutReturnPage },
      setup() {
        providePortalSession(api());
      }
    };
    const wrapper = mount(host, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("Checkout cancelled");
    expect(wrapper.text()).toContain("No charge was made");
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
