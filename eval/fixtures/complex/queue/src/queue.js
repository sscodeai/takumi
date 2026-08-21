// BUG: results order does not match input order.
export async function processAll(jobs) {
  const results = [];
  await Promise.all(jobs.map(async (job) => {
    try {
      const r = await job();
      results.push({ value: r });
    } catch (e) {
      results.push({ error: e.message });
    }
  }));
  return results; // BUG: order is completion order, not input order
}
