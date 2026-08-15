import React from "react";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import {
  MAIN_TAB_ROUTES,
  UTILITY_ACTIONS
} from "../navigation/navigationConfig";

interface FloatingToolbarProps extends BottomTabBarProps {
  activityCount?: number;
  onSelectUtilityAction(action: "search" | "create"): void;
}

export function FloatingToolbar({
  state,
  navigation,
  activityCount = 0,
  onSelectUtilityAction
}: FloatingToolbarProps) {
  const searchAction = UTILITY_ACTIONS.find((action) => action.name === "search");
  const createAction = UTILITY_ACTIONS.find((action) => action.name === "create");

  return (
    <View style={styles.wrap}>
      {searchAction ? (
        <Pressable
          accessibilityLabel={searchAction.label}
          accessibilityRole="button"
          style={styles.utilityButton}
          testID={MOBILE_E2E_IDS.toolbarSearch}
          onPress={() => onSelectUtilityAction(searchAction.name)}
        >
          <Ionicons
            color="#D5DEEC"
            name={searchAction.icon as keyof typeof Ionicons.glyphMap}
            size={30}
          />
        </Pressable>
      ) : null}

      <View style={styles.bar} testID={MOBILE_E2E_IDS.toolbarNavigation}>
        {state.routes.map((route, index) => {
          const tab = MAIN_TAB_ROUTES.find(
            (candidate) => candidate.routeName === route.name
          );
          if (!tab) return null;
          const active = state.index === index;
          const tabActivityCount =
            route.name === "Activity" ? activityCount : 0;
          return (
            <Pressable
              accessibilityLabel={
                tabActivityCount > 0
                  ? `${tab.label}, ${tabActivityCount} unread`
                  : tab.label
              }
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              key={tab.name}
              style={[styles.item, active ? styles.itemActive : null]}
              testID={MOBILE_E2E_IDS.toolbarTab(tab.name)}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true
                });
                if (!active && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
            >
              <Ionicons
                color={active ? "#0B1220" : "#D5DEEC"}
                name={tab.icon as keyof typeof Ionicons.glyphMap}
                size={23}
              />
              {tabActivityCount > 0 ? (
                <View
                  style={styles.badge}
                  testID={MOBILE_E2E_IDS.activityBadge}
                >
                  <Text style={styles.badgeLabel}>
                    {tabActivityCount > 99 ? "99+" : tabActivityCount}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.label, active ? styles.labelActive : null]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {createAction ? (
        <Pressable
          accessibilityLabel={createAction.label}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.utilityButtonPrimary,
            pressed ? styles.utilityButtonPrimaryPressed : null
          ]}
          testID={MOBILE_E2E_IDS.toolbarUtilityAction(createAction.name)}
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
    backgroundColor: "#080F1B",
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
  badge: {
    alignItems: "center",
    backgroundColor: "#C43D55",
    borderColor: "#080F1B",
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 18,
    minWidth: 18,
    paddingHorizontal: 4,
    position: "absolute",
    right: 12,
    top: 3
  },
  badgeLabel: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800"
  },
  itemActive: {
    backgroundColor: "#E8F1FF"
  },
  utilityButton: {
    alignItems: "center",
    backgroundColor: "#080F1B",
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
  utilityButtonPrimaryPressed: {
    backgroundColor: "#C8D9F0",
    opacity: 0.84,
    transform: [{ scale: 0.94 }]
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
