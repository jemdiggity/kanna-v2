use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};

const ENVELOPE_VERSION: u32 = 1;
const ENCRYPTION_CONTEXT: &[u8] = b"kanna-task-transfer:sealed-json:v1";
const STREAM_ENCRYPTION_CONTEXT: &[u8] = b"kanna-task-transfer:artifact-stream:v1";
const ARTIFACT_RESPONSE_CONTEXT: &[u8] = b"kanna-task-transfer:artifact-response-metadata:v1";
const KEY_DERIVATION_SALT: &[u8] = b"kanna-task-transfer:key-derivation:v1";

pub struct TransferIdentity {
    secret: StaticSecret,
    pub public_key: PublicKey,
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64 error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("unsupported sealed payload version: {0}")]
    UnsupportedVersion(u32),
    #[error("invalid nonce length: expected 24 bytes, got {0}")]
    InvalidNonceLength(usize),
    #[error("invalid ciphertext length: {0}")]
    InvalidCiphertextLength(usize),
    #[error("invalid public key length: expected 32 bytes, got {0}")]
    InvalidPublicKeyLength(usize),
    #[error("invalid secret key length: expected 32 bytes, got {0}")]
    InvalidSecretKeyLength(usize),
    #[error("shared key derivation failed")]
    KeyDerivation,
    #[error("payload encryption failed")]
    Encrypt,
    #[error("payload decryption failed")]
    Decrypt,
    #[error("unsupported sealed stream version: {0}")]
    UnsupportedStreamVersion(u32),
    #[error("invalid stream nonce prefix length: expected 16 bytes, got {0}")]
    InvalidStreamNoncePrefixLength(usize),
    #[error("unexpected stream chunk sequence: expected {expected}, got {actual}")]
    UnexpectedStreamSequence { expected: u64, actual: u64 },
    #[error("stream chunk sequence exhausted")]
    StreamSequenceExhausted,
}

#[derive(Debug, Serialize, Deserialize)]
struct SealedJsonEnvelope {
    version: u32,
    ephemeral_public_key: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedStreamHeader {
    pub version: u32,
    pub ephemeral_public_key: String,
    pub nonce_prefix_b64: String,
}

pub struct StreamSealer {
    cipher: XChaCha20Poly1305,
    aad: Vec<u8>,
    nonce_prefix: [u8; 16],
    next_sequence: u64,
    header: SealedStreamHeader,
}

pub struct StreamOpener {
    cipher: XChaCha20Poly1305,
    aad: Vec<u8>,
    nonce_prefix: [u8; 16],
    next_sequence: u64,
}

impl TransferIdentity {
    pub fn generate() -> Self {
        let secret = generate_secret();
        let public_key = PublicKey::from(&secret);
        Self { secret, public_key }
    }

    pub fn from_secret_bytes(secret_bytes: [u8; 32]) -> Self {
        let secret = StaticSecret::from(secret_bytes);
        let public_key = PublicKey::from(&secret);
        Self { secret, public_key }
    }

    pub fn secret_key_string(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.secret.to_bytes())
    }

    pub fn from_secret_string(encoded: &str) -> Result<Self, CryptoError> {
        let secret_bytes = URL_SAFE_NO_PAD.decode(encoded)?;
        let secret_array: [u8; 32] = secret_bytes
            .try_into()
            .map_err(|bytes: Vec<u8>| CryptoError::InvalidSecretKeyLength(bytes.len()))?;
        Ok(Self::from_secret_bytes(secret_array))
    }
}

pub fn public_key_to_string(public_key: &PublicKey) -> String {
    URL_SAFE_NO_PAD.encode(public_key.as_bytes())
}

pub fn parse_public_key(encoded: &str) -> Result<PublicKey, CryptoError> {
    let public_key_bytes = URL_SAFE_NO_PAD.decode(encoded)?;
    let public_key_array: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| CryptoError::InvalidPublicKeyLength(bytes.len()))?;
    Ok(PublicKey::from(public_key_array))
}

pub fn artifact_stream_context(
    request_id: &str,
    transfer_id: &str,
    artifact_id: &str,
    plaintext_size: u64,
) -> Vec<u8> {
    let mut context = Vec::with_capacity(
        ARTIFACT_RESPONSE_CONTEXT.len()
            + request_id.len()
            + transfer_id.len()
            + artifact_id.len()
            + 32,
    );
    context.extend_from_slice(ARTIFACT_RESPONSE_CONTEXT);
    append_context_field(&mut context, request_id.as_bytes());
    append_context_field(&mut context, transfer_id.as_bytes());
    append_context_field(&mut context, artifact_id.as_bytes());
    context.extend_from_slice(&plaintext_size.to_be_bytes());
    context
}

