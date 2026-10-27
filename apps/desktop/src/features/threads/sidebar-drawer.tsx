import { useEffect, useRef, useState, type RefObject } from "react";

/** Must match the `max-width` breakpoint in `styles/sidebar.css` that turns the sidebar into a drawer. */
const NARROW_SIDEBAR_QUERY = "(max-width: 760px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

interface NarrowSidebarDrawer {
  /** True while the expanded sidebar overlays the main surface as a drawer. */
  readonly open: boolean;
  /** Collapses the sidebar if, and only if, it is currently a drawer. */
  readonly dismiss: () => void;
  /** Wraps a navigation from the sidebar so it also closes the drawer. */
  readonly thenDismiss: <Args extends unknown[]>(
    navigate: (...args: Args) => void,
  ) => (...args: Args) => void;
  /** Receives focus back when Escape closes the drawer. */
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * At the narrow breakpoint the expanded sidebar overlays the main surface, so it behaves as a
 * dismissible drawer: Escape closes it and returns focus to the toggle, and navigating from it
 * closes it. Wider windows keep the docked sidebar unchanged.
 *
 * `location` identifies what main shows. Any change to it (a sidebar link, a shortcut, the thread
 * switcher or the command palette) closes the drawer; `thenDismiss` also covers a sidebar click
 * on the location already shown.
 */
export function useNarrowSidebarDrawer(
  expanded: boolean,
  collapse: () => void,
  location: string,
): NarrowSidebarDrawer {
  const open = useMediaQuery(NARROW_SIDEBAR_QUERY) && expanded;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat)
        return;
      // An open menu, rename field or dialog owns this Escape; the next one closes the drawer.
      const owner = "[role='menu'], [aria-haspopup][aria-expanded='true'], [aria-modal='true']";
      if (document.querySelector(`${owner}, .sidebar input`)) return;
      event.preventDefault();
      collapseRef.current();
      toggleRef.current?.focus();
    };
    // Capture runs before the popups' own window listeners close them, so the check still sees them.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  const openRef = useRef(open);
  openRef.current = open;
  const shownLocation = useRef(location);
  useEffect(() => {
    if (shownLocation.current === location) return;
    shownLocation.current = location;
    if (openRef.current) collapseRef.current();
  }, [location]);

  const dismiss = () => {
    if (open) collapseRef.current();
  };
  return {
    open,
    dismiss,
    thenDismiss:
      (navigate) =>
      (...args) => {
        navigate(...args);
        dismiss();
      },
    toggleRef,
  };
}

/** Render after `.main` so its no-drag region wins over the topbar's window-drag region. */
export function SidebarDrawerBackdrop({ drawer }: { readonly drawer: NarrowSidebarDrawer }) {
  return drawer.open ? (
    <div
      aria-hidden="true"
      className="sidebar-drawer-backdrop"
      data-testid="sidebar-drawer-backdrop"
      onClick={drawer.dismiss}
    />
  ) : null;
}
