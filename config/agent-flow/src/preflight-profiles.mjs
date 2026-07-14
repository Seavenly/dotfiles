#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  adoptLegacyProfiles,
  assertClaimableProfiles,
  inspectProfileSet,
} from "./profile-ownership.mjs";

const root =
  process.env.DOTFILES_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const home = process.env.HOME;

try {
  if (!home) throw new Error("HOME is required");
  const inspections = await inspectProfileSet({ root, home });
  assertClaimableProfiles(inspections, {
    force: process.env.DOTFILES_FORCE === "1",
  });
  await adoptLegacyProfiles(inspections);
} catch (error) {
  process.stderr.write(`Hermes profile preflight failed: ${error.message}\n`);
  process.exitCode = 1;
}
