//! Keeps the packaged app's local-network declaration aligned with the
//! Bonjour services registered by its bundled sidecars.

#[test]
fn desktop_bundle_declares_every_bonjour_service() {
    let info_plist = include_str!("../Info.plist");

    for service in ["_kanna-mobile._tcp", "_kanna-xfer._tcp"] {
        assert!(
            info_plist.contains(&format!("<string>{service}</string>")),
            "Info.plist must declare {service} in NSBonjourServices"
        );
    }
    assert!(
        info_plist.contains("<key>NSLocalNetworkUsageDescription</key>"),
        "Info.plist must explain Kanna's local-network use"
    );
}
