// NEW API — already implemented.
export async function fetchUser(id) {
  const res = await fetch('https://api.new.example.com/users/' + id);
  const u = await res.json();
  return { id: u.id, displayName: u.displayName }; // new shape
}
