import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { parse } = createRequire(import.meta.url)("../../public/richtext.js");

test("headings, bullets and paragraphs", () => {
  const b = parse("## Open Doors\nWe walk through doors.\nSecond line.\n\n- one\n- two\n\nEnd");
  assert.equal(b[0].type, "h");
  assert.equal(b[0].text, "Open Doors");
  assert.equal(b[1].type, "p");
  assert.equal(b[1].inline[0].v, "We walk through doors.\nSecond line.");
  assert.equal(b[2].type, "ul");
  assert.equal(b[2].items.length, 2);
  assert.equal(b[3].type, "p");
});

test("bold, italic and https links", () => {
  const [p] = parse("a **bold** and *soft* and [read](https://example.com/x)");
  assert.deepEqual(p.inline.map((x) => x.t), ["text", "b", "text", "i", "text", "a"]);
  assert.equal(p.inline[5].href, "https://example.com/x");
});

test("links that are not https stay as plain text", () => {
  for (const bad of ["[x](javascript:alert(1))", "[x](http://example.com)", "[x](data:text/html;base64,AAAA)", "[x](//evil.example)"]) {
    const [p] = parse(bad);
    assert.equal(p.inline.every((x) => x.t !== "a"), true, bad);
  }
});

test("markup typed as HTML is only ever kept as text", () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script> **<b>hi</b>**';
  const [p] = parse(evil);
  // the parser produces text and emphasis nodes only, so nothing here can become an element on the page
  assert.equal(p.inline.every((x) => ["text", "b", "i", "a"].includes(x.t)), true);
  assert.equal(p.inline.map((x) => x.v).join("").includes("<script>"), true);
});

test("empty and odd input is safe", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse(null), []);
  assert.equal(parse("**unclosed").length, 1);
  assert.equal(parse("\r\n\r\n").length, 0);
});
