// Notes for sermons are written with a few simple marks and shown safely.
//   ## Heading          a heading
//   - item              a bullet (one per line)
//   **bold**  *italic*  emphasis
//   [words](https://...)  a link (https only)
// Text is only ever put on the page as text, never as HTML, so nothing typed here can run as code.
(function () {
  var INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;

  function inline(text) {
    var out = [];
    var last = 0;
    var m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ t: "b", v: m[1] });
      else if (m[2] !== undefined) out.push({ t: "i", v: m[2] });
      else out.push({ t: "a", v: m[3], href: m[4] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: "text", v: text.slice(last) });
    return out;
  }

  function parse(source) {
    var blocks = [];
    var para = [];
    var list = null;
    function flushPara() {
      if (para.length) blocks.push({ type: "p", inline: inline(para.join("\n")) });
      para = [];
    }
    function flushList() {
      if (list) blocks.push({ type: "ul", items: list });
      list = null;
    }
    String(source || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .forEach(function (raw) {
        var line = raw.replace(/\s+$/, "");
        var h = /^#{1,3}\s+(.*)$/.exec(line);
        var li = /^[-*]\s+(.*)$/.exec(line);
        if (!line.trim()) {
          flushPara();
          flushList();
        } else if (h) {
          flushPara();
          flushList();
          blocks.push({ type: "h", text: h[1] });
        } else if (li) {
          flushPara();
          if (!list) list = [];
          list.push(inline(li[1]));
        } else {
          flushList();
          para.push(line);
        }
      });
    flushPara();
    flushList();
    return blocks;
  }

  function nodes(parts) {
    var frag = document.createDocumentFragment();
    parts.forEach(function (p) {
      if (p.t === "text") frag.append(document.createTextNode(p.v));
      else if (p.t === "b" || p.t === "i") {
        var e = document.createElement(p.t === "b" ? "strong" : "em");
        e.textContent = p.v;
        frag.append(e);
      } else {
        var a = document.createElement("a");
        a.textContent = p.v;
        a.href = p.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        frag.append(a);
      }
    });
    return frag;
  }

  function render(source) {
    var box = document.createElement("div");
    box.className = "rich";
    parse(source).forEach(function (b) {
      if (b.type === "h") {
        var h = document.createElement("h4");
        h.textContent = b.text;
        box.append(h);
      } else if (b.type === "ul") {
        var ul = document.createElement("ul");
        b.items.forEach(function (it) {
          var li = document.createElement("li");
          li.append(nodes(it));
          ul.append(li);
        });
        box.append(ul);
      } else {
        var p = document.createElement("p");
        p.append(nodes(b.inline));
        box.append(p);
      }
    });
    return box;
  }

  var api = { parse: parse, render: render };
  if (typeof window !== "undefined") window.CBC_RT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
