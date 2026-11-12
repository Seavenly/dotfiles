import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";
import { validateResearchInputSafety } from "./evidence-safety.mjs";

export const DEEP_RESEARCH_SELECTION_SCHEMA = "flow.project-deep-research-selection/v1";
export const DEEP_RESEARCH_LIMITS = Object.freeze({ angles: 2, angle_bytes: 1024, cycles: 2, native_attempts: 6 });

function safeAngle(text) {
  return typeof text === "string" && text.trim().length > 0 &&
    Buffer.byteLength(text, "utf8") <= DEEP_RESEARCH_LIMITS.angle_bytes &&
    validateResearchInputSafety({ angle_text: text }).accepted === true;
}

export function validateDeepResearchSelection(value) {
  try {
    return isPlainRecord(value) && Object.keys(value).sort().join(",") === "angles,max_cycles,parallel,schema" &&
      value.schema === DEEP_RESEARCH_SELECTION_SCHEMA && [1, 2].includes(value.parallel) &&
      [1, 2].includes(value.max_cycles) && Array.isArray(value.angles) && value.angles.length === 2 &&
      value.angles.every((angle, index) => isPlainRecord(angle) &&
        Object.keys(angle).sort().join(",") === "angle_id,text" && angle.angle_id === `angle:${index + 1}` && safeAngle(angle.text)) &&
      value.angles[0].text.trim().normalize("NFC") !== value.angles[1].text.trim().normalize("NFC");
  } catch { return false; }
}

export function createDeepResearchSelection({ angles, parallel = 2, max_cycles = 2 } = {}) {
  const value = { schema: DEEP_RESEARCH_SELECTION_SCHEMA,
    angles: Array.isArray(angles) ? angles.map((text, index) => ({ angle_id: `angle:${index + 1}`, text })) : [],
    parallel, max_cycles };
  if (!validateDeepResearchSelection(value)) {
    const error = new Error("Deep research requires two distinct safe angle texts of at most 1 KiB each, --parallel 1|2 and --max-cycles 1|2.");
    error.code = "invalid_deep_research_selection";
    throw error;
  }
  return freezeCanonical(value);
}

export function researchQuestion(text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 4096 ||
      !validateResearchInputSafety({ question_text: text }).accepted) return null;
  return freezeCanonical({ id: `question:${digest(text).slice(7)}`, text });
}
