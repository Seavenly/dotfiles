export function acquireAuthorityLock({
  createDatabase,
  lockPath,
  processIdentity,
}) {
  const database = createDatabase(lockPath);
  try {
    database.exec(`
      PRAGMA busy_timeout = 0;
      CREATE TABLE IF NOT EXISTS advisory_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_process_identity TEXT
      );
      INSERT OR IGNORE INTO advisory_lock(singleton, owner_process_identity)
        VALUES (1, NULL);
      BEGIN IMMEDIATE;
    `);
    database.prepare(`
      UPDATE advisory_lock SET owner_process_identity = ? WHERE singleton = 1
    `).run(processIdentity);
    return database;
  } catch (error) {
    database.close();
    if (error?.code === "ERR_SQLITE_ERROR" &&
        /database is locked/u.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export function assertMutationFence({
  database,
  expected,
  lockDatabase,
  readAdmission,
}) {
  if (!lockDatabase?.isTransaction) {
    throw new AuthorityFenceError(
      "stale_authority_epoch",
      "mutating runtime does not hold the advisory lock",
    );
  }
  const owner = lockDatabase.prepare(`
    SELECT owner_process_identity FROM advisory_lock WHERE singleton = 1
  `).get();
  if (owner?.owner_process_identity !== expected.processIdentity) {
    throw new AuthorityFenceError(
      "stale_authority_epoch",
      "mutating runtime lost the advisory lock",
    );
  }
  assertAuthorityEpoch({ database, expected, readAdmission });
}

export function assertAuthorityEpoch({ database, expected, readAdmission }) {
  const admission = readAdmission(database);
  if (admission?.authority_epoch !== expected.authorityEpoch ||
      admission.boot_id !== expected.bootId ||
      admission.process_identity !== expected.processIdentity) {
    throw new AuthorityFenceError(
      "stale_authority_epoch",
      "stale authority epoch",
    );
  }
}

export class AuthorityFenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorityFenceError";
    this.code = code;
  }
}
