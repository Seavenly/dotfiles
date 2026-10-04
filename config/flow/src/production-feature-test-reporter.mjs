// Fixed Node 22 test-event projection. Test stdout cannot impersonate records.
export default async function* report(source) {
  for await (const event of source) {
    const data = event.data;
    if (event.type === "test:pass" || event.type === "test:fail") {
      const error = data.details?.error?.cause ?? data.details?.error;
      yield JSON.stringify({ kind: event.type === "test:pass" ? "pass" : "fail", name: data.name,
        ...(event.type === "test:fail" ? { failure: {
          code: error?.code ?? null, operator: error?.operator ?? null,
          expected: error?.expected ?? null, actual: error?.actual ?? null,
        } } : {}) }) + "\n";
    } else if (event.type === "test:summary" && data.file === undefined) {
      yield JSON.stringify({ kind: "summary", tests: data.counts.tests, passed: data.counts.passed,
        failed: data.counts.failed, cancelled: data.counts.cancelled, skipped: data.counts.skipped, todo: data.counts.todo }) + "\n";
    } else if (["test:stdout", "test:stderr"].includes(event.type)) {
      yield JSON.stringify({ kind: "unexpected_output" }) + "\n";
    }
  }
}
