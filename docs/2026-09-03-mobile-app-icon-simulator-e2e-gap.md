# Mobile app icon simulator E2E gap

Date: 2026-09-03

The corrected mobile app icon should be verified on an installed iOS simulator build because the platform applies the final home-screen mask. That installation could not complete with the current local toolchain. From the canonical `./kd dev up --mobile` environment, Expo prebuild and CocoaPods completed, but Xcode 26 stopped while compiling the existing `expo-modules-jsi` 57.0.5 dependency:

```text
RuntimeScheduler.h:61:26: 'RuntimeScheduler' cannot be annotated with either
SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED because it is not returning
a SWIFT_SHARED_REFERENCE type
```

This failure occurs in an unchanged dependency before the Kanna app is installed. Simulator verification becomes available when the Expo module supports this Xcode compiler or the repository's native dependency set is updated compatibly.

Narrower coverage in this task verifies that:

- the legacy/iOS PNG is opaque and full-bleed, without the desktop icon's baked-in rounded outer mask;
- the Android adaptive foreground is transparent and remains inside its safe zone, with a separate opaque background;
- Expo configuration selects those assets and the new native runtime version;
- Expo iOS prebuild generates the expected native 1024×1024 AppIcon, which was visually inspected from the gitignored task screenshot directory.
