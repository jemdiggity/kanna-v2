import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle
} from "react-native";

const ELLIPSIS_INTERVAL_MS = 400;
const NBSP = "\u00a0";

interface LoadingTextProps {
  label: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export function LoadingText({ label, style, testID }: LoadingTextProps) {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((count) => count === 3 ? 1 : count + 1);
    }, ELLIPSIS_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const suffix = ".".repeat(dotCount).padEnd(3, NBSP);

  return (
    <Text
      accessibilityLabel={`${label}, loading`}
      accessibilityRole="progressbar"
      style={style}
      testID={testID}
    >
      {label}
      <Text accessible={false} style={styles.ellipsis}>{suffix}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  ellipsis: {
    fontFamily: "Menlo"
  }
});
