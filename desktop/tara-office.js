"use strict";
/* TARA office helpers: real Word (.docx), Excel (.xlsx) and PDF-ready HTML, plus safe editing and mail composing.
   Pure functions (no Electron) so they can be tested anywhere. Needs: adm-zip, xlsx (already in package.json), nodemailer (for mail). */
const path = require("path");

const esc = s => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const unesc = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/* ---------- inline text -> runs (supports **bold**) ---------- */
function runs(text, o = {}) {
  const parts = String(text == null ? "" : text).split(/(\*\*[^*]+\*\*)/g).filter(x => x !== "");
  if (!parts.length) return "";
  return parts.map(p => {
    const b = /^\*\*[^*]+\*\*$/.test(p), t = b ? p.slice(2, -2) : p;
    const rpr = (o.bold || b ? "<w:b/>" : "") + (o.italic ? "<w:i/>" : "") + (o.size ? '<w:sz w:val="' + o.size + '"/><w:szCs w:val="' + o.size + '"/>' : "");
    const segs = t.split("\n");
    return "<w:r>" + (rpr ? "<w:rPr>" + rpr + "</w:rPr>" : "") +
      segs.map((s, i) => (i ? "<w:br/>" : "") + '<w:t xml:space="preserve">' + esc(s) + "</w:t>").join("") + "</w:r>";
  }).join("");
}
const JC = { left: "left", center: "center", right: "right", justify: "both" };
function para(text, o = {}) {
  let ppr = "";
  if (o.style) ppr += '<w:pStyle w:val="' + o.style + '"/>';
  if (o.numId) ppr += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + o.numId + '"/></w:numPr>';
  if (o.ind) ppr += '<w:ind w:left="' + o.ind + '" w:hanging="' + (o.hang || 0) + '"/>';
  if (o.align && JC[o.align]) ppr += '<w:jc w:val="' + JC[o.align] + '"/>';
  return "<w:p>" + (ppr ? "<w:pPr>" + ppr + "</w:pPr>" : "") + runs(text, o) + "</w:p>";
}
function tableXml(rows, o = {}) {
  rows = (rows || []).map(r => Array.isArray(r) ? r : [r]);
  const n = Math.max(1, ...rows.map(r => r.length));
  const total = 9638, w = Math.floor(total / n);
  const hdr = o.header !== false && rows.length > 1;
  let x = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="' + total + '" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' +
    Array.from({ length: n }, () => '<w:gridCol w:w="' + w + '"/>').join("") + "</w:tblGrid>";
  rows.forEach((r, ri) => {
    x += "<w:tr>" + (hdr && ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "");
    for (let c = 0; c < n; c++) {
      const v = r[c] == null ? "" : r[c];
      const head = hdr && ri === 0;
      x += '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : "") + "</w:tcPr>" +
        para(String(v), { bold: head, size: o.cellSize }) + "</w:tc>";
    }
    x += "</w:tr>";
  });
  return x + "</w:tbl>" + "<w:p/>";
}
const HEAD_SZ = { 1: 32, 2: 28, 3: 24 };
/* blocks -> body xml. opts.plain = no numbering/styles dependencies (used when editing someone else's file) */
function blocksXml(blocks, ctx) {
  const plain = !!ctx.plain;
  let out = "";
  for (const b of blocks || []) {
    if (!b || typeof b !== "object") continue;
    const t = b.type;
    if (t === "heading") {
      const lv = Math.min(3, Math.max(1, +b.level || 1));
      out += plain ? para(b.text, { bold: true, size: HEAD_SZ[lv], align: b.align }) : para(b.text, { style: "Heading" + lv, align: b.align });
    } else if (t === "para" || t === "paragraph" || t === "text") {
      out += para(b.text, { bold: b.bold, italic: b.italic, align: b.align });
    } else if (t === "bullets" || t === "numbered") {
      const items = Array.isArray(b.items) ? b.items : [];
      if (plain) items.forEach((it, i) => { out += para((t === "bullets" ? "• " : (i + 1) + ". ") + it, { ind: 720, hang: 360 }); });
      else {
        let id = 1;
        if (t === "numbered") { id = 2 + ctx.nums.length; ctx.nums.push(id); }
        items.forEach(it => { out += para(it, { numId: id }); });
      }
    } else if (t === "table") {
      out += tableXml(b.rows, b);
    } else if (t === "pagebreak") {
      out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
  }
  return out;
}

/* ---------- build a new .docx ---------- */
function buildDocx(spec) {
  const AdmZip = require("adm-zip");
  spec = spec || {};
  const font = esc(spec.font || "Arial"), size = Math.round((+spec.size || 11) * 2);
  const ctx = { nums: [] };
  let body = "";
  if (spec.title) body += para(spec.title, { style: "Title", align: spec.titleAlign || "center" });
  body += blocksXml(spec.blocks, ctx);
  if (!body) body = "<w:p/>";
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + "><w:body>" + body + sect + "</w:body></w:document>";
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + NS + ">" +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:eastAsia="' + font + '" w:cs="Nirmala UI"/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/><w:lang w:val="en-IN" w:eastAsia="en-IN" w:bidi="te-IN"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
    [1, 2, 3].map(l => '<w:style w:type="paragraph" w:styleId="Heading' + l + '"><w:name w:val="heading ' + l + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="' + (l - 1) + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + HEAD_SZ[l] + '"/><w:szCs w:val="' + HEAD_SZ[l] + '"/></w:rPr></w:style>').join("") +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/></w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    "</w:styles>";
  const lvl = (fmt, txt) => '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="' + txt + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' + (fmt === "bullet" ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : "") + "</w:lvl>";
  const numbering = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ' + NS + ">" +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' + lvl("bullet", "") + "</w:abstractNum>" +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>' + lvl("decimal", "%1.") + "</w:abstractNum>" +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    ctx.nums.map(id => '<w:num w:numId="' + id + '"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>').join("") + "</w:numbering>";
  const zip = new AdmZip();
  const add = (n, s) => zip.addFile(n, Buffer.from(s, "utf8"));
  add("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  add("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  add("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  add("word/document.xml", doc); add("word/styles.xml", styles); add("word/numbering.xml", numbering);
  return zip.toBuffer();
}

/* ---------- edit an existing .docx: replace text, optionally append blocks. Never touches the original file. ---------- */
function editDocx(buf, edits) {
  const AdmZip = require("adm-zip");
  edits = edits || {};
  const reps = (Array.isArray(edits.replacements) ? edits.replacements : []).filter(r => r && typeof r.find === "string" && r.find !== "");
  const zip = new AdmZip(buf);
  let changes = 0;
  const T = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  for (const e of zip.getEntries()) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(e.entryName) || !reps.length) continue;
    let xml = e.getData().toString("utf8");
    xml = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, p => {
      const ts = [...p.matchAll(T)];
      if (!ts.length) return p;
      let text = ts.map(m => unesc(m[1])).join(""), changed = false;
      for (const r of reps) {
        const find = String(r.find), rep = String(r.replace == null ? "" : r.replace);
        if (r.ignoreCase) {
          const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          if (re.test(text)) { text = text.replace(re, () => rep); changed = true; changes++; }
        } else if (text.includes(find)) { const n = text.split(find).length - 1; text = text.split(find).join(rep); changed = true; changes += n; }
      }
      if (!changed) return p;
      let i = 0;
      return p.replace(T, () => (i++ === 0 ? '<w:t xml:space="preserve">' + esc(text) + "</w:t>" : "<w:t></w:t>"));
    });
    zip.updateFile(e.entryName, Buffer.from(xml, "utf8"));
  }
  if (Array.isArray(edits.appendBlocks) && edits.appendBlocks.length) {
    const entry = zip.getEntry("word/document.xml");
    if (!entry) throw new Error("This does not look like a Word document.");
    let xml = entry.getData().toString("utf8");
    const add = blocksXml(edits.appendBlocks, { plain: true });
    const m = /<w:sectPr(?:(?!<\/w:sectPr>)[\s\S])*<\/w:sectPr>\s*<\/w:body>/.exec(xml);
    xml = m ? xml.slice(0, m.index) + add + xml.slice(m.index) : xml.replace("</w:body>", add + "</w:body>");
    zip.updateFile("word/document.xml", Buffer.from(xml, "utf8"));
    changes += edits.appendBlocks.length;
  }
  return { buffer: zip.toBuffer(), changes };
}

/* ---------- Excel ---------- */
const sheetName = (n, i) => (String(n || "Sheet" + (i + 1)).replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || "Sheet" + (i + 1));
function cellVal(v) {
  if (typeof v === "string" && /^=.+/.test(v)) return { t: "n", f: v.slice(1) };
  if (typeof v === "string" && /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(v.trim())) return Number(v.trim()); // plain numbers; codes like 0123 or long ids stay text
  if (v == null) return null;
  return v;
}
function buildXlsx(spec) {
  const XLSX = require("xlsx");
  spec = spec || {};
  const wb = XLSX.utils.book_new();
  const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: "Sheet1", rows: spec.rows || [] }];
  const used = new Set();
  sheets.forEach((s, i) => {
    const rows = (s.rows || []).map(r => (Array.isArray(r) ? r : [r]).map(cellVal));
    const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && typeof c === "object" ? null : c))));
    rows.forEach((r, ri) => r.forEach((c, ci) => { if (c && typeof c === "object") ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = c; }));
    const nc = Math.max(0, ...rows.map(r => r.length));
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: Math.max(0, nc - 1) } });
    ws["!cols"] = Array.from({ length: nc }, (_, c) => ({ wch: Math.min(60, Math.max(8, ...rows.map(r => { const v = r[c]; return String(v && typeof v === "object" ? "=" + v.f : v == null ? "" : v).length + 2; }))) }));
    let nm = sheetName(s.name, i), k = 2; while (used.has(nm.toLowerCase())) nm = sheetName(s.name, i).slice(0, 28) + " " + k++;
    used.add(nm.toLowerCase());
    XLSX.utils.book_append_sheet(wb, ws, nm);
  });
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
function editXlsx(buf, edits) {
  const XLSX = require("xlsx");
  edits = edits || {};
  const wb = XLSX.read(buf, { type: "buffer", cellStyles: true, cellFormula: true, cellDates: true });
  const name = edits.sheet && wb.SheetNames.includes(edits.sheet) ? edits.sheet : wb.SheetNames[0];
  if (edits.sheet && !wb.SheetNames.includes(edits.sheet)) throw new Error('Sheet "' + edits.sheet + '" not found. Sheets: ' + wb.SheetNames.join(", "));
  const ws = wb.Sheets[name];
  let changes = 0;
  for (const c of Array.isArray(edits.cells) ? edits.cells : []) {
    if (!c || !/^[A-Za-z]{1,3}[0-9]{1,6}$/.test(String(c.ref || ""))) continue;
    const ref = String(c.ref).toUpperCase(), v = c.value;
    if (typeof v === "string" && /^=.+/.test(v)) ws[ref] = { t: "n", f: v.slice(1) };
    else if (typeof v === "number") ws[ref] = { t: "n", v };
    else if (typeof v === "boolean") ws[ref] = { t: "b", v };
    else if (v == null || v === "") delete ws[ref];
    else ws[ref] = { t: "s", v: String(v) };
    const a = XLSX.utils.decode_cell(ref), r = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
    r.e.r = Math.max(r.e.r, a.r); r.e.c = Math.max(r.e.c, a.c); ws["!ref"] = XLSX.utils.encode_range(r); changes++;
  }
  if (Array.isArray(edits.appendRows) && edits.appendRows.length) {
    const r = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
    let row = (ws["!ref"] && Object.keys(ws).some(k => k[0] !== "!")) ? r.e.r + 1 : 0;
    for (const arr of edits.appendRows) {
      (Array.isArray(arr) ? arr : [arr]).forEach((v, ci) => {
        const cv = cellVal(v); if (cv == null) return;
        ws[XLSX.utils.encode_cell({ r: row, c: ci })] = typeof cv === "object" ? cv : (typeof cv === "number" ? { t: "n", v: cv } : { t: "s", v: String(cv) });
        r.e.c = Math.max(r.e.c, ci);
      });
      r.e.r = Math.max(r.e.r, row); row++; changes++;
    }
    ws["!ref"] = XLSX.utils.encode_range({ s: r.s, e: r.e });
  }
  return { buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }), changes, sheet: name };
}

