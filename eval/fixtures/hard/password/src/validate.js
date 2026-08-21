// BUG: missing the "password" substring ban.
export function isValidPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true; // BUG: should also reject if pw.toLowerCase().includes('password')
}
