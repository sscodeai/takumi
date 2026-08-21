import { saveRecord } from './db.js';
export function createUser(name) {
  saveRecord({ name });
  return { name }; // BUG: should return the saved record
}
