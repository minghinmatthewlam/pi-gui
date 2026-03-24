import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { theme } from "../lib/theme";

interface FeatureSceneProps {
  clip: string;
  label: string;
}

export const FeatureScene: React.FC<FeatureSceneProps> = ({ clip, label }) => {
  const frame = useCurrentFrame();

  const labelOpacity = interpolate(frame, [10, 25], [0, 1], {
    extrapolateRight: "clamp",
  });
  const labelY = interpolate(frame, [10, 25], [20, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.font,
      }}
    >
      {/* Video clip in a rounded window frame */}
      <div
        style={{
          width: 1680,
          height: 900,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
          position: "relative",
        }}
      >
        <OffthreadVideo
          src={staticFile(`captures/${clip}`)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </div>

      {/* Label overlay at bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 40,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
        }}
      >
        <div
          style={{
            background: "rgba(31, 38, 56, 0.85)",
            color: "#ffffff",
            fontSize: 28,
            fontWeight: 600,
            padding: "14px 36px",
            borderRadius: 12,
            letterSpacing: 0.3,
          }}
        >
          {label}
        </div>
      </div>
    </AbsoluteFill>
  );
};
