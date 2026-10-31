import { useLayoutEffect, useRef } from "react";
import { NavigationHistory, sameLocation, type AppLocation } from "./navigation-history";

export function useNavigationHistory(
  location: AppLocation | null,
  restore: (location: AppLocation) => Promise<void>,
  isAvailable: (location: AppLocation) => boolean,
) {
  const history = useRef(new NavigationHistory());
  const replay = useRef<{
    from: AppLocation | null;
    to: AppLocation;
    arrived: boolean;
  } | null>(null);
  const latest = useRef({ location, restore, isAvailable });
  const pending = useRef(Promise.resolve());
  useLayoutEffect(() => {
    latest.current = { location, restore, isAvailable };
    if (!location) return;
    const current = replay.current;
    if (current && sameLocation(location, current.to)) {
      current.arrived = true;
      return;
    }
    if (current && !current.arrived && sameLocation(location, current.from)) return;
    replay.current = null;
    history.current.record(location);
  });

  return (direction: -1 | 1) => {
    pending.current = pending.current.then(async () => {
      const destination = history.current.move(direction, latest.current.isAvailable);
      if (!destination) return;
      replay.current = { from: latest.current.location, to: destination, arrived: false };
      try {
        await latest.current.restore(destination);
      } catch (error: unknown) {
        console.error("[renderer] navigation failed", error);
      } finally {
        replay.current = null;
      }
    });
  };
}
