'use strict';
// Usage: node scripts/add-user.js <email> <role> "<Full Name>"   (password is prompted, never passed as an argument)
const readline = require('readline');
const { createUser } = require('../src/auth');
const [email, role, name] = process.argv.slice(2);
if (!email || !role) { console.error('Usage: node scripts/add-user.js <email> <viewer|editor|publisher|admin> "<Full Name>"'); process.exit(1); }
const ask = (q) => new Promise((r) => {
  if (process.env.NEW_USER_PASSWORD) return r(process.env.NEW_USER_PASSWORD);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); r(a); });
});
ask('Password (min 12 chars): ').then((password) => {
  try { createUser({ email, role, name: name || email, password }); console.log(`Created ${role} ${email}`); }
  catch (e) { console.error('Error:', e.message); process.exit(1); }
});
