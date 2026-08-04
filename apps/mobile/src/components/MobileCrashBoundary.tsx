import * as Clipboard from "expo-clipboard";
import React from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import {
  captureMobileCrashDiagnostic,
  formatMobileCrashDiagnostics,
  type MobileCrashDiagnostic
} from "../lib/diagnostics/mobileCrashDiagnostics";

interface MobileCrashBoundaryProps {
  children: React.ReactNode;
  copyDiagnostic?(value: string): Promise<unknown>;
}

interface MobileCrashBoundaryState {
  copyStatus: "idle" | "copied" | "failed";
  diagnostic: MobileCrashDiagnostic | null;
  error: Error | null;
  retryKey: number;
}

export class MobileCrashBoundary extends React.Component<
  MobileCrashBoundaryProps,
  MobileCrashBoundaryState
> {
  state: MobileCrashBoundaryState = {
    copyStatus: "idle",
    diagnostic: null,
    error: null,
    retryKey: 0
  };

  static getDerivedStateFromError(
    error: Error
  ): Partial<MobileCrashBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const diagnostic = captureMobileCrashDiagnostic({
      kind: "react-render-error",
      message: `${error.name}: ${error.message}`,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined
    });
    this.setState({ copyStatus: "idle", diagnostic });
  }

  private copyDiagnostic = async (): Promise<void> => {
    const { diagnostic } = this.state;
    if (!diagnostic) return;

    try {
      await (this.props.copyDiagnostic ?? Clipboard.setStringAsync)(
        formatMobileCrashDiagnostics([diagnostic])
      );
      this.setState({ copyStatus: "copied" });
    } catch (error: unknown) {
      console.warn("Mobile crash diagnostic clipboard export failed:", error);
      this.setState({ copyStatus: "failed" });
    }
  };

  render() {
    if (!this.state.error) {
      return (
        <React.Fragment key={this.state.retryKey}>
          {this.props.children}
        </React.Fragment>
      );
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.card}>
          <Text style={styles.title}>Kanna hit an unexpected error</Text>
          <Text style={styles.message} selectable>
            {this.state.error.message}
          </Text>
          <Text style={styles.detail} selectable>
            {this.state.diagnostic
              ? `Diagnostic ${this.state.diagnostic.id} was captured and can be copied below.`
              : "Saving crash diagnostics…"}
          </Text>
          {this.state.diagnostic ? (
            <Pressable
              accessibilityLabel="Copy crash diagnostics"
              accessibilityRole="button"
              onPress={() => void this.copyDiagnostic()}
              style={({ pressed }) => [
                styles.action,
                styles.copy,
                pressed ? styles.actionPressed : null
              ]}
            >
              <Text style={styles.actionText}>
                {this.state.copyStatus === "copied"
                  ? "Diagnostics copied"
                  : this.state.copyStatus === "failed"
                    ? "Copy failed — try again"
                    : "Copy diagnostics"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Retry"
            accessibilityRole="button"
            onPress={() => {
              this.setState((state) => ({
                copyStatus: "idle",
                error: null,
                retryKey: state.retryKey + 1
              }));
            }}
            style={({ pressed }) => [
              styles.action,
              styles.retry,
              pressed ? styles.actionPressed : null
            ]}
          >
            <Text style={styles.actionText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  safeArea: {
    alignItems: "center",
    backgroundColor: "#08111E",
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  card: {
    backgroundColor: "#10192A",
    borderColor: "#8D3E46",
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    maxWidth: 520,
    padding: 20,
    width: "100%"
  },
  title: { color: "#F5F7FB", fontSize: 20, fontWeight: "700" },
  message: { color: "#FFC7CE", fontSize: 14, lineHeight: 20 },
  detail: { color: "#A8B7CC", fontSize: 13, lineHeight: 19 },
  action: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 12,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18
  },
  actionPressed: { opacity: 0.76 },
  actionText: { color: "#F5F7FB", fontSize: 14, fontWeight: "700" },
  copy: { backgroundColor: "#31506F" },
  retry: { backgroundColor: "#275C96" }
});
