import { readFile, realpath } from "node:fs/promises";

// Resolve the executable a PID is running, stopping at the first platform
// lookup that yields a path the caller accepts. `isAccepted` carries the trust
// policy: this module knows how to observe an executable path, not which paths
// a harness is allowed to be running, so a caller can accept a path this module
// has no opinion about - such as the native binary a Node launcher execs.
export async function processExecutablePath(
  candidate,
  isAccepted,
  client,
  { realpathImpl = realpath } = {},
) {
  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) return null;
  let procPath;
  try {
    procPath = await realpathImpl(`/proc/${candidate.pid}/exe`);
  } catch {
    // macOS and restricted Linux environments do not expose /proc.
  }
  // /proc/<pid>/exe is authoritative, so a rejection there needs no fallback.
  if (procPath !== undefined) {
    return (await isAccepted(procPath)) ? procPath : null;
  }
  if (!client?.run) {
    return null;
  }
  for (const args of [
    ["ps", ["-p", String(candidate.pid), "-o", "comm="]],
    ["ps", ["-p", String(candidate.pid), "-o", "command="]],
    ["lsof", ["-p", String(candidate.pid), "-a", "-d", "txt", "-Fn"]],
  ]) {
    let resolved;
    try {
      const output = String(await client.run(args[0], args[1], { env: client.env }));
      const candidatePath = args[0] === "lsof"
        ? output
            .split(/\r?\n/u)
            .find((line) => line.startsWith("n"))
            ?.slice(1)
        : output.trim().split(/\s+/u)[0];
      if (!candidatePath?.startsWith("/")) continue;
      try {
        resolved = await realpathImpl(candidatePath);
      } catch {
        resolved = candidatePath;
      }
    } catch {
      // Try the next platform-specific process lookup shape.
      continue;
    }
    if (await isAccepted(resolved)) return resolved;
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
  const normalizedCommandLine =
    typeof commandLine === "string" ? commandLine.trim() : "";
  if (!normalizedCommandLine) return null;
  try {
    const output = await client.run(
      "ps",
      ["eww", "-p", String(pid), "-o", "command="],
      { env: client.env },
    );
    const outputLine = String(output);
    if (!outputLine.startsWith(normalizedCommandLine)) {
      return null;
    }
    const environmentOutput = outputLine.slice(normalizedCommandLine.length);
    if (
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
