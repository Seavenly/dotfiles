import assert from "node:assert/strict";
import test from "node:test";

import {
  authorityRootsAreDisjoint,
  resolveAuthorityRoot,
} from "../src/authority-root.mjs";

test("an explicit home does not mix in the ambient state directory", () => {
  const originalStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/ambient/state";
  try {
    assert.equal(
      resolveAuthorityRoot(
        { base: "state", path: "flow" },
        { homeDirectory: "/explicit/home" },
      ),
      "/explicit/home/.local/state/flow",
    );
  } finally {
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
  }
});

test("an explicit state directory cannot mix in the ambient home", () => {
  assert.equal(
    resolveAuthorityRoot(
      { base: "state", path: "flow" },
      { stateDirectory: "/explicit/state" },
    ),
    "/explicit/state/flow",
  );
  assert.throws(
    () => resolveAuthorityRoot(
      { base: "home", path: ".agent-teams" },
      { stateDirectory: "/explicit/state" },
    ),
    /authority root environment requires an explicit home directory/,
  );
});

test("authority-root specifications fail closed on invalid or escaping paths", () => {
  const environment = {
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  };

  assert.throws(
    () => resolveAuthorityRoot({ base: "root", path: "flow" }, environment),
    /authority root specification is invalid/,
  );
  assert.throws(
    () => resolveAuthorityRoot({ base: "state", path: "/etc" }, environment),
    /authority root path must be relative/,
  );
  assert.throws(
    () => resolveAuthorityRoot({ base: "state", path: "../../etc" }, environment),
    /authority root path escapes its declared base/,
  );
});

test("authority roots distinguish sibling prefixes from nested paths", () => {
  const environment = {
    homeDirectory: "/test/home",
    stateDirectory: "/test/state",
  };

  assert.equal(
    authorityRootsAreDisjoint([
      { base: "state", path: "flow" },
      { base: "state", path: "flow-archive" },
    ], environment),
    true,
  );
  assert.equal(
    authorityRootsAreDisjoint([
      { base: "state", path: "flow" },
      { base: "state", path: "flow/archive" },
    ], environment),
    false,
  );
});
