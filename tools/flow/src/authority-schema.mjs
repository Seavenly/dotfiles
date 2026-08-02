import { digest, freezeCanonical } from "./canonical.mjs";

export const AUTHORITY_STORE_CONTRACT = "flow.sqlite-authority-store/v1";
export const CURRENT_AUTHORITY_SCHEMA_VERSION = 2;
export const AUTHORITY_SCHEMA_RELEASE = Object.freeze({
  schema: "flow.runtime-release/v1",
  id: "flow-runtime-authority-schema/v2",
  catalog_version: 8,
});

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

export function initializeAuthoritySchema(
  database,
  { afterCommit = () => {}, beforeCommit = () => {} } = {},
) {
  const existing = readAuthoritySchemaCompatibility(database);
  if (existing.status !== "uninitialized") {
    return existing;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    createAuthorityTables(database);
    createCurrentMetadata(database, 0);
    const transitioned = readAuthoritySchemaCompatibility(database);
    beforeCommit(transitionBoundary("before_commit", existing, transitioned));
    database.exec("COMMIT");
    afterCommit(transitionBoundary(
      "after_commit",
      existing,
      readAuthoritySchemaCompatibility(database),
    ));
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return readAuthoritySchemaCompatibility(database);
}

export function transitionAuthoritySchema(database, {
  afterCommit = () => {},
  beforeCommit = () => {},
  expectedWatermark,
} = {}) {
  const existing = readAuthoritySchemaCompatibility(database);
  if (existing.status !== "transition_required" ||
      existing.watermark !== expectedWatermark) {
    return existing;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    migrateVersionOne(database);
    const transitioned = readAuthoritySchemaCompatibility(database);
    beforeCommit(transitionBoundary("before_commit", existing, transitioned));
    database.exec("COMMIT");
    afterCommit(transitionBoundary(
      "after_commit",
      existing,
      readAuthoritySchemaCompatibility(database),
    ));
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return readAuthoritySchemaCompatibility(database);
}

export function uninitializedAuthoritySchemaCompatibility() {
  return compatibilityProjection({
    status: "uninitialized",
    storeContract: null,
    version: 0,
    release: null,
    sequence: 0,
    transitions: [],
  });
}

export function readAuthoritySchemaCompatibility(database) {
  if (!tableExists(database, "authority_metadata")) {
    return uninitializedAuthoritySchemaCompatibility();
  }

  const columns = new Set(database.prepare(
    "PRAGMA table_info(authority_metadata)",
  ).all().map(({ name }) => name));
  const metadata = database.prepare(
    "SELECT * FROM authority_metadata WHERE singleton = 1",
  ).get();
  if (!metadata) {
    return compatibilityProjection({
      status: "incompatible",
      storeContract: null,
      version: null,
      release: null,
      sequence: null,
      transitions: [],
    });
  }

  const version = columns.has("schema_version")
    ? Number(metadata.schema_version)
    : 1;
  const release = columns.has("transition_release_json") &&
      metadata.transition_release_json
    ? parseRelease(metadata.transition_release_json)
    : null;
  const sequence = columns.has("transition_sequence")
    ? Number(metadata.transition_sequence)
    : 0;
  const transitions = tableExists(database, "authority_schema_transitions")
    ? database.prepare(`
        SELECT sequence, contract, from_version, to_version,
               transition_release_json, previous_digest, record_digest
          FROM authority_schema_transitions ORDER BY sequence
      `).all().map((row) => ({
        sequence: nonNegativeSafeIntegerOrNull(Number(row.sequence)),
        contract: stringOrNull(row.contract),
        from_version: nonNegativeSafeIntegerOrNull(Number(row.from_version)),
        to_version: nonNegativeSafeIntegerOrNull(Number(row.to_version)),
        transition_release: parseRelease(row.transition_release_json),
        previous_digest: stringOrNull(row.previous_digest),
        record_digest: stringOrNull(row.record_digest),
      }))
    : [];

  let status = "incompatible";
  const legacyMetadataShape = columns.size === 2 &&
    columns.has("singleton") && columns.has("contract") &&
    !tableExists(database, "authority_schema_transitions");
  if (metadata.contract === AUTHORITY_STORE_CONTRACT && version === 1 &&
      legacyMetadataShape) {
    status = "transition_required";
  } else if (metadata.contract === AUTHORITY_STORE_CONTRACT &&
      version === CURRENT_AUTHORITY_SCHEMA_VERSION &&
      sameRelease(release, AUTHORITY_SCHEMA_RELEASE) &&
      transitionHistoryIsValid(transitions, sequence)) {
    status = "compatible";
  }
  return compatibilityProjection({
    status,
    storeContract: typeof metadata.contract === "string"
      ? metadata.contract
      : null,
    version: nonNegativeSafeIntegerOrNull(version),
    release,
    sequence: nonNegativeSafeIntegerOrNull(sequence),
    transitions,
  });
}

function transitionBoundary(phase, existing, transitioned) {
  return freezeCanonical({
    schema: "flow.authority-schema-transition-boundary/v1",
    phase,
    from_version: existing.version,
    to_version: CURRENT_AUTHORITY_SCHEMA_VERSION,
    from_watermark: existing.watermark,
    transition_release: AUTHORITY_SCHEMA_RELEASE,
    authority_schema: transitioned,
  });
}

function createAuthorityTables(database) {
  database.exec(`
    CREATE TABLE authority_streams (
      stream_id TEXT PRIMARY KEY,
      stream_kind TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
      head_digest TEXT NOT NULL,
      fold_contract TEXT,
      fold_json TEXT,
      fold_digest TEXT
    );

    CREATE TABLE authority_events (
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      contract TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      previous_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
      boot_id TEXT NOT NULL,
      process_identity TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence),
      FOREIGN KEY (stream_id) REFERENCES authority_streams(stream_id)
    );

    CREATE TRIGGER authority_events_no_update
      BEFORE UPDATE ON authority_events
      BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
    CREATE TRIGGER authority_events_no_delete
      BEFORE DELETE ON authority_events
      BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
  `);
}

function createCurrentMetadata(database, fromVersion) {
  createMetadataTable(database);
  createTransitionTable(database);
  insertCurrentMetadata(database);
  insertTransition(database, fromVersion);
}

function createMetadataTable(database) {
  database.exec(`
    CREATE TABLE authority_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      contract TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      transition_release_json TEXT NOT NULL,
      transition_sequence INTEGER NOT NULL CHECK (transition_sequence > 0)
    );
  `);
}

function insertCurrentMetadata(database) {
  database.prepare(`
    INSERT INTO authority_metadata(
      singleton, contract, schema_version, transition_release_json,
      transition_sequence
    ) VALUES (1, ?, ?, ?, 1)
  `).run(
    AUTHORITY_STORE_CONTRACT,
    CURRENT_AUTHORITY_SCHEMA_VERSION,
    JSON.stringify(AUTHORITY_SCHEMA_RELEASE),
  );
}

function migrateVersionOne(database) {
  database.exec(`
    ALTER TABLE authority_metadata RENAME TO authority_metadata_v1;
  `);
  createMetadataTable(database);
  createTransitionTable(database);
  insertCurrentMetadata(database);
  insertTransition(database, 1);
  database.exec("DROP TABLE authority_metadata_v1");
}

function createTransitionTable(database) {
  database.exec(`
    CREATE TABLE authority_schema_transitions (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      contract TEXT NOT NULL,
      from_version INTEGER NOT NULL CHECK (from_version >= 0),
      to_version INTEGER NOT NULL CHECK (to_version > from_version),
      transition_release_json TEXT NOT NULL,
      previous_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL
    );
    CREATE TRIGGER authority_schema_transitions_no_update
      BEFORE UPDATE ON authority_schema_transitions
      BEGIN SELECT RAISE(ABORT, 'authority schema transitions are append-only'); END;
    CREATE TRIGGER authority_schema_transitions_no_delete
      BEFORE DELETE ON authority_schema_transitions
      BEGIN SELECT RAISE(ABORT, 'authority schema transitions are append-only'); END;
  `);
}

function insertTransition(database, fromVersion) {
  const record = {
    schema: "flow.authority-schema-transition/v1",
    sequence: 1,
    contract: AUTHORITY_STORE_CONTRACT,
    from_version: fromVersion,
    to_version: CURRENT_AUTHORITY_SCHEMA_VERSION,
    transition_release: AUTHORITY_SCHEMA_RELEASE,
    previous_digest: EMPTY_WATERMARK,
  };
  database.prepare(`
    INSERT INTO authority_schema_transitions(
      sequence, contract, from_version, to_version,
      transition_release_json, previous_digest, record_digest
    ) VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    record.contract,
    record.from_version,
    record.to_version,
    JSON.stringify(record.transition_release),
    record.previous_digest,
    digest(record),
  );
}

function compatibilityProjection({
  status,
  storeContract,
  version,
  release,
  sequence,
  transitions,
}) {
  const identity = {
    schema: "flow.authority-schema-compatibility/v1",
    status,
    store_contract: storeContract,
    version,
    transition_release: release,
    transition_sequence: sequence,
  };
  const watermark = digest({ ...identity, transitions });
  return freezeCanonical({ ...identity, watermark });
}

function transitionHistoryIsValid(transitions, sequence) {
  if (sequence !== 1 || transitions.length !== 1) return false;
  const [transition] = transitions;
  const record = {
    schema: "flow.authority-schema-transition/v1",
    sequence: transition.sequence,
    contract: transition.contract,
    from_version: transition.from_version,
    to_version: transition.to_version,
    transition_release: transition.transition_release,
    previous_digest: transition.previous_digest,
  };
  return transition.sequence === 1 &&
    transition.contract === AUTHORITY_STORE_CONTRACT &&
    [0, 1].includes(transition.from_version) &&
    transition.to_version === CURRENT_AUTHORITY_SCHEMA_VERSION &&
    sameRelease(transition.transition_release, AUTHORITY_SCHEMA_RELEASE) &&
    transition.previous_digest === EMPTY_WATERMARK &&
    transition.record_digest === digest(record);
}

function parseRelease(value) {
  try {
    const release = JSON.parse(value);
    return isPublishedRelease(release) ? release : null;
  } catch {
    return null;
  }
}

function isPublishedRelease(value) {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) &&
    value.schema === "flow.runtime-release/v1" &&
    typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.catalog_version) && value.catalog_version > 0 &&
    Object.keys(value).length === 3;
}

function nonNegativeSafeIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function sameRelease(left, right) {
  return left?.schema === right.schema && left?.id === right.id &&
    left?.catalog_version === right.catalog_version &&
    Object.keys(left ?? {}).length === 3;
}

function tableExists(database, table) {
  return Boolean(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table));
}
