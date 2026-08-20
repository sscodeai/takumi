// BUG: returns undefined on 404; should throw Error('not found').
export async function getUser(id, fetchFn = fetch) {
  const res = await fetchFn('https://api.example.com/users/' + id);
  if (!res.ok) return undefined;
  return res.json();
}