pub fn seal_json(
    sender: &TransferIdentity,
    receiver_public: &PublicKey,
    payload: &Value,
) -> Result<String, CryptoError> {
    let ephemeral_secret = generate_secret();
    let ephemeral_public_key = PublicKey::from(&ephemeral_secret);
    let cipher = build_cipher(
        ephemeral_secret.diffie_hellman(receiver_public).as_bytes(),
        sender.secret.diffie_hellman(receiver_public).as_bytes(),
        &sender.public_key,
        receiver_public,
        &ephemeral_public_key,
    )?;
    let plaintext = serde_json::to_vec(payload)?;
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let aad = associated_data(&sender.public_key, receiver_public, &ephemeral_public_key);

    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_ref(),
                aad: aad.as_slice(),
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;

    let envelope = SealedJsonEnvelope {
        version: ENVELOPE_VERSION,
        ephemeral_public_key: public_key_to_string(&ephemeral_public_key),
        nonce_b64: STANDARD.encode(nonce_bytes),
        ciphertext_b64: STANDARD.encode(ciphertext),
    };

    serde_json::to_string(&envelope).map_err(CryptoError::from)
}

pub fn open_json(
    receiver: &TransferIdentity,
    sender_public: &PublicKey,
    sealed: &str,
) -> Result<Value, CryptoError> {
    let envelope: SealedJsonEnvelope = serde_json::from_str(sealed)?;
    if envelope.version != ENVELOPE_VERSION {
        return Err(CryptoError::UnsupportedVersion(envelope.version));
    }

    let ephemeral_public_key = parse_public_key(&envelope.ephemeral_public_key)?;

    let nonce_bytes = STANDARD.decode(envelope.nonce_b64)?;
    if nonce_bytes.len() != 24 {
        return Err(CryptoError::InvalidNonceLength(nonce_bytes.len()));
    }

    let ciphertext = STANDARD.decode(envelope.ciphertext_b64)?;
    if ciphertext.is_empty() {
        return Err(CryptoError::InvalidCiphertextLength(ciphertext.len()));
    }

    let cipher = build_cipher(
        receiver
            .secret
            .diffie_hellman(&ephemeral_public_key)
            .as_bytes(),
        receiver.secret.diffie_hellman(sender_public).as_bytes(),
        sender_public,
        &receiver.public_key,
        &ephemeral_public_key,
    )?;
    let aad = associated_data(sender_public, &receiver.public_key, &ephemeral_public_key);

    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes.as_slice()),
            Payload {
                msg: ciphertext.as_ref(),
                aad: aad.as_slice(),
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;

    serde_json::from_slice(&plaintext).map_err(CryptoError::from)
}

impl StreamSealer {
    pub fn new(
        sender: &TransferIdentity,
        receiver_public: &PublicKey,
        response_context: &[u8],
    ) -> Result<Self, CryptoError> {
        let ephemeral_secret = generate_secret();
        let ephemeral_public_key = PublicKey::from(&ephemeral_secret);
        let cipher = build_cipher(
            ephemeral_secret.diffie_hellman(receiver_public).as_bytes(),
            sender.secret.diffie_hellman(receiver_public).as_bytes(),
            &sender.public_key,
            receiver_public,
            &ephemeral_public_key,
        )?;
        let mut nonce_prefix = [0u8; 16];
        OsRng.fill_bytes(&mut nonce_prefix);
        let aad = stream_associated_data(
            &sender.public_key,
            receiver_public,
            &ephemeral_public_key,
            response_context,
        );
        Ok(Self {
            cipher,
            aad,
            nonce_prefix,
            next_sequence: 0,
            header: SealedStreamHeader {
                version: ENVELOPE_VERSION,
                ephemeral_public_key: public_key_to_string(&ephemeral_public_key),
                nonce_prefix_b64: STANDARD.encode(nonce_prefix),
            },
        })
    }

    pub fn header(&self) -> SealedStreamHeader {
        self.header.clone()
    }

    pub fn seal_chunk(
        &mut self,
        plaintext: &[u8],
        final_chunk: bool,
    ) -> Result<Vec<u8>, CryptoError> {
        let sequence = self.next_sequence;
        let ciphertext = self
            .cipher
            .encrypt(
                XNonce::from_slice(&stream_nonce(&self.nonce_prefix, sequence)),
                Payload {
                    msg: plaintext,
                    aad: stream_chunk_aad(&self.aad, sequence, final_chunk).as_slice(),
                },
            )
            .map_err(|_| CryptoError::Encrypt)?;
        self.next_sequence = sequence
            .checked_add(1)
            .ok_or(CryptoError::StreamSequenceExhausted)?;
        Ok(ciphertext)
    }
}

