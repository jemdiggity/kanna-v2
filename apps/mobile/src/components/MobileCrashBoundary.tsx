import React from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { captureMobileCrashDiagnostic } from "../lib/diagnostics/mobileCrashDiagnostics";

interface MobileCrashBoundaryProps {
  children: React.ReactNode;
}

interface MobileCrashBoundaryState {
  diagnosticId: string | null;
  error: Error | null;
  retryKey: number;
}

export class MobileCrashBoundary extends React.Component<
  MobileCrashBoundaryProps,
  MobileCrashBoundaryState
> {
  state: MobileCrashBoundaryState = {
    diagnosticId: null,
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
    this.setState({ diagnosticId: diagnostic.id });
  }

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
            {this.state.diagnosticId
              ? `Diagnostic ${this.state.diagnosticId} was captured. After retrying, open More → About this build to copy it.`
              : "Saving crash diagnostics…"}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              this.setState((state) => ({
                diagnosticId: null,
                error: null,
                retryKey: state.retryKey + 1
              }));
            }}
            style={({ pressed }) => [
              styles.retry,
              pressed ? styles.retryPressed : null
            ]}
          >
            <Text style={styles.retryText}>Retry</Text>
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
  retry: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#275C96",
    borderRadius: 12,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18
  },
  retryPressed: { opacity: 0.76 },
  retryText: { color: "#F5F7FB", fontSize: 14, fontWeight: "700" }
});
