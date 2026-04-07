import React from "react";
import { Box, Text } from "ink";

interface Props {
  url: string;
  totalCount?: number;
  analyzedCount?: number;
  publicCount?: number;
}

export function PublishResult({ url, totalCount, analyzedCount, publicCount }: Props) {
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text bold color="green">Your profile is live at <Text color="cyan">{url}</Text></Text>
      <Text> </Text>
      {totalCount != null && (
        <Text color="gray">
          {totalCount} projects{analyzedCount != null ? ` (${analyzedCount} with AI analysis)` : ""}
          {publicCount != null ? ` · ${publicCount} public, ${totalCount - publicCount} private` : ""}
        </Text>
      )}
    </Box>
  );
}
