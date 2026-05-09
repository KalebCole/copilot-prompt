import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePrompt } from "../lib/sanitize.mjs";

// Each fixture: { name, input, expected }
// "expected" is what sanitizePrompt(input) must produce after the call.
// Fixtures cover: rule fires correctly + rule does NOT false-positive on identifiers.
const fixtures = [
  // --- Rule 1+2: code fences ---
  {
    name: "strips opening triple-backtick fence with language tag",
    input: "```js\nconst x = 1;\n```",
    expected: "const x = 1;",
  },
  {
    name: "strips opening triple-tilde fence",
    input: "~~~python\nprint('hi')\n~~~",
    expected: "print('hi')",
  },
  {
    name: "strips bare opening fence (no language)",
    input: "```\nfoo\n```",
    expected: "foo",
  },

  // --- Rule 3: ATX headers ---
  {
    name: "strips ## header, keeps text",
    input: "## Section Title\nbody text",
    expected: "Section Title\nbody text",
  },
  {
    name: "strips trailing closing #s on ATX header",
    input: "# Title ##",
    expected: "Title",
  },
  {
    name: "preserves #hashtag (no space after #)",
    input: "tweet about #hashtag now",
    expected: "tweet about #hashtag now",
  },
  {
    name: "preserves #!/usr/bin/env shebang",
    input: "#!/usr/bin/env node\nrun stuff",
    expected: "#!/usr/bin/env node\nrun stuff",
  },

  // --- Rule 4: thematic breaks ---
  {
    name: "strips --- thematic break",
    input: "above\n---\nbelow",
    expected: "above\n\nbelow",
  },
  {
    name: "strips *** thematic break",
    input: "above\n***\nbelow",
    expected: "above\n\nbelow",
  },
  {
    name: "strips ___ thematic break",
    input: "above\n___\nbelow",
    expected: "above\n\nbelow",
  },
  {
    name: "strips spaced - - - thematic break",
    input: "above\n- - -\nbelow",
    expected: "above\n\nbelow",
  },
  {
    name: "preserves git checkout -- . (mixed separators)",
    input: "run: git checkout -- .",
    expected: "run: git checkout -- .",
  },
  {
    name: "preserves ---a--- (non-whole-line)",
    input: "tag ---a--- mid",
    expected: "tag ---a--- mid",
  },

  // --- Rule 5: blockquotes ---
  {
    name: "strips > blockquote with mandatory space",
    input: "> quoted line\nnext",
    expected: "quoted line\nnext",
  },
  {
    name: "preserves >file.txt redirect (no space after >)",
    input: "echo hi >file.txt",
    expected: "echo hi >file.txt",
  },
  {
    name: "preserves > /dev/null redirect (mid-line)",
    input: "cmd > /dev/null 2>&1",
    expected: "cmd > /dev/null 2>&1",
  },
  {
    name: "preserves -> arrow",
    input: "fn() -> int",
    expected: "fn() -> int",
  },
  {
    name: "preserves result > 0 comparison",
    input: "if result > 0 then stop",
    expected: "if result > 0 then stop",
  },

  // --- Identifier verbatim preservation (bold/italic NOT stripped) ---
  {
    name: "preserves **kwargs",
    input: "def f(**kwargs): pass",
    expected: "def f(**kwargs): pass",
  },
  {
    name: "preserves __init__",
    input: "class C: def __init__(self): pass",
    expected: "class C: def __init__(self): pass",
  },
  {
    name: "preserves 2**8 expression",
    input: "size = 2**8",
    expected: "size = 2**8",
  },
  {
    name: "preserves *.txt glob",
    input: "rm *.txt",
    expected: "rm *.txt",
  },
  {
    name: "preserves **/*.js glob",
    input: "test **/*.js files",
    expected: "test **/*.js files",
  },
  {
    name: "preserves {**a, **b} spread",
    input: "merged = {**a, **b}",
    expected: "merged = {**a, **b}",
  },
  {
    name: "preserves [array[0]] indexing",
    input: "value = [array[0]]",
    expected: "value = [array[0]]",
  },
  {
    name: "preserves URL with #fragment",
    input: "see https://example.com/#section",
    expected: "see https://example.com/#section",
  },
  {
    name: "preserves __init__.py path",
    input: "edit __init__.py",
    expected: "edit __init__.py",
  },
];

for (const fx of fixtures) {
  test(fx.name, () => {
    const got = sanitizePrompt(fx.input);
    assert.equal(got, fx.expected);
  });

  test(`${fx.name} — idempotent`, () => {
    const once = sanitizePrompt(fx.input);
    const twice = sanitizePrompt(once);
    assert.equal(twice, once);
  });
}

test("null/empty inputs pass through", () => {
  assert.equal(sanitizePrompt(""), "");
  assert.equal(sanitizePrompt(null), null);
  assert.equal(sanitizePrompt(undefined), undefined);
});
