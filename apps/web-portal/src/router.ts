import { createRouter, createWebHistory, type RouteLocationNormalized } from "vue-router";
import AccountPage from "./pages/AccountPage.vue";
import CheckoutReturnPage from "./pages/CheckoutReturnPage.vue";
import RegisterPage from "./pages/RegisterPage.vue";
import SignInPage from "./pages/SignInPage.vue";
import SubscribePage from "./pages/SubscribePage.vue";
import VerifyEmailPage from "./pages/VerifyEmailPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/account" },
    { path: "/register", component: RegisterPage, meta: { public: true } },
    { path: "/sign-in", component: SignInPage, meta: { public: true } },
    { path: "/verify-email", component: VerifyEmailPage },
    { path: "/subscribe", component: SubscribePage, meta: { verified: true } },
    { path: "/checkout/success", component: CheckoutReturnPage, props: { result: "success" }, meta: { verified: true } },
    { path: "/checkout/cancelled", component: CheckoutReturnPage, props: { result: "cancelled" }, meta: { verified: true } },
    { path: "/account", component: AccountPage }
  ]
});

export interface AuthRouteState {
  signedIn: boolean;
  emailVerified: boolean;
  subscribed: boolean;
}

export function authRedirect(to: RouteLocationNormalized, state: AuthRouteState): string | undefined {
  if (!state.signedIn && !to.meta.public) return "/sign-in";
  if (state.signedIn && !state.emailVerified && to.path !== "/verify-email") return "/verify-email";
  if (state.signedIn && state.emailVerified && to.path === "/verify-email") return state.subscribed ? "/account" : "/subscribe";
  if (state.subscribed && to.path === "/subscribe") return "/account";
  return undefined;
}
