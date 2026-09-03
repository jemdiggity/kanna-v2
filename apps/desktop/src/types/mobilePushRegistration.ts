/**
 * Whether the account this desktop is signed into currently has a mobile push
 * device registered. Produced by `kanna-server`'s
 * `GET /v1/mobile/notifications/registration`, which asks the relay to resolve
 * delivery targets without sending through a distinct registration probe (the
 * `mobile_push_registration_status` Tauri command relays it).
 */
export interface MobilePushNoDevicesReason {
  /** `neverRegistered`, `unregistered`, `tokenRejected`, or `unknown`. */
  code: string
  message: string
  retiredAt?: string
  providerCode?: string
  retiredByDesktopId?: string
}

export interface MobilePushRegistrationStatus {
  status: "registered" | "noRegisteredDevices" | "unavailable"
  registeredDeviceCount: number
  noDevicesReason?: MobilePushNoDevicesReason
  error?: string
}