/* ---------- HTML (used for PDF via Electron's printToPDF) ---------- */
function buildHtml(spec) {
  spec = spec || {};
  const font = esc(spec.font || "Arial"), size = +spec.size || 11;
  const inl = t => esc(t).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  let b = "";
  if (spec.title) b += '<h1 class="title">' + inl(spec.title) + "</h1>";
  for (const k of spec.blocks || []) {
    if (!k || typeof k !== "object") continue;
    const al = k.align && JC[k.align] ? ' style="text-align:' + (k.align === "justify" ? "justify" : k.align) + '"' : "";
    if (k.type === "heading") { const l = Math.min(3, Math.max(1, +k.level || 1)); b += "<h" + (l + 1) + al + ">" + inl(k.text) + "</h" + (l + 1) + ">"; }
    else if (k.type === "para" || k.type === "paragraph" || k.type === "text") b += "<p" + al + ">" + (k.bold ? "<b>" : "") + inl(k.text) + (k.bold ? "</b>" : "") + "</p>";
    else if (k.type === "bullets" || k.type === "numbered") { const tg = k.type === "bullets" ? "ul" : "ol"; b += "<" + tg + ">" + (k.items || []).map(i => "<li>" + inl(i) + "</li>").join("") + "</" + tg + ">"; }
    else if (k.type === "table") {
      const rows = (k.rows || []).map(r => Array.isArray(r) ? r : [r]), hdr = k.header !== false && rows.length > 1;
      b += "<table>" + rows.map((r, i) => "<tr>" + r.map(c => (hdr && i === 0 ? "<th>" : "<td>") + inl(c) + (hdr && i === 0 ? "</th>" : "</td>")).join("") + "</tr>").join("") + "</table>";
    } else if (k.type === "pagebreak") b += '<div style="page-break-after:always"></div>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font-family:"' + font + '","Nirmala UI",sans-serif;font-size:' + size + 'pt;line-height:1.45;color:#000}' +
    "h1.title{text-align:center;font-size:" + (size + 7) + "pt}h2{font-size:" + (size + 5) + "pt;margin:16px 0 6px}h3{font-size:" + (size + 3) + "pt;margin:14px 0 6px}h4{font-size:" + (size + 1) + "pt;margin:12px 0 4px}" +
    "table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #777;padding:4px 6px;vertical-align:top;font-size:" + (size - 1) + "pt}th{background:#d9e2f3}</style></head><body>" + b + "</body></html>";
}

/* ---------- file names ---------- */
function safeName(name, ext) {
  let n = String(name || "TARA-document").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "");
  n = n.replace(new RegExp("\\.(docx?|xlsx?|pdf|csv|txt)$", "i"), "");
  return (n || "TARA-document").slice(0, 120) + ext;
}
function uniquePath(fs, dir, file) {
  let p = path.join(dir, file);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(file), base = file.slice(0, -ext.length);
  for (let i = 2; i < 500; i++) { p = path.join(dir, base + " (" + i + ")" + ext); if (!fs.existsSync(p)) return p; }
  return path.join(dir, base + "-" + Date.now() + ext);
}

