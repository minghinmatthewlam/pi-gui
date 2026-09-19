import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useThreadSearch(timelinePaneRef: React.RefObject<HTMLDivElement | null>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const matchElements = useRef<HTMLElement[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMarks = useCallback(() => {
    const pane = timelinePaneRef.current;
    if (!pane) return;
    const marks = pane.querySelectorAll("mark.thread-find-match, mark.thread-find-active");
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    });
    matchElements.current = [];
    setMatchCount(0);
    setActiveIndex(-1);
  }, [timelinePaneRef]);

  const searchImmediate = useCallback(
    (q: string) => {
      clearMarks();
      if (!q.trim()) return;

      const pane = timelinePaneRef.current;
      if (!pane) return;

      const timeline = pane.querySelector(".timeline");
      if (!timeline) return;

      const lowerQuery = q.toLowerCase();
      const walker = document.createTreeWalker(timeline, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent && node.textContent.toLowerCase().includes(lowerQuery)) {
          textNodes.push(node);
        }
      }

      const elements: HTMLElement[] = [];
      for (const textNode of textNodes) {
        const text = textNode.textContent || "";
        const parent = textNode.parentNode;
        if (!parent) continue;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        const lowerText = text.toLowerCase();
        let idx = lowerText.indexOf(lowerQuery, lastIndex);

        while (idx !== -1) {
          if (idx > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
          }
          const mark = document.createElement("mark");
          mark.className = "thread-find-match";
          mark.textContent = text.slice(idx, idx + q.length);
          fragment.appendChild(mark);
          elements.push(mark);
          lastIndex = idx + q.length;
          idx = lowerText.indexOf(lowerQuery, lastIndex);
        }

        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        parent.replaceChild(fragment, textNode);
      }

      matchElements.current = elements;
      setMatchCount(elements.length);
      const first = elements[0];
      if (first) {
        setActiveIndex(0);
        first.className = "thread-find-active";
        first.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [clearMarks, timelinePaneRef],
  );

  const search = useCallback(
    (q: string) => {
      setQuery(q);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        clearMarks();
        return;
      }
      debounceRef.current = setTimeout(() => searchImmediate(q), 150);
    },
    [clearMarks, searchImmediate],
  );

  const goToMatch = useCallback(
    (direction: 1 | -1) => {
      const elements = matchElements.current;
      if (elements.length === 0) return;

      // Remove active from current
      const current = activeIndex >= 0 ? elements[activeIndex] : undefined;
      if (current) {
        current.className = "thread-find-match";
      }

      const next = (activeIndex + direction + elements.length) % elements.length;
      const nextEl = elements[next];
      setActiveIndex(next);
      if (nextEl) {
        nextEl.className = "thread-find-active";
        nextEl.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [activeIndex],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearMarks();
  }, [clearMarks]);

  // Clean up debounce timer on unmount
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return useMemo(
    () => ({ isOpen, query, matchCount, activeIndex, inputRef, open, close, search, goToMatch }),
    [isOpen, query, matchCount, activeIndex, open, close, search, goToMatch],
  );
}
