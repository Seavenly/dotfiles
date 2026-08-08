import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function expandPath(path, { cwd, home }) {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") {
    if (!home) throw new Error("HOME is required to expand Hermes paths");
    return resolve(home);
  }
  if (trimmed.startsWith(`~${sep}`)) {
    if (!home) throw new Error("HOME is required to expand Hermes paths");
    return resolve(home, trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function isWithin(path, root) {
  const child = relative(root, path);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

export function resolveHermesRoot({
  cwd = process.cwd(),
  hermesHome = process.env.HERMES_HOME,
  home = process.env.HOME,
} = {}) {
  if (!home && !hermesHome) throw new Error("HOME or HERMES_HOME is required");
  const nativeHome = home ? resolve(home, ".hermes") : null;
  const selected = expandPath(hermesHome, { cwd, home });
  if (!selected) return nativeHome;
  if (nativeHome && isWithin(selected, nativeHome)) return nativeHome;
  if (dirname(selected).split(sep).at(-1) === "profiles") {
    return dirname(dirname(selected));
  }
  return selected;
}

export function resolveHermesKanbanHome({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const override = expandPath(env.HERMES_KANBAN_HOME, {
    cwd,
    home: env.HOME,
  });
  if (override) return override;
  return resolveHermesRoot({
    cwd,
    hermesHome: env.HERMES_HOME,
    home: env.HOME,
  });
}
