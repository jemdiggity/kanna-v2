use base64::Engine;
use kanna_task_transfer::crypto::{
    artifact_stream_context, open_json, parse_public_key, public_key_to_string, seal_json,
    CryptoError, StreamOpener, StreamSealer, TransferIdentity,
};
use kanna_task_transfer::discovery::{decode_txt_record, encode_txt_record, DiscoveryError};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[test]
fn discovery_txt_roundtrips_peer_metadata() {
    let txt = encode_txt_record("peer-alpha", "Jeremy's MBP", "pubkey-alpha", 1, true).unwrap();
    let decoded = decode_txt_record(&txt).unwrap();

    assert_eq!(decoded.peer_id, "peer-alpha");
    assert_eq!(decoded.display_name, "Jeremy's MBP");
    assert_eq!(decoded.public_key, "pubkey-alpha");
    assert_eq!(decoded.protocol_version, 1);
    assert!(decoded.accepting_transfers);
}

#[test]
fn encrypted_payload_roundtrips() {
    let sender = TransferIdentity::generate();
    let receiver = TransferIdentity::generate();
    let payload = json!({
        "transfer_id": "tx-1",
        "task_id": "task-1",
        "provider": "claude",
    });

    let sealed = seal_json(&sender, &receiver.public_key, &payload).unwrap();
    let envelope: Value = serde_json::from_str(&sealed).unwrap();
    let ephemeral_public_key = envelope["ephemeral_public_key"].as_str().unwrap();
    let opened = open_json(&receiver, &sender.public_key, &sealed).unwrap();

    assert!(parse_public_key(ephemeral_public_key).is_ok());
    assert_eq!(opened, payload);
}

#[test]
fn artifact_stream_chunks_are_sequence_and_final_marker_authenticated() {
    let sender = TransferIdentity::generate();
    let receiver = TransferIdentity::generate();
    let context = b"request-1\0transfer-1\0artifact-1\0size-5";
    let mut sealer = StreamSealer::new(&sender, &receiver.public_key, context).unwrap();
    let header = sealer.header();
    let first = sealer.seal_chunk(b"first", false).unwrap();
    let final_chunk = sealer.seal_chunk(&[], true).unwrap();

    let mut opener = StreamOpener::new(&receiver, &sender.public_key, &header, context).unwrap();
    assert_eq!(opener.open_chunk(0, &first, false).unwrap(), b"first");
    assert!(matches!(
        opener.open_chunk(2, &final_chunk, true),
        Err(CryptoError::UnexpectedStreamSequence {
            expected: 1,
            actual: 2,
        }),
    ));

    let mut opener = StreamOpener::new(&receiver, &sender.public_key, &header, context).unwrap();
    let mut tampered = first;
    tampered[0] ^= 1;
    assert!(matches!(
        opener.open_chunk(0, &tampered, false),
        Err(CryptoError::Decrypt),
    ));

    let mut marker_sealer = StreamSealer::new(&sender, &receiver.public_key, context).unwrap();
    let marker_header = marker_sealer.header();
    let not_final = marker_sealer.seal_chunk(b"not-final", false).unwrap();
    let mut opener =
        StreamOpener::new(&receiver, &sender.public_key, &marker_header, context).unwrap();
    assert!(matches!(
        opener.open_chunk(0, &not_final, true),
        Err(CryptoError::Decrypt),
    ));
}

#[test]
fn artifact_stream_rejects_cross_artifact_substitution_from_the_same_peer() {
    let sender = TransferIdentity::generate();
    let receiver = TransferIdentity::generate();
    let artifact_a = artifact_stream_context("request-1", "transfer-1", "artifact-a", 7);
    let artifact_b = artifact_stream_context("request-2", "transfer-1", "artifact-b", 7);
    let mut sealer = StreamSealer::new(&sender, &receiver.public_key, &artifact_a).unwrap();
    let header = sealer.header();
    let captured_chunk = sealer.seal_chunk(b"payload", false).unwrap();

    let mut substituted =
        StreamOpener::new(&receiver, &sender.public_key, &header, &artifact_b).unwrap();
    assert!(matches!(
        substituted.open_chunk(0, &captured_chunk, false),
        Err(CryptoError::Decrypt),
    ));
}

