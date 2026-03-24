import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../lib/theme";

export const ClosingCard: React.FC = () => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${theme.textStrong} 0%, #2d1b69 100%)`,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.font,
        opacity,
      }}
    >
      <div
        style={{
          fontSize: 36,
          fontWeight: 600,
          color: "#ffffff",
          marginBottom: 20,
        }}
      >
        github.com/minghinmatthewlam/pi-app
      </div>
      <div
        style={{
          fontSize: 22,
          color: theme.mutedSoft,
          fontWeight: 400,
        }}
      >
        built with pi-mono + electron
      </div>
    </AbsoluteFill>
  );
};
