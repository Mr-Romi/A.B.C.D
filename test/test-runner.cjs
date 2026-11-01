/**
 * Zero-dependency unit test suite for A.B.C.D
 * Run with: node test/test-runner.cjs
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load shared.js directly into context without needing module.exports
const sharedCode = fs.readFileSync(path.join(__dirname, "../shared.js"), "utf8");
// Expose top-level declarations (including const) to this context
vm.runInThisContext(sharedCode);

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("\n=========================================");
console.log("Running A.B.C.D Test Suite");
console.log("=========================================\n");

// -----------------------------------------------------------------------------
// 1. mergeMessages Tests
// -----------------------------------------------------------------------------
console.log("Testing mergeMessages (scroll handling & streaming):");

test("Preserves existing when user scrolls UP (fresh is a subset of earlier messages)", () => {
  const existing = [
    { role: "user", text: "msg 1" },
    { role: "assistant", text: "reply 1" },
    { role: "user", text: "msg 2" },
    { role: "assistant", text: "reply 2" },
    { role: "user", text: "msg 3" },
    { role: "assistant", text: "reply 3" },
  ];
  // Fresh only sees messages 1 and 2 because DOM is virtualized at the top
  const fresh = [
    { role: "user", text: "msg 1" },
    { role: "assistant", text: "reply 1" },
  ];

  const merged = mergeMessages(existing, fresh);
  assert.strictEqual(merged.length, 6, "Length should remain 6");
  assert.strictEqual(merged[5].text, "reply 3", "Tail message must remain reply 3 without duplicate msg 1 appended");
});

test("Appends genuinely new messages when fresh extends existing", () => {
  const existing = [
    { role: "user", text: "msg 1" },
    { role: "assistant", text: "reply 1" },
  ];
  const fresh = [
    { role: "assistant", text: "reply 1" },
    { role: "user", text: "msg 2" },
    { role: "assistant", text: "reply 2" },
  ];

  const merged = mergeMessages(existing, fresh);
  assert.strictEqual(merged.length, 4, "Should cleanly merge to 4 messages");
  assert.deepStrictEqual(
    merged.map(m => m.text),
    ["msg 1", "reply 1", "msg 2", "reply 2"]
  );
});

test("Updates in-progress streaming message smoothly", () => {
  const existing = [
    { role: "user", text: "hello" },
    { role: "assistant", text: "Thinking about" },
  ];
  const fresh = [
    { role: "user", text: "hello" },
    { role: "assistant", text: "Thinking about the universe and everything." },
  ];

  const merged = mergeMessages(existing, fresh);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].text, "Thinking about the universe and everything.");
});

test("Handles repeated short messages without corrupting history", () => {
  const existing = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello again" },
  ];
  const fresh = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello again" },
    { role: "user", text: "how are you?" },
  ];

  const merged = mergeMessages(existing, fresh);
  assert.strictEqual(merged.length, 5);
  assert.strictEqual(merged[4].text, "how are you?");
});

test("Prepends older messages when user scrolls UP and loads earlier conversation history", () => {
  const existing = [
    { role: "user", text: "msg 3" },
    { role: "assistant", text: "reply 3" },
    { role: "user", text: "msg 4" },
  ];
  const fresh = [
    { role: "user", text: "msg 1" },
    { role: "assistant", text: "reply 1" },
    { role: "user", text: "msg 2" },
    { role: "assistant", text: "reply 2" },
    { role: "user", text: "msg 3" },
    { role: "assistant", text: "reply 3" },
  ];

  const merged = mergeMessages(existing, fresh);
  assert.strictEqual(merged.length, 7, "Should include msg 1 through msg 4");
  assert.strictEqual(merged[0].text, "msg 1");
  assert.strictEqual(merged[6].text, "msg 4");
});

// -----------------------------------------------------------------------------
// 2. cleanMessageText Tests
// -----------------------------------------------------------------------------
console.log("\nTesting cleanMessageText (PUA icons, UI noise, code blocks):");

test("Strips Private Use Area (PUA) icon font glyphs", () => {
  const dirty = "\uE001 Here is some text with icon \uE240 and button \uF120.";
  const cleaned = cleanMessageText("assistant", dirty);
  assert.strictEqual(cleaned, "Here is some text with icon  and button .");
});

test("Strips Gemini 'You said' screen reader headers from user queries", () => {
  const dirty = "##### You said what is gravity?\n\nwhat is gravity?";
  const cleaned = cleanMessageText("user", dirty);
  assert.strictEqual(cleaned, "what is gravity?");
});

test("Strips assistant prefixes like 'Claude responded:' or 'ChatGPT said:'", () => {
  const dirty = "Claude responded:\n\nHere is the solution to your issue.";
  const cleaned = cleanMessageText("assistant", dirty);
  assert.strictEqual(cleaned, "Here is the solution to your issue.");
});

test("Removes UI action noise lines (Copy, Retry, timestamps)", () => {
  const dirty = "Here is the code.\n\nCopy\nRetry\njust now";
  const cleaned = cleanMessageText("assistant", dirty);
  assert.strictEqual(cleaned, "Here is the code.");
});

test("Folds standalone language tags into following code fences", () => {
  const dirty = "Here is the code:\n\nJavaScript\n\n```\nconst x = 10;\n```";
  const cleaned = cleanMessageText("assistant", dirty);
  assert.ok(cleaned.includes("```javascript\nconst x = 10;\n```"));
});

// -----------------------------------------------------------------------------
// 3. removeSummaryExchange Tests
// -----------------------------------------------------------------------------
console.log("\nTesting removeSummaryExchange:");

test("Filters out summary request and corresponding AI summary from transcript", () => {
  const messages = [
    { role: "user", text: "Let's build a parser." },
    { role: "assistant", text: "Sure, let's start." },
    { role: "user", text: `${SUMMARY_MARKER}\nPlease write a handoff summary...` },
    { role: "assistant", text: "# Context: Parser\n**Goal:** Build a parser.\n**Current state:** Started." },
    { role: "user", text: "Now add tests." },
    { role: "assistant", text: "Adding tests now." },
  ];

  const cleaned = removeSummaryExchange(messages);
  assert.strictEqual(cleaned.length, 4);
  assert.strictEqual(cleaned[0].text, "Let's build a parser.");
  assert.strictEqual(cleaned[1].text, "Sure, let's start.");
  assert.strictEqual(cleaned[2].text, "Now add tests.");
  assert.strictEqual(cleaned[3].text, "Adding tests now.");
});

// -----------------------------------------------------------------------------
// 4. stripObsidianLinks & chatKey Tests
// -----------------------------------------------------------------------------
console.log("\nTesting stripObsidianLinks & chatKey:");

test("Strips Obsidian bracket links [[Topic]] and [[Topic|Alias]]", () => {
  const text = "See [[Data Structures]] and [[Algorithms|algos]] for details.";
  const stripped = stripObsidianLinks(text);
  assert.strictEqual(stripped, "See Data Structures and algos for details.");
});

test("Generates sanitized and consistent chat keys", () => {
  assert.strictEqual(chatKey("chatgpt", "/c/123-abc/"), "chat:chatgpt:/c/123-abc");
  assert.strictEqual(chatKey("claude", ""), "chat:claude:/");
  assert.strictEqual(chatKey("deepseek", "/chat/s/xyz"), "chat:deepseek:/chat/s/xyz");
});

// -----------------------------------------------------------------------------
// 5. buildHandoffPrompt & buildObsidianNote Tests
// -----------------------------------------------------------------------------
console.log("\nTesting buildHandoffPrompt & buildObsidianNote:");

test("buildHandoffPrompt includes stripped summary and recent tail messages", () => {
  const chat = {
    site: "ChatGPT",
    summary: "# Context: [[Architecture]]\n**Goal:** Refactor API.\n**Current state:** WIP.",
    messages: [
      { role: "user", text: "Old step 1" },
      { role: "assistant", text: "Old step 2" },
      { role: "user", text: "Latest question" },
      { role: "assistant", text: "Latest answer" },
    ]
  };

  const prompt = buildHandoffPrompt(chat);
  assert.ok(prompt.includes("## Summary of the conversation so far"));
  assert.ok(prompt.includes("Context: Architecture"), "Obsidian bracket link must be stripped");
  assert.ok(prompt.includes("## Most recent messages (word for word)"));
  assert.ok(prompt.includes("**Assistant:** Latest answer"));
});

test("buildObsidianNote includes frontmatter, title, summary, and transcript", () => {
  const chat = {
    site: "Claude",
    title: "Refactoring Database Layer",
    url: "https://claude.ai/chat/123",
    summary: "# Context: DB\n**Goal:** Optimize queries.",
    messages: [
      { role: "user", text: "How do we index?" },
      { role: "assistant", text: "Use B-tree indexing." },
    ]
  };

  const note = buildObsidianNote(chat);
  assert.ok(note.startsWith("---\nsource:"));
  assert.ok(note.includes('source: "Claude"'));
  assert.ok(note.includes("tags: [ai-handoff]"));
  assert.ok(note.includes("# Refactoring Database Layer"));
  assert.ok(note.includes("## Summary"));
  assert.ok(note.includes("## Full transcript"));
  assert.ok(note.includes("**User:** How do we index?"));
  assert.ok(note.includes("**Assistant:** Use B-tree indexing."));
});

console.log("\n=========================================");
console.log(`Results: ${passedTests} / ${totalTests} passed`);
console.log("=========================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
