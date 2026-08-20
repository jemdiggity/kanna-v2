import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import CheckoutReturnPage from "../src/pages/CheckoutReturnPage.vue";
import SubscribePage from "../src/pages/SubscribePage.vue";
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
