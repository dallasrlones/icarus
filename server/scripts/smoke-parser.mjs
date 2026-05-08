// Smoke test for the streaming fence parser.
// Run with: cd server && npx tsx scripts/smoke-parser.mjs

import { FenceParser } from "../src/commands/parser.ts";

function run(label, deltas, expected) {
  const parser = new FenceParser();
  const events = [];
  for (const d of deltas) events.push(...parser.feed(d));
  events.push(...parser.end());

  // Merge adjacent text events — delta granularity is irrelevant downstream,
  // we only care that the parser keeps fence content out of text and never
  // emits text when it should be holding back a partial opener/closer.
  const merged = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (e.type === "text" && last && last.type === "text") {
      last.text += e.text;
    } else {
      merged.push({ ...e });
    }
  }

  const got = merged.map((e) =>
    e.type === "text"
      ? `T:${JSON.stringify(e.text)}`
      : e.type === "pill_open"
      ? `OPEN`
      : `CLOSE:${JSON.stringify(e.body)}`,
  );
  const want = expected;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log("  got:", got);
    console.log("  want:", want);
  }
  return ok;
}

let allOk = true;

allOk &= run(
  "single fence in one delta",
  ['Sure thing!\n```icarus\n{"kind":"create_project","payload":{"name":"x"}}\n```\nDone.'],
  [
    'T:"Sure thing!\\n"',
    "OPEN",
    'CLOSE:"{\\"kind\\":\\"create_project\\",\\"payload\\":{\\"name\\":\\"x\\"}}"',
    'T:"Done."',
  ],
);

allOk &= run(
  "fence split across many deltas",
  ["Hello ", "user!\n", "``", "`ic", "arus\n", "{\"k", "ind\":\"x\"}\n", "``", "`\nbye"],
  ['T:"Hello user!\\n"', "OPEN", 'CLOSE:"{\\"kind\\":\\"x\\"}"', 'T:"bye"'],
);

allOk &= run(
  "non-icarus fence passes through as text",
  ['Look:\n```bash\necho hi\n```\nThat\'s it.'],
  ['T:"Look:\\n```bash\\necho hi\\n```\\nThat\'s it."'],
);

allOk &= run(
  "multiple fences in one reply",
  ['ok\n```icarus\n{"kind":"a"}\n```\nand\n```icarus\n{"kind":"b"}\n```\n!'],
  [
    'T:"ok\\n"',
    "OPEN",
    'CLOSE:"{\\"kind\\":\\"a\\"}"',
    'T:"and\\n"',
    "OPEN",
    'CLOSE:"{\\"kind\\":\\"b\\"}"',
    'T:"!"',
  ],
);

allOk &= run(
  "unclosed fence flushed at end()",
  ['hi\n```icarus\n{"kind":"x"'],
  ['T:"hi\\n"', "OPEN", 'CLOSE:"{\\"kind\\":\\"x\\""'],
);

allOk &= run(
  "closer at end of stream without trailing newline",
  ['done.\n```icarus\n{"kind":"x"}\n```'],
  ['T:"done.\\n"', "OPEN", 'CLOSE:"{\\"kind\\":\\"x\\"}"'],
);

allOk &= run(
  "closer at end of stream split across deltas",
  ['done.\n```icarus\n{"kind":"x"}\n', '`', '`', '`'],
  ['T:"done.\\n"', "OPEN", 'CLOSE:"{\\"kind\\":\\"x\\"}"'],
);

allOk &= run(
  "leading fence",
  ['```icarus\n{"k":1}\n```\nrest'],
  ["OPEN", 'CLOSE:"{\\"k\\":1}"', 'T:"rest"'],
);

allOk &= run(
  "char-by-char streaming",
  Array.from('a\n```icarus\n{"k":1}\n```\nb'),
  ['T:"a\\n"', "OPEN", 'CLOSE:"{\\"k\\":1}"', 'T:"b"'],
);

process.exit(allOk ? 0 : 1);
