import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TabName, TabRoute } from "../navigation/RootNavigator";

interface FloatingToolbarProps {
  activeTab: TabName;
  tabs: TabRoute[];
  utilityActions: {
    name: "search" | "create";
    label: string;
    icon: string;
  }[];
  onSelectTab(tab: TabName): void;
  onSelectUtilityAction(action: "search" | "create"): void;
}

export function FloatingToolbar({
  activeTab,
  tabs,
  utilityActions,
  onSelectTab,
  onSelectUtilityAction
}: FloatingToolbarProps) {
  const searchAction = utilityActions.find((action) => action.name === "search");
  const createAction = utilityActions.find((action) => action.name === "create");

  return (
    <View style={styles.wrap}>
      {searchAction ? (
        <Pressable
          style={styles.utilityButton}
          accessibilityLabel={searchAction.label}
          onPress={() => onSelectUtilityAction(searchAction.name)}
        >
          <Ionicons
            color="#D5DEEC"
            name={searchAction.icon as keyof typeof Ionicons.glyphMap}
            size={30}
          />
        </Pressable>
      ) : null}

      <View style={styles.bar}>
        {tabs.map((tab) => {
          const active = tab.name === activeTab;
          return (
            <Pressable
              key={tab.name}
              style={[styles.item, active ? styles.itemActive : null]}
              onPress={() => onSelectTab(tab.name)}
            >
              <Ionicons
                color={active ? "#0B1220" : "#D5DEEC"}
                name={tab.icon as keyof typeof Ionicons.glyphMap}
                size={23}
              />
              <Text style={[styles.label, active ? styles.labelActive : null]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {createAction ? (
        <Pressable
          style={styles.utilityButtonPrimary}
          accessibilityLabel={createAction.label}
          onPress={() => onSelectUtilityAction(createAction.name)}
        >
          <Ionicons
            color="#0B1220"
            name={createAction.icon as keyof typeof Ionicons.glyphMap}
            size={36}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    bottom: 16,
    flexDirection: "row",
    gap: 8,
    left: 16,
    position: "absolute",
    right: 16
  },
  bar: {
    backgroundColor: "rgba(8, 15, 27, 0.97)",
    borderColor: "#1E304C",
    borderRadius: 28,
    borderWidth: 1,
    flexDirection: "row",
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingVertical: 7,
    shadowColor: "#02060E",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.36,
    shadowRadius: 24
  },
  item: {
    alignItems: "center",
    borderRadius: 20,
    flex: 1,
    gap: 3,
    minHeight: 54,
    justifyContent: "center",
    paddingHorizontal: 6,
    paddingVertical: 7
  },
  itemActive: {
    backgroundColor: "#E8F1FF"
  },
  utilityButton: {
    alignItems: "center",
    backgroundColor: "rgba(8, 15, 27, 0.97)",
    borderColor: "#1E304C",
    borderRadius: 24,
    borderWidth: 1,
    height: 64,
    justifyContent: "center",
    width: 64,
    shadowColor: "#02060E",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.28,
    shadowRadius: 20
  },
  utilityButtonPrimary: {
    alignItems: "center",
    backgroundColor: "#E8F1FF",
    borderRadius: 32,
    height: 64,
    justifyContent: "center",
    width: 64,
    shadowColor: "#02060E",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.28,
    shadowRadius: 20
  },
  label: {
    color: "#8EA3C4",
    fontSize: 11,
    fontWeight: "700"
  },
  labelActive: {
    color: "#0B1220"
  },
});
