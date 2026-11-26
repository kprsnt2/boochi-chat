// Local fake OpenAI-compatible provider for trying the app without real keys.
//   node scripts/mock-provider.mjs          (listens on http://127.0.0.1:9799/v1)
// Point tiers at it, e.g. GROQ_BASE_URL=http://127.0.0.1:9799/v1 and
// OPENAI_BASE_URL=http://127.0.0.1:9799/v1. Replies say which key was used,
// and the first part of long answers stops with finish_reason "length" so the
// automatic continuation can be seen working.
import { createServer } from "node:http";

const WORKSHEET = `# Multiplication Practice
*Grade 4 · 8 questions · about 20 minutes*

## Section A: Fill in the blanks (4 marks)
1. 6 × 7 = ________
2. 9 × ________ = 54
3. ________ × 8 = 64
4. 12 × 3 = ________

## Section B: Multiple choice (2 marks)
5. Which is equal to 5 × 9?
   a) 40
   b) 45
   c) 54
   d) 59
6. 7 × 7 = ?
   a) 14
   b) 42
   c) 49
   d) 77

## Section C: Word problems (4 marks)
7. A box holds 6 pencils. How many pencils are in 8 boxes? Show your working.
8. Explain why 4 × 25 is the same as 100.

## Answer Key
1. 42
2. 6
3. 8
4. 36
5. b) 45
6. c) 49
7. 6 × 8 = 48 pencils
8. 4 groups of 25 make 100 (25 + 25 + 25 + 25 = 100).`;

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-free" }, { id: "mock-paid" }] }));
    return;
  }
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  const key = (req.headers.authorization ?? "").replace("Bearer ", "");
  const kind = key.includes("PAID") ? "PAID key" : "FREE key";
  const msgs = body.messages ?? [];
  const system = msgs[0]?.content ?? "";
  const asText = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "[image]").join(" "));
  const isContinue = /was cut off/.test(asText(msgs.at(-1)));
  const users = msgs.filter((m) => m.role === "user" && !/was cut off/.test(asText(m)));
  const lastText = asText(users.at(-1));

  let full;
  if (system.startsWith("You are Worksheet")) full = WORKSHEET;
  else full = `**Mock ${body.model}** answered using the **${kind}**.\n\nYou said: “${lastText.slice(0, 300)}”\n\n| check | value |\n|---|---|\n| messages in context | ${msgs.length - 1} |\n| max_tokens sent | ${"max_tokens" in body || "max_completion_tokens" in body ? "yes ❌" : "none ✅"} |\n\n\`\`\`js\nconsole.log("copy me");\n\`\`\``;

  // First request: stop half-way with "length"; continuation sends the rest.
  const cut = Math.floor(full.length * 0.55);
  const text = isContinue ? full.slice(cut) : full.slice(0, cut);
  const finish = isContinue ? "stop" : "length";

  res.writeHead(200, { "content-type": "text/event-stream" });
  for (let i = 0; i < text.length; i += 12) {
    sse(res, { choices: [{ delta: { content: text.slice(i, i + 12) } }] });
    await sleep(8);
  }
  sse(res, { choices: [{ delta: {}, finish_reason: finish }] });
  res.end("data: [DONE]\n\n");
}).listen(9799, "127.0.0.1");
