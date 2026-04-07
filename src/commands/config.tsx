import React, { useEffect, useState } from "react";
import { Text, Box, useInput, useApp } from "ink";
import { z } from "zod/v4";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import type { Inventory } from "../lib/types.ts";
import { isTelemetryEnabled, setTelemetryEnabled } from "../lib/telemetry.ts";
import { Shimmer } from "../components/Shimmer.tsx";

export const options = z.object({});

type Props = { options: z.infer<typeof options> };

type Field = {
  key: string;
  label: string;
  value: string;
  nested?: string; // for socials.github etc.
};

export default function ConfigCommand({}: Props) {
  const { exit } = useApp();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [telemetry, setTelemetry] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    readInventory().then(setInventory);
    isTelemetryEnabled().then(setTelemetry);
  }, []);

  const { profile, insights } = inventory || { profile: {}, insights: {} } as any;

  const fields: Field[] = inventory ? [
    { key: "name", label: "Name", value: profile.name || "" },
    { key: "bio", label: "Bio", value: insights.bio ? insights.bio.slice(0, 60) + "..." : "(auto-generated on next run)" },
    { key: "emailPublic", label: "Show email publicly", value: profile.emailPublic ? "yes" : "no" },
    { key: "socials.github", label: "GitHub username", value: profile.socials?.github || "", nested: "github" },
    { key: "socials.linkedin", label: "LinkedIn", value: profile.socials?.linkedin || "", nested: "linkedin" },
    { key: "socials.twitter", label: "Twitter/X", value: profile.socials?.twitter || "", nested: "twitter" },
    { key: "socials.telegram", label: "Telegram", value: profile.socials?.telegram || "", nested: "telegram" },
    { key: "socials.website", label: "Website URL", value: profile.socials?.website || "", nested: "website" },
    { key: "telemetry", label: "Anonymous telemetry", value: telemetry ? "on" : "off" },
  ] : [];

  useInput((input, key) => {
    if (!inventory) return;
    if (editing) {
      if (key.return) {
        const field = fields[cursor]!;
        const updated = { ...inventory };

        if (field.key === "telemetry") {
          const enabled = editValue.toLowerCase().startsWith("on") || editValue.toLowerCase().startsWith("y");
          setTelemetryEnabled(enabled);
          setTelemetry(enabled);
        } else if (field.key === "emailPublic") {
          updated.profile.emailPublic = editValue.toLowerCase().startsWith("y");
        } else if (field.key === "bio") {
          updated.insights = { ...updated.insights, bio: editValue || undefined };
        } else if (field.key === "name") {
          updated.profile.name = editValue || undefined;
        } else if (field.nested) {
          if (!updated.profile.socials) updated.profile.socials = {};
          (updated.profile.socials as any)[field.nested] = editValue || undefined;
        }

        setInventory(updated);
        writeInventory(updated);
        setEditing(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        return;
      }
      if (key.escape) { setEditing(false); return; }
      if (key.backspace || key.delete) { setEditValue((v) => v.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setEditValue((v) => v + input); return; }
      return;
    }

    if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : fields.length - 1));
    else if (key.downArrow) setCursor((c) => (c < fields.length - 1 ? c + 1 : 0));
    else if (key.return) {
      const field = fields[cursor]!;
      setEditValue(field.value === "(auto-generated on next run)" ? "" : field.value);
      setEditing(true);
    }
    else if (input === "q" || key.escape) exit();
  });

  if (!inventory || telemetry === null) return <Text color="yellow">Loading config...</Text>;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text><Shimmer>agent-cv</Shimmer> <Text bold>config</Text></Text>
        <Text dimColor>[Enter] edit  [q] quit  Saved to ~/.agent-cv/inventory.json</Text>
      </Box>

      {fields.map((field, i) => {
        const isCursor = i === cursor;
        const isEditing = editing && isCursor;

        return (
          <Box key={field.key} gap={1}>
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {isCursor ? ">" : " "} {field.label}:
            </Text>
            {isEditing ? (
              <Text color="cyan">{editValue}█</Text>
            ) : (
              <Text dimColor={!field.value}>{field.value || "(empty)"}</Text>
            )}
          </Box>
        );
      })}

      {saved && <Text color="green">{"\n"}Saved!</Text>}
    </Box>
  );
}

export const description = "Edit your profile: name, bio, socials, email privacy";
