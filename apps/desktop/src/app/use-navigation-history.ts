import { useLayoutEffect, useRef } from "react";
import { NavigationHistory, type AppLocation } from "./navigation-history";

export function useNavigationHistory(
  location: AppLocation | null,
  restore: (location: AppLocation) => Promise<void>,
  isAvailable: (location: AppLocation) => boolean,
) {
  const history = useRef(new NavigationHistory());
  const restoring = useRef(false);
  const pending = useRef(Promise.resolve());
  useLayoutEffect(() => {
    if (location && !restoring.current) history.current.record(location);
  });

  return (direction: -1 | 1) => {
    pending.current = pending.current.then(async () => {
      const destination = history.current.move(direction, isAvailable);
      if (!destination) return;
      restoring.current = true;
      try {
        await restore(destination);
      } catch (error: unknown) {
        console.error("[renderer] navigation failed", error);
      } finally {
        restoring.current = false;
      }
    });
  };
}
