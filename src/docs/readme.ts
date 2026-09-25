// The README's generated blocks.
//
// The speed claim is the one sentence in this project most likely to drift into an
// overstatement, because it is the sentence a reader most wants to be optimistic.
// So it is not written in the README at all: it is rendered from SPEED_STATEMENT,
// the same constant CAPABILITY.md renders, and a test fails if the committed
// README does not match. The surrounding prose stays hand-written.

import { SPEED_STATEMENT } from "../core/race";

export const SPEED_BLOCK = "speed-statement";

/** The managed block's body. Blockquoted so it reads as the authoritative claim. */
export function renderSpeedBlock(): string {
  return `> **The speed claim, stated once.** ${SPEED_STATEMENT}
>
> This paragraph is generated from \`SPEED_STATEMENT\` in \`src/core/race.ts\` and is
> rendered identically in [CAPABILITY.md](CAPABILITY.md). Run \`npm run docs\` after
> changing it.`;
}

/**
 * Replace one `<!-- BEGIN GENERATED: name -->` … `<!-- END GENERATED: name -->`
 * block, leaving everything else byte-identical.
 *
 * Throws rather than appending when the markers are absent: a generator that
 * silently adds a second copy of the speed claim to the bottom of the README is
 * worse than one that stops and says the markers moved.
 */
export function replaceBlock(source: string, name: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`README is missing the "${name}" generated block markers.`);
  }
  return `${source.slice(0, from)}${begin}\n${body}\n${source.slice(to)}`;
}

/** Apply every managed block to a README's current text. */
export function renderReadme(current: string): string {
  return replaceBlock(current, SPEED_BLOCK, renderSpeedBlock());
}
