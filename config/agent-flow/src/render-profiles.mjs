#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { renderProfiles } from "./profiles.mjs";

const root =
  process.env.DOTFILES_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));

try {
  const result = await renderProfiles({
    root,
    force: process.env.DOTFILES_FORCE === "1",
  });
  const unavailable = result.unavailable.length
    ? `; routing unavailable for ${result.unavailable.join(", ")}`
    : "";
  process.stdout.write(
    `Rendered ${result.rendered.length} Hermes profiles${unavailable}.\n`,
  );
} catch (error) {
  process.stderr.write(`Hermes profile convergence failed: ${error.message}\n`);
  process.exitCode = 1;
}
