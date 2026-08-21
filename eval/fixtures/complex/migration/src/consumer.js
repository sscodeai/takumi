// Consumer — currently calls legacy, must migrate to newapi.
import { getUser } from './legacy.js';
export async function getUserName(id) {
  const u = await getUser(id);
  return u.name;
}