impl StreamOpener {
    pub fn new(
        receiver: &TransferIdentity,
        sender_public: &PublicKey,
        header: &SealedStreamHeader,
        response_context: &[u8],
    ) -> Result<Self, CryptoError> {
        if header.version != ENVELOPE_VERSION {
            return Err(CryptoError::UnsupportedStreamVersion(header.version));
        }
        let ephemeral_public_key = parse_public_key(&header.ephemeral_public_key)?;
        let nonce_prefix = STANDARD.decode(&header.nonce_prefix_b64)?;
        let nonce_prefix: [u8; 16] = nonce_prefix
            .try_into()
            .map_err(|bytes: Vec<u8>| CryptoError::InvalidStreamNoncePrefixLength(bytes.len()))?;
        let cipher = build_cipher(
            receiver
                .secret
                .diffie_hellman(&ephemeral_public_key)
                .as_bytes(),
            receiver.secret.diffie_hellman(sender_public).as_bytes(),
            sender_public,
            &receiver.public_key,
            &ephemeral_public_key,
        )?;
        Ok(Self {
            cipher,
            aad: stream_associated_data(
                sender_public,
                &receiver.public_key,
                &ephemeral_public_key,
                response_context,
            ),
            nonce_prefix,
            next_sequence: 0,
        })
    }

    pub fn open_chunk(
        &mut self,
        sequence: u64,
        ciphertext: &[u8],
        final_chunk: bool,
    ) -> Result<Vec<u8>, CryptoError> {
        if sequence != self.next_sequence {
            return Err(CryptoError::UnexpectedStreamSequence {
                expected: self.next_sequence,
                actual: sequence,
            });
        }
        let plaintext = self
            .cipher
            .decrypt(
                XNonce::from_slice(&stream_nonce(&self.nonce_prefix, sequence)),
                Payload {
                    msg: ciphertext,
                    aad: stream_chunk_aad(&self.aad, sequence, final_chunk).as_slice(),
                },
            )
            .map_err(|_| CryptoError::Decrypt)?;
        self.next_sequence = sequence
            .checked_add(1)
            .ok_or(CryptoError::StreamSequenceExhausted)?;
        Ok(plaintext)
    }
}

fn build_cipher(
    ephemeral_shared_secret: &[u8],
    static_shared_secret: &[u8],
    sender_public: &PublicKey,
    receiver_public: &PublicKey,
    ephemeral_public_key: &PublicKey,
) -> Result<XChaCha20Poly1305, CryptoError> {
    let mut input_key_material =
        Vec::with_capacity(ephemeral_shared_secret.len() + static_shared_secret.len());
    input_key_material.extend_from_slice(ephemeral_shared_secret);
    input_key_material.extend_from_slice(static_shared_secret);
    let hkdf = Hkdf::<Sha256>::new(Some(KEY_DERIVATION_SALT), input_key_material.as_slice());
    let mut key = [0u8; 32];
    hkdf.expand(
        associated_data(sender_public, receiver_public, ephemeral_public_key).as_slice(),
        &mut key,
    )
    .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(XChaCha20Poly1305::new((&key).into()))
}

fn associated_data(
    sender_public: &PublicKey,
    receiver_public: &PublicKey,
    ephemeral_public_key: &PublicKey,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        ENCRYPTION_CONTEXT.len()
            + sender_public.as_bytes().len()
            + receiver_public.as_bytes().len()
            + ephemeral_public_key.as_bytes().len(),
    );
    aad.extend_from_slice(ENCRYPTION_CONTEXT);
    aad.extend_from_slice(sender_public.as_bytes());
    aad.extend_from_slice(receiver_public.as_bytes());
    aad.extend_from_slice(ephemeral_public_key.as_bytes());
    aad
}

fn stream_associated_data(
    sender_public: &PublicKey,
    receiver_public: &PublicKey,
    ephemeral_public_key: &PublicKey,
    response_context: &[u8],
) -> Vec<u8> {
    let mut aad = associated_data(sender_public, receiver_public, ephemeral_public_key);
    aad.extend_from_slice(STREAM_ENCRYPTION_CONTEXT);
    append_context_field(&mut aad, response_context);
    aad
}

fn append_context_field(context: &mut Vec<u8>, field: &[u8]) {
    context.extend_from_slice(&(field.len() as u64).to_be_bytes());
    context.extend_from_slice(field);
}

fn stream_nonce(prefix: &[u8; 16], sequence: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(prefix);
    nonce[16..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn stream_chunk_aad(base: &[u8], sequence: u64, final_chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(base.len() + 9);
    aad.extend_from_slice(base);
    aad.extend_from_slice(&sequence.to_be_bytes());
    aad.push(u8::from(final_chunk));
    aad
}

fn generate_secret() -> StaticSecret {
    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    StaticSecret::from(secret_bytes)
}
