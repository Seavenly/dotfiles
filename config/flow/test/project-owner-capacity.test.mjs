import assert from "node:assert/strict";
import test from "node:test";
import { ownerStart } from "../src/project-session.mjs";

test("explicit parallel review starts only the exact selected owner with capacity two", async () => {
  const calls = [];
  const selection = { client: "/owned/client/flow", execution: { parallel: 2 } };
  const call = async (_selection, args) => {
    calls.push(args);
    return args[0] === "status" ? { state: "stopped" }
      : { state: "running", started: true, runner: { delegates: { capacity: 2 } } };
  };
  assert.equal(await ownerStart(selection, call, () => {}), true);
  assert.deepEqual(calls, [["status", "--json"], ["start", "--delegate-capacity", "2", "--json"]]);
});

test("an existing serial owner is refused without an implicit stop or capacity change", async () => {
  const calls = [];
  const call = async (_selection, args) => {
    calls.push(args);
    return { state: "running", runner: { delegates: { capacity: 1 } } };
  };
  await assert.rejects(ownerStart({ client: "/owned/client/flow", execution: { parallel: 2 } }, call, () => {}),
    error => error.code === "owner_delegate_capacity_insufficient" && error.message.includes("stop --json"));
  assert.deepEqual(calls, [["status", "--json"]]);
});

test("omitted execution policy retains the original public start call", async () => {
  const calls = [];
  await ownerStart({ client: "/owned/client/flow" }, async (_selection, args) => {
    calls.push(args); return { state: "running" };
  }, () => {});
  assert.deepEqual(calls, [["status", "--json"], ["start", "--json"]]);
});
