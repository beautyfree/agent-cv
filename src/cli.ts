#!/usr/bin/env bun
import Pastel from "pastel";

const app = new Pastel({
  importMeta: import.meta,
  name: "llm-cv",
  version: "0.1.0",
  description: "Generate technical CVs from your local project directories using AI",
});

await app.run();
