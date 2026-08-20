export function mockFetch(status, body) {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
