import { fileURLToPath } from 'node:url';
export const DB_PATH = process.env.PEOPLEOS_DB || fileURLToPath(new URL('../../data/peopleos.db', import.meta.url));
