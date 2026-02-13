import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
  console.log('.env already exists, skip writing.');
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const content = [
  'PORT=3000',
  'VAPID_SUBJECT=mailto:you@example.com',
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  ''
].join('\n');

fs.writeFileSync(envPath, content, { mode: 0o600 });
console.log(`Created ${envPath}`);
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
