import { loadStorage, rotateSecret } from '../config/config.js';

if (process.env.ARCHIPEL_SECRET) {
  console.error('ARCHIPEL_SECRET is set: change its value and put the old one in ARCHIPEL_SECRET_PREVIOUS.');
  process.exit(2);
}
rotateSecret(loadStorage().dataDir);
console.log('Key renewed. Restart the server: the old key stays accepted until the next rotation.');
