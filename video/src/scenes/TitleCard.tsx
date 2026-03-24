import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../lib/theme";

export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [0, 20], [30, 0], {
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [15, 35], [0, 1], {
    extrapolateRight: "clamp",
  });
  const taglineY = interpolate(frame, [15, 35], [20, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${theme.textStrong} 0%, #2d1b69 100%)`,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.font,
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          fontSize: 72,
          fontWeight: 700,
          color: "#ffffff",
          letterSpacing: -1,
        }}
      >
        pi desktop
      </div>
      <div
        style={{
          opacity: taglineOpacity,
          transform: `translateY(${taglineY}px)`,
          fontSize: 28,
          fontWeight: 400,
          color: theme.mutedSoft,
          marginTop: 16,
          letterSpacing: 0.5,
        }}
      >
        a codex-style desktop app for ai-assisted coding
      </div>
    </AbsoluteFill>
  );
};
