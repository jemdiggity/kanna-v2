import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { auth, portalFirebase } from "../src/firebase";
import AccountPage from "../src/pages/AccountPage.vue";
import { providePortalSession } from "../src/session";

const run = process.env.KANNA_RUN_WEB_PORTAL_ACCOUNT_DELETION_INTEGRATION === "1";
const integration = run ? describe : describe.skip;
const projectId = "kanna-local";
const authPort = process.env.KANNA_FIREBASE_AUTH_PORT || "9099";

integration("web portal account deletion system flow", () => {
  it("confirms in the account UI, invokes the authenticated callable, deletes Auth, and signs out", async () => {
    await fetch(`http://127.0.0.1:${authPort}/emulator/v1/projects/${projectId}/accounts`, {
      method: "DELETE",
    });
    const email = `portal-delete-${Date.now()}@example.test`;
    const password = "correct-horse-battery-staple";
    const user = await portalFirebase.register(email, password);
    const host = {
      template: "<AccountPage />",
      components: { AccountPage },
      setup() {
        const session = providePortalSession(portalFirebase);
        session.user.value = user;
      },
    };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div />" } },
        { path: "/subscribe", component: { template: "<div />" } },
      ],
    });
    await router.push("/");
    await router.isReady();
    const wrapper = mount(host, { global: { plugins: [router] } });

    await wrapper.get(".danger-button").trigger("click");
    await wrapper.get(".delete-confirmation input").setValue("DELETE");
    await wrapper.get(".delete-confirmation").trigger("submit");

    await expect.poll(() => auth.currentUser).toBeNull();
    await expect(portalFirebase.signIn(email, password)).rejects.toMatchObject({
      code: "auth/user-not-found",
    });
  }, 30_000);
});
