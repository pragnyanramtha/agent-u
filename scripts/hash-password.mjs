#!/usr/bin/env node
/* Prints a UI_PASSWORD_HASH line for .env.local. Reads the password from stdin so it never lands in shell history. */
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.split("\n")[0].trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise((resolve) => rl.question("Password: ", resolve));
  rl.close();
  return String(answer).trim();
}

const password = await readPassword();
if (password.length < 6) {
  console.error("Use at least 6 characters.");
  process.exit(1);
}
if (password.length < 12) console.error("Warning: short passwords are easy to guess, and this site can open a shell on the server.");
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
console.log(`UI_PASSWORD_HASH=scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`);
