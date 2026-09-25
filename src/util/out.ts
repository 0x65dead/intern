// The only two functions in this project that write to a terminal.
//
// HARD CONSTRAINT 4 says every log line routes through `redactKeys()`. Spread
// across thirty `process.stdout.write` call sites that is not a constraint, it is
// a habit — and an audit found the place the habit lapsed: a private key pasted
// at the "fire at" prompt was echoed verbatim, because one catch block out of
// several forgot the call its neighbours all made.
//
// Routing every write through here makes the rule true by construction instead of
// by review. Redaction is idempotent, so a caller that redacts as well is not
// penalised, and it is a no-op on the constant strings that make up most output.

import { redactKeys } from "../core/wallets";

/** Write to stdout, key material removed. */
export function writeOut(text: string): void {
  process.stdout.write(redactKeys(text));
}

/** Write to stderr, key material removed. */
export function writeErr(text: string): void {
  process.stderr.write(redactKeys(text));
}
