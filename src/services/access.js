import { ROLES } from './auth.js';

// Which roles may read a policy document. Admins can always read everything.
export function parseAllowedRoles(input) {
  const values = (Array.isArray(input) ? input : String(input ?? '').split(','))
    .map((r) => String(r).trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) return [...ROLES];

  const unknown = values.filter((r) => !ROLES.includes(r));
  if (unknown.length) {
    const error = new Error(`Unknown role(s): ${unknown.join(', ')}. Use: ${ROLES.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return ROLES.filter((r) => r === 'admin' || values.includes(r));
}

// Documents indexed before roles existed have no allowedRoles and are admin-only until re-uploaded.
export function canReadDocument(doc, role) {
  return role === 'admin' || Boolean(doc?.allowedRoles?.includes(role));
}

// Pinecone metadata filter limiting retrieval to chunks this role may read (null = no filter).
export function retrievalFilter(role) {
  if (role === 'admin') return null;
  return { allowedRoles: { $in: [role] } };
}