/* ---------- e-mail composing (sending happens in main.js, only after the user approves) ---------- */
const MAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
function parseAddrs(v) {
  const list = (Array.isArray(v) ? v : String(v || "").split(/[,;]+/)).map(x => String(x).trim()).filter(Boolean);
  const out = [];
  for (const x of list) {
    const m = x.match(/<([^<>]+)>\s*$/); const a = (m ? m[1] : x).trim();
    if (!MAIL_RE.test(a)) throw new Error('"' + x + '" is not a valid e-mail address.');
    out.push(a);
  }
  return out;
}
function composeMail(a, fromAddr) {
  const to = parseAddrs(a.to), cc = parseAddrs(a.cc);
  if (!to.length) throw new Error("Add at least one recipient (to).");
  if (to.length + cc.length > 10) throw new Error("TARA sends to at most 10 people per e-mail.");
  const subject = String(a.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  const text = String(a.body || a.text || "").replace(/\r\n/g, "\n");
  if (!subject) throw new Error("The e-mail needs a subject.");
  if (!text.trim()) throw new Error("The e-mail body is empty.");
  if (text.length > 60000) throw new Error("The e-mail body is too long.");
  const mail = { from: fromAddr, to: to.join(", "), subject, text };
  if (cc.length) mail.cc = cc.join(", ");
  return mail;
}

module.exports = { buildDocx, editDocx, buildXlsx, editXlsx, buildHtml, safeName, uniquePath, composeMail, parseAddrs };
