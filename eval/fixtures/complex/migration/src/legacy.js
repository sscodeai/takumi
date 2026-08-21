// LEGACY API — must not be used by consumer after migration.
export async function getUser(id) {
  const res = await fetch('https://api.legacy.example.com/users/' + id);
  const u = await res.json();
  return { id: u.id, name: u.name }; // legacy shape
}
