use std::path::PathBuf;

pub async fn register(relay_url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let device_token = generate_device_token();

    let config_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Kanna");
    std::fs::create_dir_all(&config_dir)?;

    let config_path = config_dir.join("server.toml");
    let config_content = format!(
        r#"relay_url = "{}"
device_token = "{}"
daemon_dir = "{}"
db_path = "{}"
"#,
        relay_url,
        device_token,
        config_dir.to_string_lossy(),
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.kanna.app")
            .join("kanna-v2.db")
            .to_string_lossy(),
    );

    std::fs::write(&config_path, &config_content)?;

    println!("Device token generated.");
    println!();
    println!("To complete registration:");
    println!("1. Log in to the Kanna mobile app on your phone");
    println!("2. The app will pair with this device automatically");
    println!();
    println!("Config saved to {}", config_path.display());
    println!("Device token: {}", device_token);

    Ok(())
}

fn generate_device_token() -> String {
    use std::fs::File;
    use std::io::Read;
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .expect("failed to open /dev/urandom")
        .read_exact(&mut bytes)
        .expect("failed to read random bytes");
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}
