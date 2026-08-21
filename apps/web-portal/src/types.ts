export type EntitlementStatus = "active" | "grace" | "expired" | "revoked";

export interface CloudEntitlement {
  status: EntitlementStatus;
  source: "stripe" | "app_store" | "comp" | "free_beta" | "grandfathered" | "promo";
  capabilities: string[];
  currentPeriodEndsAt: unknown | null;
  graceEndsAt: unknown | null;
  environment: string;
}
