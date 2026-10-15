// Per-company data version. Any write bumps it; caches (policy index, SQL sandbox) compare
// versions to know when to rebuild. Single-instance, in-memory — fine for one web server.
const versions = new Map();
export const version = (companyId) => versions.get(companyId) || 0;
export const bump = (companyId) => versions.set(companyId, version(companyId) + 1);
