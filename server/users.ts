// Operator accounts live in the database and can only be managed from here, on the server.
// There is deliberately no sign-up page: nobody on the internet can create an account.
//
//   npm run user -- add <email>      create an operator, or change their password
//   npm run user -- remove <email>   delete an operator and sign them out everywhere
//   npm run user -- list
import { createInterface } from 'node:readline';
import { hashPassword, MIN_PASSWORD } from './auth';
import { config } from './config';
import { createPool, PostgresStore } from './db';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  if (process.stdin.isTTY) {
    // Do not echo the password to the terminal.
    (rl as any)._writeToOutput = (text: string) => { if (text.includes(question)) process.stdout.write(question); };
  }
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); if (process.stdin.isTTY) process.stdout.write('\n'); resolve(answer); }));
}

const [command, emailArg] = process.argv.slice(2);
if (!config.databaseUrl) {
  console.error('Defina DATABASE_URL com a ligação ao Neon antes de gerir operadores.');
  process.exit(1);
}
const pool = createPool(config.databaseUrl);
const store = new PostgresStore(pool);
await store.migrate();
const email = (emailArg ?? '').trim().toLowerCase();

try {
  if (command === 'add' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const password = await ask(`Palavra-passe para ${email} (mínimo ${MIN_PASSWORD} caracteres): `);
    if (password.length < MIN_PASSWORD) throw new Error(`A palavra-passe tem de ter pelo menos ${MIN_PASSWORD} caracteres.`);
    await store.upsertOperator(email, await hashPassword(password));
    console.log(`Operador ${email} guardado. Sessões antigas dessa conta foram terminadas.`);
  } else if (command === 'remove' && email) {
    console.log((await store.removeOperator(email)) ? `Operador ${email} removido.` : `Não existe operador ${email}.`);
  } else if (command === 'list') {
    const rows = await store.listOperators();
    if (!rows.length) console.log('Sem operadores. Crie um com: npm run user -- add <email>');
    for (const r of rows) console.log(`${r.email}  criado ${r.createdAt.toISOString().slice(0, 10)}  sessões ativas ${r.sessions}`);
  } else {
    console.log('Uso: npm run user -- add <email> | remove <email> | list');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
