"use client";

import { useEffect, useState } from "react";
import { RELEASES_URL } from "../site";

type Platform = "macOS" | "Linux" | "Windows";

function detectPlatform(): Platform | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (/iphone|ipad|android/.test(hint)) return null;
  if (hint.includes("mac")) return "macOS";
  if (hint.includes("win")) return "Windows";
  if (hint.includes("linux")) return "Linux";
  return null;
}

// Server-rendered as a plain "Download" link; names the visitor's OS after hydration.
export function DownloadButton({ className }: { readonly className?: string }) {
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => setPlatform(detectPlatform()), []);
  return (
    <a className={className} href={RELEASES_URL}>
      {platform ? `Download for ${platform}` : "Download"}
    </a>
  );
}
