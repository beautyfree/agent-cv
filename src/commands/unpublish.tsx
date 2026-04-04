import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readAuthToken } from "../lib/auth.ts";

type Phase = "confirming" | "deleting" | "done" | "error";

export default function Unpublish() {
  const [phase, setPhase] = useState<Phase>("confirming");
  const [error, setError] = useState("");

  useEffect(() => {
    run();
  }, []);

  async function run() {
    try {
      const auth = await readAuthToken();
      if (!auth?.jwt) {
        setError("Not authenticated. Run `agent-cv publish` first.");
        setPhase("error");
        return;
      }

      setPhase("deleting");
      const res = await fetch("https://agent-cv.dev/api/publish", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${auth.jwt}` },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setPhase("done");
    } catch (e: any) {
      setError(e.message || "Unknown error");
      setPhase("error");
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {phase === "confirming" && <Text color="gray">Checking authentication...</Text>}
      {phase === "deleting" && <Text color="gray">Removing portfolio...</Text>}
      {phase === "done" && <Text color="green">Portfolio removed from agent-cv.dev.</Text>}
      {phase === "error" && <Text color="red">Error: {error}</Text>}
    </Box>
  );
}
