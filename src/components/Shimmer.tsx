import React, { useState, useEffect } from "react";
import { Text } from "ink";

// Soft pastel palette, similar to Claude Code buddy
const COLORS = [
  "#B8A9E8", "#9AC8E8", "#A8D8C8", "#D4C09E", "#C8A0B8",
];

interface Props {
  children: string;
}

/**
 * Soft shimmer text — gradient slides right-to-left across characters.
 */
export function Shimmer({ children }: Props) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setOffset((o) => o + 1), 200);
    return () => clearInterval(timer);
  }, []);

  const chars = [...children];

  return (
    <Text>
      {chars.map((char, i) => {
        const colorIndex = (chars.length - 1 - i + offset) % COLORS.length;
        return (
          <Text key={i} color={COLORS[colorIndex]}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
}
