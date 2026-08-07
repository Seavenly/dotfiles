import { readFile, realpath } from "node:fs/promises";

export async function processExecutablePath(
  candidate,
  expectedPaths,
  client,
  { realpathImpl = realpath } = {},
) {
  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) return null;
  try {
    const path = await realpathImpl(`/proc/${candidate.pid}/exe`);
    return expectedPaths.has(path) ? path : null;
  } catch {
    // macOS and restricted Linux environments do not expose /proc.
  }
  if (!client?.run) {
    return null;
  }
  for (const args of [
    ["ps", ["-p", String(candidate.pid), "-o", "comm="]],
    ["ps", ["-p", String(candidate.pid), "-o", "command="]],
    ["lsof", ["-p", String(candidate.pid), "-a", "-d", "txt", "-Fn"]],
  ]) {
    try {
      const output = String(await client.run(args[0], args[1], { env: client.env }));
      const candidatePath = args[0] === "lsof"
        ? output
            .split(/\r?\n/u)
            .find((line) => line.startsWith("n"))
            ?.slice(1)
        : output.trim().split(/\s+/u)[0];
      if (!candidatePath?.startsWith("/")) continue;
      let resolved;
      try {
        resolved = await realpathImpl(candidatePath);
      } catch {
        resolved = candidatePath;
      }
      if (expectedPaths.has(resolved)) return resolved;
    } catch {
      // Try the next platform-specific process lookup shape.
    }
  }
  return null;
}

export async function processEnvironmentPath(
  pid,
  client,
  { commandLine, readFileImpl = readFile } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const environment = await readFileImpl(`/proc/${pid}/environ`);
    const entry = environment
      .toString()
      .split("\u0000")
      .find((value) => value.startsWith("PATH="));
    if (entry?.length > "PATH=".length) return entry.slice("PATH=".length);
  } catch {
    // macOS and restricted Linux environments do not expose /proc.
  }
  try {
    const output = await client.run(
      "ps",
      ["eww", "-p", String(pid), "-o", "command="],
      { env: client.env },
    );
    const outputLine = String(output);
    const normalizedCommandLine =
      typeof commandLine === "string" ? commandLine.trim() : "";
    if (
      normalizedCommandLine &&
      !outputLine.startsWith(normalizedCommandLine)
    ) {
      return null;
    }
    const environmentOutput = normalizedCommandLine
      ? outputLine.slice(normalizedCommandLine.length)
      : outputLine;
    if (
      normalizedCommandLine &&
      environmentOutput &&
      !/^\s+[A-Za-z_][A-Za-z0-9_]*=/u.test(environmentOutput)
    ) {
      return null;
    }
    const matches = [
      ...environmentOutput.matchAll(
        /(?:^|\s)PATH=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/gu,
      ),
    ];
    const path = matches.at(-1)?.[1]?.trim();
    return path || null;
  } catch {
    return null;
  }
}
