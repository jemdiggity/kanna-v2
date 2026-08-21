import React, { useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { MachinePairingError } from "../lib/pairing/machinePairing";
import { normalizePairingCode } from "../lib/pairing/pairingPayload";

const PairingCamera = CameraView as unknown as React.ComponentType<{
  barcodeScannerSettings: { barcodeTypes: ["qr"] };
  onBarcodeScanned?: (result: { data: string }) => void;
  style: object;
  testID: string;
}>;

interface MachinePairingSheetProps {
  visible: boolean;
  onClose(): void;
  onPairCode(code: string): Promise<void>;
  onPairPayload(payload: string): Promise<void>;
}

export function MachinePairingSheet({
  visible,
  onClose,
  onPairCode,
  onPairPayload
}: MachinePairingSheetProps) {
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"scan" | "code">("scan");
  const [submitting, setSubmitting] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [failedScan, setFailedScan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanLockRef = useRef(false);
  const failedScanPayloadRef = useRef<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const normalizedCode = normalizePairingCode(code);

  const resetAndClose = () => {
    scanLockRef.current = false;
    failedScanPayloadRef.current = null;
    setCode("");
    setMode("scan");
    setScanLocked(false);
    setFailedScan(false);
    setSubmitting(false);
    setError(null);
    onClose();
  };

  const submit = async (action: () => Promise<void>, scanPayload?: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await action();
      resetAndClose();
    } catch (failure) {
      setError(pairingFailureMessage(failure));
      if (scanPayload !== undefined) {
        failedScanPayloadRef.current = scanPayload;
        setFailedScan(true);
      }
      scanLockRef.current = false;
      setScanLocked(false);
      setSubmitting(false);
    }
  };

  const submitPayload = (payload: string) => {
    if (scanLockRef.current || failedScanPayloadRef.current === payload) return;
    scanLockRef.current = true;
    setScanLocked(true);
    void submit(() => onPairPayload(payload), payload);
  };

  const selectMode = (nextMode: "scan" | "code") => {
    failedScanPayloadRef.current = null;
    setFailedScan(false);
    setError(null);
    setMode(nextMode);
  };

  const retryFailedScan = () => {
    failedScanPayloadRef.current = null;
    setFailedScan(false);
    setError(null);
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={resetAndClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <Pressable
          accessibilityElementsHidden
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={styles.scrim}
          onPress={resetAndClose}
        />
        <View style={styles.sheet} testID={MOBILE_E2E_IDS.machinePairingSheet}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Add a machine</Text>
              <Text style={styles.subtitle}>Scan the QR code shown in Kanna on your desktop.</Text>
            </View>
            <Pressable
              accessibilityLabel="Close add machine"
              accessibilityRole="button"
              testID={MOBILE_E2E_IDS.machinePairingCloseButton}
              onPress={resetAndClose}
            >
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>

          {submitting ? (
            <View
              style={styles.progressCard}
              testID={MOBILE_E2E_IDS.machinePairingProgress}
            >
              <ActivityIndicator color="#9FC1F5" />
              <View style={styles.progressCopy}>
                <Text style={styles.progressTitle}>Adding machine…</Text>
                <Text style={styles.progressDetail}>
                  Connecting and loading its tasks. This can take a few seconds.
                </Text>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.modeRow}>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === "scan" }}
                  style={styles.modeButton}
                  testID={MOBILE_E2E_IDS.machinePairingScanModeButton}
                  onPress={() => selectMode("scan")}
                >
                  <Text style={mode === "scan" ? styles.modeActive : styles.modeLabel}>Scan QR</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === "code" }}
                  style={styles.modeButton}
                  onPress={() => selectMode("code")}
                >
                  <Text style={mode === "code" ? styles.modeActive : styles.modeLabel}>Enter code</Text>
                </Pressable>
              </View>

              {mode === "scan" ? (
                permission?.granted ? (
                  <PairingCamera
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={scanLocked ? undefined : ({ data }) => submitPayload(data)}
                    style={styles.camera}
                    testID={MOBILE_E2E_IDS.machinePairingCamera}
                  />
                ) : permission?.canAskAgain === false ? (
                  <View style={styles.permissionCard}>
                    <Text style={styles.permissionText}>Camera access is off. You can still enter the code below.</Text>
                    <Pressable
                      accessibilityRole="button"
                      style={styles.secondaryButton}
                      testID={MOBILE_E2E_IDS.machinePairingOpenSettingsButton}
                      onPress={() => void Linking.openSettings()}
                    >
                      <Text style={styles.secondaryLabel}>Open Settings</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    style={styles.secondaryButton}
                    onPress={() => void requestPermission()}
                  >
                    <Text style={styles.secondaryLabel}>Allow Camera</Text>
                  </Pressable>
                )
              ) : null}
            </>
          )}

          <View style={styles.codeArea}>
            <Text style={styles.label}>Pairing code</Text>
            <View style={styles.codeRow}>
              <TextInput
                accessibilityLabel="Pairing code"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!submitting}
                maxLength={8}
                placeholder="ABC123"
                placeholderTextColor="#6A7E9D"
                style={styles.input}
                testID={MOBILE_E2E_IDS.machinePairingCodeInput}
                value={code}
                onChangeText={setCode}
              />
              <Pressable
                accessibilityLabel="Add machine"
                accessibilityRole="button"
                accessibilityState={{
                  busy: submitting,
                  disabled: normalizedCode.length !== 6 || submitting
                }}
                disabled={normalizedCode.length !== 6 || submitting}
                style={[
                  styles.primaryButton,
                  normalizedCode.length !== 6 || submitting
                    ? styles.primaryButtonDisabled
                    : null
                ]}
                testID={MOBILE_E2E_IDS.machinePairingSubmitButton}
                onPress={() => submit(() => onPairCode(normalizedCode))}
              >
                {submitting ? (
                  <ActivityIndicator color="#08111E" />
                ) : (
                  <Text style={styles.primaryLabel}>Add</Text>
                )}
              </Pressable>
            </View>
          </View>

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.error} testID={MOBILE_E2E_IDS.machinePairingError}>
                {error}
              </Text>
              {failedScan ? (
                <Pressable
                  accessibilityRole="button"
                  style={styles.secondaryButton}
                  onPress={retryFailedScan}
                >
                  <Text style={styles.secondaryLabel}>Retry scan</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function pairingFailureMessage(failure: unknown): string {
  if (failure instanceof MachinePairingError) {
    const messages: Partial<Record<MachinePairingError["reason"], string>> = {
      expired: "That pairing session expired. Start a new one on the desktop.",
      "not-found": "No matching machine was found. Check that both devices are on the same network.",
      "rate-limited": "Too many attempts. Start a new pairing session on the desktop.",
      unreachable: "The machine could not be reached. Check that both apps are open and on the same network."
    };
    return messages[failure.reason] ?? failure.message;
  }
  return failure instanceof Error ? failure.message : "Could not add this machine.";
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  scrim: { backgroundColor: "rgba(3, 8, 16, 0.72)", ...StyleSheet.absoluteFill },
  sheet: {
    backgroundColor: "#0D1728",
    borderColor: "#243754",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    gap: 18,
    padding: 20,
    paddingBottom: 34
  },
  header: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" },
  title: { color: "#F5F7FB", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#9FB0C8", fontSize: 13, marginTop: 4, maxWidth: 300 },
  close: { color: "#B4C2D8", fontSize: 30, lineHeight: 30 },
  modeRow: { flexDirection: "row", gap: 10 },
  modeButton: { backgroundColor: "#14233A", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  modeLabel: { color: "#8FA2BF", fontSize: 13, fontWeight: "700" },
  modeActive: { color: "#F5F7FB", fontSize: 13, fontWeight: "800" },
  camera: { aspectRatio: 1.45, borderRadius: 18, overflow: "hidden" },
  progressCard: {
    alignItems: "center",
    backgroundColor: "#111D30",
    borderColor: "#243754",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  progressCopy: { flex: 1, gap: 3 },
  progressTitle: { color: "#F5F7FB", fontSize: 15, fontWeight: "800" },
  progressDetail: { color: "#9FB0C8", fontSize: 13, lineHeight: 19 },
  permissionCard: { backgroundColor: "#111D30", borderRadius: 16, gap: 12, padding: 16 },
  permissionText: { color: "#B4C2D8", fontSize: 14, lineHeight: 20 },
  codeArea: { gap: 8 },
  label: { color: "#91A5C3", fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  codeRow: { flexDirection: "row", gap: 10 },
  input: {
    backgroundColor: "#111D30",
    borderColor: "#2B405F",
    borderRadius: 14,
    borderWidth: 1,
    color: "#F5F7FB",
    flex: 1,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 3,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  primaryButton: { alignItems: "center", backgroundColor: "#E8F1FF", borderRadius: 14, justifyContent: "center", minWidth: 72 },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryLabel: { color: "#08111E", fontSize: 14, fontWeight: "800" },
  secondaryButton: { alignItems: "center", borderColor: "#3A5274", borderRadius: 12, borderWidth: 1, padding: 12 },
  secondaryLabel: { color: "#DCE8FA", fontSize: 14, fontWeight: "700" },
  errorCard: { gap: 10 },
  error: { color: "#FF9B9B", fontSize: 13, lineHeight: 19 }
});