#[test]
fn malformed_txt_input_is_rejected() {
    let missing_peer_id = BTreeMap::from([
        ("display_name".to_owned(), "Jeremy's MBP".to_owned()),
        ("public_key".to_owned(), "pubkey-alpha".to_owned()),
        ("protocol_version".to_owned(), "1".to_owned()),
        ("accepting_transfers".to_owned(), "1".to_owned()),
    ]);

    let missing_peer_id_error = decode_txt_record(&missing_peer_id).unwrap_err();
    assert_eq!(
        missing_peer_id_error,
        DiscoveryError::MissingField("peer_id")
    );

    let invalid_accepting_transfers = BTreeMap::from([
        ("peer_id".to_owned(), "peer-alpha".to_owned()),
        ("display_name".to_owned(), "Jeremy's MBP".to_owned()),
        ("public_key".to_owned(), "pubkey-alpha".to_owned()),
        ("protocol_version".to_owned(), "1".to_owned()),
        ("accepting_transfers".to_owned(), "yes".to_owned()),
    ]);

    let invalid_accepting_transfers_error =
        decode_txt_record(&invalid_accepting_transfers).unwrap_err();
    assert_eq!(
        invalid_accepting_transfers_error,
        DiscoveryError::InvalidAcceptingTransfers("yes".to_owned())
    );

    let invalid_encode_error =
        encode_txt_record("peer alpha", "Jeremy\nMBP", "pubkey-alpha", 1, true).unwrap_err();
    assert_eq!(invalid_encode_error, DiscoveryError::InvalidPeerId);

    let unknown_field = BTreeMap::from([
        ("peer_id".to_owned(), "peer-alpha".to_owned()),
        ("display_name".to_owned(), "Jeremy's MBP".to_owned()),
        ("public_key".to_owned(), "pubkey-alpha".to_owned()),
        ("protocol_version".to_owned(), "1".to_owned()),
        ("accepting_transfers".to_owned(), "1".to_owned()),
        ("extra".to_owned(), "unexpected".to_owned()),
    ]);

    let decoded = decode_txt_record(&unknown_field).unwrap();
    assert_eq!(decoded.peer_id, "peer-alpha");
}

#[test]
fn txt_entry_255_byte_boundary_is_enforced() {
    let max_display_name = "a".repeat(255 - "display_name=".len());
    let txt = encode_txt_record("peer-alpha", &max_display_name, "pubkey-alpha", 1, true).unwrap();
    let decoded = decode_txt_record(&txt).unwrap();
    assert_eq!(decoded.display_name, max_display_name);

    let too_long_display_name = "a".repeat(256 - "display_name=".len());
    let encode_error = encode_txt_record(
        "peer-alpha",
        &too_long_display_name,
        "pubkey-alpha",
        1,
        true,
    )
    .unwrap_err();
    assert_eq!(
        encode_error,
        DiscoveryError::TxtEntryTooLong {
            field: "display_name".to_owned(),
            length: 256,
        }
    );

    let too_long_unknown_field = BTreeMap::from([("x".repeat(255), "y".to_owned())]);
    let decode_error = decode_txt_record(&too_long_unknown_field).unwrap_err();
    assert_eq!(
        decode_error,
        DiscoveryError::TxtEntryTooLong {
            field: "x".repeat(255),
            length: 257,
        }
    );
}

#[test]
fn unsupported_or_tampered_envelopes_are_rejected() {
    let sender = TransferIdentity::generate();
    let receiver = TransferIdentity::generate();
    let wrong_receiver = TransferIdentity::generate();
    let payload = json!({ "transfer_id": "tx-1", "task_id": "task-1" });

    let sealed = seal_json(&sender, &receiver.public_key, &payload).unwrap();
    let mut envelope: Value = serde_json::from_str(&sealed).unwrap();
    envelope["version"] = json!(2);

    let unsupported_version_error = open_json(
        &receiver,
        &sender.public_key,
        &serde_json::to_string(&envelope).unwrap(),
    )
    .unwrap_err();
    assert!(matches!(
        unsupported_version_error,
        CryptoError::UnsupportedVersion(2)
    ));

    let wrong_key_error = open_json(&wrong_receiver, &sender.public_key, &sealed).unwrap_err();
    assert!(matches!(wrong_key_error, CryptoError::Decrypt));

    let mut tampered_envelope: Value = serde_json::from_str(&sealed).unwrap();
    let ciphertext = tampered_envelope["ciphertext_b64"].as_str().unwrap();
    let mut ciphertext_bytes = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .unwrap();
    ciphertext_bytes[0] ^= 0x01;
    tampered_envelope["ciphertext_b64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(ciphertext_bytes));

    let tampered_ciphertext_error = open_json(
        &receiver,
        &sender.public_key,
        &serde_json::to_string(&tampered_envelope).unwrap(),
    )
    .unwrap_err();
    assert!(matches!(tampered_ciphertext_error, CryptoError::Decrypt));
}

#[test]
fn forged_sender_identity_fails_to_decrypt() {
    let sender = TransferIdentity::generate();
    let forged_sender = TransferIdentity::generate();
    let receiver = TransferIdentity::generate();
    let payload = json!({ "transfer_id": "tx-1", "task_id": "task-1" });

    let sealed = seal_json(&sender, &receiver.public_key, &payload).unwrap();
    let error = open_json(&receiver, &forged_sender.public_key, &sealed).unwrap_err();

    assert!(matches!(error, CryptoError::Decrypt));
}

#[test]
fn public_key_strings_roundtrip() {
    let identity = TransferIdentity::generate();
    let encoded = public_key_to_string(&identity.public_key);
    let decoded = parse_public_key(&encoded).unwrap();

    assert_eq!(decoded.as_bytes(), identity.public_key.as_bytes());
    assert!(matches!(
        parse_public_key("not-a-valid-public-key"),
        Err(CryptoError::Base64(_))
    ));
    assert!(matches!(
        parse_public_key("AA"),
        Err(CryptoError::InvalidPublicKeyLength(1))
    ));
}
