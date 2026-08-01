export function fixedHostIdentity(bootId, processIdentity) {
  return Object.freeze({
    observe() {
      return Object.freeze({
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      });
    },
  });
}
