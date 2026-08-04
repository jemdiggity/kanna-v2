import { useRef, type RefObject } from "react";
import { useScrollToTop } from "@react-navigation/native";
import { Keyboard, type ScrollView } from "react-native";

export function useTabReselectionScrollToTop(): RefObject<ScrollView | null> {
  const scrollViewRef = useRef<ScrollView>(null);
  const reselectionTargetRef = useRef({
    scrollToTop() {
      Keyboard.dismiss();
      scrollViewRef.current?.scrollTo({
        animated: true,
        x: 0,
        y: 0
      });
    }
  });

  useScrollToTop(reselectionTargetRef);
  return scrollViewRef;
}
