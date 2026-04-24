import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

interface AppFrameProps {
  children: React.ReactNode;
}

const WORDMARK_COLORS = ["#ff6b6b", "#ffa500", "#ffd700", "#4ecdc4", "#45b7d1", "#9966cc", "#ff6b9d"] as const;
const WORDMARK_TEXT = "agent-cv";
const SHIMMER_TICK_MS = 90;
const SHIMMER_RADIUS = 2.2;
const SHIMMER_STRENGTH = 0.82;

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b)
    .toString(16)
    .padStart(2, "0")}`;
}

function mixWithWhite(hex: string, amount: number) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function BrandWordmark() {
  const [highlightX, setHighlightX] = useState(-SHIMMER_RADIUS);

  useEffect(() => {
    if (process.env.AGENT_CV_SHIMMER === "off") return;
    const timer = setInterval(() => {
      setHighlightX((current: number) => {
        const next = current + 0.35;
        if (next > WORDMARK_TEXT.length - 1 + SHIMMER_RADIUS) return -SHIMMER_RADIUS;
        return next;
      });
    }, SHIMMER_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text bold>
      {WORDMARK_TEXT.split("").map((ch, i) => {
        const baseColor = WORDMARK_COLORS[i % WORDMARK_COLORS.length] ?? WORDMARK_COLORS[0];
        const glowAmount = Math.max(0, (1 - Math.abs(i - highlightX) / SHIMMER_RADIUS) * SHIMMER_STRENGTH);
        return (
          <Text key={`${ch}-${i}`} color={mixWithWhite(baseColor, glowAmount)}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

export function AppFrame({ children }: AppFrameProps) {
  return (
    <Box flexDirection="column">
      <BrandWordmark />
      <Text> </Text>
      {children}
    </Box>
  );
}
