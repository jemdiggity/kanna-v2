import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MachinePairingSheet } from "../components/MachinePairingSheet";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { MobileMachine } from "../state/machineInventory";

interface MachinesScreenProps {
  machines: MobileMachine[];
  sourceWarnings: { account: string | null; local: string | null };
  pairingVisible: boolean;
  onBack(): void;
  onOpenPairing(): void;
  onClosePairing(): void;
  onPairCode(code: string): Promise<void>;
  onPairPayload(payload: string): Promise<void>;
  onRemoveManual(desktopId: string): Promise<void>;
}

export function MachinesScreen(props: MachinesScreenProps) {
  const available = props.machines.filter(isAvailable);
  const offline = props.machines.filter((machine) => !isAvailable(machine));

  const confirmRemoval = (machine: MobileMachine) => {
    const message = machine.origins.account
      ? "This removes the manual pairing. The machine will remain available through your account."
      : "This removes the manual pairing from this phone. You can add the machine again later.";
    Alert.alert("Remove paired machine?", message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          void props.onRemoveManual(machine.desktopId).catch((error) => {
            const detail = error instanceof Error
              ? error.message
              : "The pairing could not be removed. Try again.";
            Alert.alert("Couldn’t remove machine", detail);
          });
        }
      }
    ]);
  };

  return (
    <View style={styles.screen} testID={MOBILE_E2E_IDS.machinesScreen}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back"
          style={styles.headerAction}
          testID={MOBILE_E2E_IDS.machinesBackButton}
          onPress={props.onBack}
        >
          <Text style={styles.headerActionLabel}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Machines</Text>
        <Pressable
          accessibilityLabel="Add machine"
          style={styles.headerAction}
          testID={MOBILE_E2E_IDS.machinesAddButton}
          onPress={props.onOpenPairing}
        >
          <Text style={styles.headerActionLabel}>Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {props.sourceWarnings.account ? (
          <WarningBanner label="Account" message={props.sourceWarnings.account} />
        ) : null}
        {props.sourceWarnings.local ? (
          <WarningBanner label="Local network" message={props.sourceWarnings.local} />
        ) : null}

        <MachineSection title="Available" machines={available} onRemove={confirmRemoval} />
        <MachineSection title="Offline" machines={offline} onRemove={confirmRemoval} />

        {props.machines.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No machines added</Text>
            <Text style={styles.emptyDetail}>Sign in to discover account machines, or add one with a pairing code.</Text>
          </View>
        ) : null}
      </ScrollView>

      <MachinePairingSheet
        visible={props.pairingVisible}
        onClose={props.onClosePairing}
        onPairCode={props.onPairCode}
        onPairPayload={props.onPairPayload}
      />
    </View>
  );
}

function MachineSection({
  title,
  machines,
  onRemove
}: {
  title: string;
  machines: MobileMachine[];
  onRemove(machine: MobileMachine): void;
}) {
  if (machines.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {machines.map((machine) => (
        <View
          key={machine.desktopId}
          style={styles.card}
          testID={MOBILE_E2E_IDS.machineRow(machine.desktopId)}
        >
          <View style={styles.cardHeader}>
            <View style={styles.cardIdentity}>
              <Text
                style={styles.machineName}
                testID={MOBILE_E2E_IDS.machineName(machine.desktopId)}
              >
                {machine.displayName}
              </Text>
              <View style={styles.originRow}>
                {machine.origins.account ? (
                  <OriginPill
                    label="Account"
                    testID={MOBILE_E2E_IDS.machineOrigin(machine.desktopId, "account")}
                  />
                ) : null}
                {machine.origins.manual ? (
                  <OriginPill
                    label="Paired"
                    testID={MOBILE_E2E_IDS.machineOrigin(machine.desktopId, "manual")}
                  />
                ) : null}
              </View>
            </View>
            {machine.origins.manual ? (
              <Pressable
                accessibilityLabel={`Remove pairing for ${machine.displayName}`}
                testID={MOBILE_E2E_IDS.machineRemoveButton(machine.desktopId)}
                onPress={() => onRemove(machine)}
              >
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.availability}>{availabilityLabel(machine)}</Text>
        </View>
      ))}
    </View>
  );
}

function OriginPill({ label, testID }: { label: string; testID: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillLabel} testID={testID}>{label}</Text>
    </View>
  );
}

function WarningBanner({ label, message }: { label: string; message: string }) {
  return (
    <View style={styles.warning}>
      <Text style={styles.warningLabel}>{label}</Text>
      <Text style={styles.warningMessage}>{message}</Text>
    </View>
  );
}

function isAvailable(machine: MobileMachine): boolean {
  return machine.availability.lan || machine.availability.cloud;
}

function availabilityLabel(machine: MobileMachine): string {
  if (machine.availability.lan && machine.availability.cloud) return "Available nearby and through your account";
  if (machine.availability.lan) return "Available on this network";
  if (machine.availability.cloud) return "Available through your account";
  return machine.availability.lastSeenAt
    ? `Last seen ${new Date(machine.availability.lastSeenAt).toLocaleString()}`
    : "Offline";
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingBottom: 18 },
  title: { color: "#F5F7FB", fontSize: 22, fontWeight: "800" },
  headerAction: { minWidth: 64, paddingVertical: 8 },
  headerActionLabel: { color: "#9FC1F5", fontSize: 14, fontWeight: "700" },
  content: { gap: 18, paddingBottom: 120 },
  section: { gap: 10 },
  sectionTitle: { color: "#8398B7", fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  card: { backgroundColor: "#111B2C", borderColor: "#20304C", borderRadius: 18, borderWidth: 1, gap: 10, padding: 16 },
  cardHeader: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" },
  cardIdentity: { flex: 1, gap: 8 },
  machineName: { color: "#F5F7FB", fontSize: 16, fontWeight: "700" },
  originRow: { flexDirection: "row", gap: 6 },
  pill: { backgroundColor: "#172843", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  pillLabel: { color: "#9EB6DC", fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  availability: { color: "#AABAD1", fontSize: 13 },
  remove: { color: "#FFAAA6", fontSize: 13, fontWeight: "700" },
  warning: { backgroundColor: "#2A2315", borderColor: "#5C4A23", borderRadius: 14, borderWidth: 1, gap: 3, padding: 12 },
  warningLabel: { color: "#E7C978", fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  warningMessage: { color: "#D7CDAF", fontSize: 13 },
  empty: { alignItems: "center", gap: 7, paddingHorizontal: 32, paddingVertical: 56 },
  emptyTitle: { color: "#F5F7FB", fontSize: 18, fontWeight: "800" },
  emptyDetail: { color: "#91A3BD", fontSize: 14, lineHeight: 20, textAlign: "center" }
});
