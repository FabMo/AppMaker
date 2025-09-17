import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "../style.css"; // <-- your external CSS file

/* ---------------------- localStorage helpers ---------------------- */
const LS_CODE_KEY = "fabmo_sbp_code";
const LS_VALS_KEY = "fabmo_sbp_values";

const loadLS = (key, fallback) => {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
  catch { return fallback; }
};
const saveLS = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

/* ---------------------- Monaco: language + themes ---------------------- */
function handleBeforeMount(monaco) {
  const id = "opensbp";
  if (!monaco.languages.getEncodedLanguageId(id)) {
    monaco.languages.register({ id });
    monaco.languages.setMonarchTokensProvider(id, {
      tokenizer: {
        root: [
          [/[';].*$/, "comment"],
          [/&[A-Za-z][A-Za-z0-9_]*/, "variable"],
          [/\b-?(?:\d+\.\d+|\d+)\b/, "number"],
          [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
          [/\b(MS|MZ|JZ|J2|J3|PAUSE|FP|SA|SO|TR|HOME|C3|C2|C1)\b/i, "keyword"],
          [/,/, "delimiter"],
        ],
        string: [
          [/[^"]+/, "string"],
          [/""/, "string.escape"],
          [/"/, { token: "string.quote", bracket: "@close", next: "@root" }],
        ],
      },
    });
    monaco.editor.defineTheme("sbp-dark", {
      base: "vs-dark", inherit: true,
      rules: [
        { token: "comment", foreground: "6A9955" },
        { token: "variable", foreground: "4FC1FF" },
        { token: "number", foreground: "B5CEA8" },
        { token: "keyword", foreground: "C586C0", fontStyle: "bold" },
        { token: "string", foreground: "CE9178" },
      ],
      colors: {},
    });
    monaco.editor.defineTheme("sbp-light", {
      base: "vs", inherit: true,
      rules: [
        { token: "comment", foreground: "008000" },
        { token: "variable", foreground: "0000FF" },
        { token: "number", foreground: "098658" },
        { token: "keyword", foreground: "AF00DB", fontStyle: "bold" },
        { token: "string", foreground: "A31515" },
      ],
      colors: { "editor.background": "#FFFFFF" },
    });
  }
}

/* ---------------------- parsing + inference ---------------------- */
const VAR_REGEX = /&([A-Za-z][A-Za-z0-9_]*)/g;
// allow ' @input …  OR  ; @input … (back-compat)
const DIRECTIVE_REGEX = /^\s*[';]\s*@input\s+(&[A-Za-z][A-Za-z0-9_]*)\s+([^\r\n]*)/gmi;
// section headers: "# Title" with optional leading comment marker
const SECTION_HEADER = /^\s*(?:[';]\s*)?#\s*(.+?)\s*$/;
// Accept: ' @checkmark &VarName   OR   ; @checkmark VarName (also allows $VarName)
const CHECKMARK_REGEX = /^\s*[';]\s*@checkmark\s+(&?\$?[A-Za-z][A-Za-z0-9_]*)\s*$/gmi;

function parseCheckmarksIn(text) {
  const list = [];
  let m;
  while ((m = CHECKMARK_REGEX.exec(text))) {
    const raw = m[1].trim();
    const name = raw.replace(/^[$&]/, ""); // normalize: strip leading & or $
    list.push(name);
  }
  return list;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}
function toNumOrEmpty(v) {
  if (v === "" || v === undefined || v === null) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

function deriveTitleFromCode(code) {
  if (!code) return "";
  const first = (code.split(/\r?\n/).find(l => l.trim().length > 0) || "").trim();
  const m = first.match(/^[';]\s*(.*)$/);
  if (!m) return "";
  const body = m[1].trim();
  if (!body || /^@\w+/i.test(body)) return "";
  return body.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
}

function parseSections(code) {
  const lines = code.split(/\r?\n/);
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_HEADER);
    if (m) headers.push({ line: i, title: m[1].trim() });
  }
  if (headers.length === 0) {
    return [{ id: "sec0", title: "Main", start: 0, end: lines.length, text: code }];
  }
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].line + 1;
    const end = (i + 1 < headers.length) ? headers[i + 1].line : lines.length;
    out.push({ id: `sec${i}`, title: headers[i].title, start, end, text: lines.slice(start, end).join("\n") });
  }
  return out;
}

function parseDirectivesIn(text) {
  const map = {};
  let m;
  while ((m = DIRECTIVE_REGEX.exec(text))) {
    const varName = m[1].replace(/^&/, "");
    const attrs = m[2];
    const cfg = {};
    const attrRegex = /(\w+)=((\"[^\"]*\")|('[^']*')|[^\s]+)/g;
    let a;
    while ((a = attrRegex.exec(attrs))) {
      const key = a[1];
      let val = a[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      cfg[key] = val;
    }
    map[varName] = cfg;
  }
  return map;
}

async function getFabMoConfigVars() {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && window.fabmo?.getConfig) {
      window.fabmo.getConfig((err, data) => {
        if (err) {
          console.error("FabMo getConfig error:", err);
          resolve({});
        } else {
          resolve((data && data.opensbp && data.opensbp.variables) || {});
        }
      });
    } else {
      resolve({});
    }
  });
}

function extractVariables(code) {
  const set = new Set(); let m;
  while ((m = VAR_REGEX.exec(code))) set.add(m[1]);
  return Array.from(set);
}
function inferField(varName, cfg = {}) {
  let type = cfg.type || "text";
  if (!cfg.type) {
    const n = varName.toLowerCase();
    if (/(diameter|radius|depth|height|width|speed|feed|x|y|z|angle|thickness|step|offset|distance|length)/.test(n)) type = "number";
    else if (/^(use|enable|flag|do|is_)/.test(n)) type = "checkbox";
  }
  const label = cfg.label || varName;
  let def = cfg.default ?? "";
  if (type === "checkbox") def = toBool(def);
  else if (type === "number") def = toNumOrEmpty(def);
  const options = cfg.options ? String(cfg.options).split(/\s*,\s*/) : null;
  const min = cfg.min !== undefined ? Number(cfg.min) : undefined;
  const max = cfg.max !== undefined ? Number(cfg.max) : undefined;
  const step = cfg.step !== undefined ? Number(cfg.step) : undefined;
  return { type, label, default: def, options, min, max, step, placeholder: cfg.placeholder };
}

/* ---------------------- FabMo runner ---------------------- */
async function runSbpOnFabMo(fullSbpCode) {
  if (typeof window !== "undefined" && window.fabmo?.runSBP) {
    return new Promise((resolve, reject) => {
      window.fabmo.runSBP(fullSbpCode, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }
  const res = await fetch("/api/fabmo/run-sbp", { method: "POST", headers: { "Content-Type": "text/plain" }, body: fullSbpCode });
  if (!res.ok) throw new Error(`FabMo run failed: ${res.status}`);
  return await res.text();
}

/* ---------------------- Section Card (prevents stray `sec`) ---------------------- */
function SectionCard({ sec, values, setValues, running, runSection, buildPreambleForSection, isSectionComplete }) {
  return (
    <div className="legalpad">
      {/* Header with status icon */}
      <div className="legalpad-binding">
  <span
    className="status-icon"
    data-complete={isSectionComplete(sec) ? "1" : "0"}
    title={isSectionComplete(sec) ? "Complete" : "Not completed"}
  />
  <h3 className="legalpad-binding-title">
    {sec.title || "Untitled Section"}
  </h3>
</div>


      {/* Body */}
      <div className="legalpad-body">
        <form onSubmit={(e)=>e.preventDefault()}>
          {sec.fields.length === 0 && (
            <div className="legalpad-row">
              <span className="legalpad-label">Note</span>
              <div className="text-sm text-gray-700">No variables found in this section.</div>
            </div>
          )}
          {sec.fields.map((f) => (
            <div className="legalpad-row" key={f.name}>
              <label className="legalpad-label" htmlFor={`v-${sec.id}-${f.name}`}>{f.label}</label>
              <div className="legalpad-input">
                {f.options ? (
                  <select
                    id={`v-${sec.id}-${f.name}`}
                    value={String(values[`${sec.id}::${f.name}`] ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [`${sec.id}::${f.name}`]: e.target.value }))}
                  >
                    {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : f.type === "checkbox" ? (
                  <input
                    id={`v-${sec.id}-${f.name}`}
                    type="checkbox"
                    checked={Boolean(values[`${sec.id}::${f.name}`])}
                    onChange={(e) => setValues((v) => ({ ...v, [`${sec.id}::${f.name}`]: e.target.checked }))}
                  />
                ) : (
                  <input
                    id={`v-${sec.id}-${f.name}`}
                    type={f.type}
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    value={values[`${sec.id}::${f.name}`] ?? ""}
                    onChange={(e) => {
                      const val = f.type === "number"
                        ? (e.target.value === "" ? "" : Number(e.target.value))
                        : e.target.value;
                      setValues((v) => ({ ...v, [`${sec.id}::${f.name}`]: val }));
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </form>
      </div>

      {/* Actions */}
      <div className="legalpad-actions">
        <button
          disabled={running || (!sec.fields.length && sec.text.trim() === "")}
          onClick={() => runSection(sec)}
          className={`btn-primary ${running ? "opacity-60 cursor-not-allowed" : ""}`}
          title="Send this section to FabMo"
        >
          {running ? "Running..." : `Run: ${sec.title}`}
        </button>

        <details className="text-sm">
          <summary className="cursor-pointer">Show preamble for this section</summary>
          <pre className="bg-white/70 p-2 rounded border border-yellow-200 overflow-auto max-h-[24vh] text-xs whitespace-pre-wrap">
{buildPreambleForSection(sec).join("\n")}
          </pre>
        </details>
      </div>

      {/* Dog-ear + Reset */}
      <div className="legalpad-corner" />
      <button
        type="button"
        className="legalpad-reset"
        onClick={() => {
          setValues((prev) => {
            const next = { ...prev };
            sec.fields.forEach((f) => {
              next[`${sec.id}::${f.name}`] =
                f.type === "checkbox" ? (f.default ?? false) : (f.default ?? "");
            });
            return next;
          });
        }}
      >
        Reset
      </button>
    </div>
  );
}

/* ====================== Main Component ====================== */
export default function FabMoOpenSBPApp() {
  const [code, setCode] = useState(() => loadLS(LS_CODE_KEY, DEFAULT_SNIPPET));
  const derivedTitle = useMemo(() => deriveTitleFromCode(code), [code]);

  // Sections + models (directives, fields, checkmarks)
  const sections = useMemo(() => parseSections(code), [code]);
  const sectionModels = useMemo(() => {
    return sections.map(sec => {
      const directives = parseDirectivesIn(sec.text);
      const vars = extractVariables(sec.text);
      const fields = vars.map(v => ({ name: v, ...inferField(v, directives[v] || {}) }));
      const checkVars = parseCheckmarksIn(sec.text);
      return { ...sec, directives, fields, checkVars };
    });
  }, [sections]);

  // Values per section/var: key "secId::var"
  const keyFor = (secId, varName) => `${secId}::${varName}`;
  const [values, setValues] = useState(() => loadLS(LS_VALS_KEY, {}));

  useEffect(() => {
    setValues(prev => {
      const next = { ...prev };
      const valid = new Set();
      sectionModels.forEach(sec => {
        sec.fields.forEach(f => {
          const k = keyFor(sec.id, f.name);
          valid.add(k);
          if (!(k in next) || next[k] === "" || next[k] === null || next[k] === undefined) {
            next[k] = f.type === "checkbox" ? (f.default ?? false) : (f.default ?? "");
          }
        });
      });
      Object.keys(next).forEach(k => { if (!valid.has(k)) delete next[k]; });
      return next;
    });
  }, [sectionModels]);

  // Persist code & values
  useEffect(() => saveLS(LS_CODE_KEY, code), [code]);
  useEffect(() => saveLS(LS_VALS_KEY, values), [values]);

  // FabMo config variables for @checkmark
  const [configVars, setConfigVars] = useState({});
  useEffect(() => {
    (async () => {
      const vars = await getFabMoConfigVars();
      setConfigVars(vars);
    })();
  }, []);

  function isSectionComplete(sec) {
    if (!sec.checkVars || sec.checkVars.length === 0) return false;
    // True if ANY listed var exists and is non-zero (numeric). If not numeric, truthy counts.
    return sec.checkVars.some((name) => {
      const v = configVars?.[name];
      if (v === undefined || v === null) return false;
      const n = Number(v);
      if (Number.isFinite(n)) return n !== 0;
      return Boolean(v);
    });
  }

  // UI state
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");

  // Splitter / collapse
  const [leftPct, setLeftPct] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [collapsedLeft, setCollapsedLeft] = useState(false);
  const [collapsedRight, setCollapsedRight] = useState(false);
  const lastLeftPctRef = useRef(leftPct);
  useEffect(() => { if (collapsedLeft && collapsedRight) setCollapsedRight(false); }, [collapsedLeft, collapsedRight]);

  function startDrag(e) { e.preventDefault(); setDragging(true); }
  useEffect(() => {
    function onMove(e) {
      if (!dragging) return;
      const container = document.querySelector(".split-resizable");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX ?? (e.touches?.[0]?.clientX || 0);
      const pct = ((x - rect.left) / rect.width) * 100;
      const clamped = Math.min(90, Math.max(10, pct));
      lastLeftPctRef.current = clamped;
      setLeftPct(clamped);
      setCollapsedLeft(false); setCollapsedRight(false);
    }
    const onUp = () => setDragging(false);
    if (dragging) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };
  }, [dragging]);
  const collapseLeft = () => setCollapsedLeft(true);
  const expandLeft  = () => { setCollapsedLeft(false); if (collapsedRight) setCollapsedRight(false); setLeftPct(lastLeftPctRef.current || 50); };
  const collapseRight = () => setCollapsedRight(true);
  const expandRight  = () => { setCollapsedRight(false); if (collapsedLeft) setCollapsedLeft(false); setLeftPct(lastLeftPctRef.current || 50); };

  // Helpers
  const hasVal = (v) => v !== "" && v !== null && v !== undefined;

  function buildPreambleForSection(sec) {
    return sec.fields.map(f => {
      const val = values[keyFor(sec.id, f.name)];
      const cfg = sec.directives[f.name] || {};
      const promptMsg = (cfg.prompt || `Please input ${f.label || f.name}`).replace(/"/g, '""');
      if (!hasVal(val)) return `DIALOG "${promptMsg}", &${f.name}`;
      if (f.type === "number" && !isNaN(Number(val))) return `&${f.name} = ${val}`;
      if (f.type === "checkbox") return `&${f.name} = ${val ? 1 : 0}`;
      const s = String(val).replace(/"/g, '""');
      return `&${f.name} = "${s}"`;
    });
  }

  async function runSection(sec) {
    try {
      setRunning(true);
      setRunMsg("");
      const pre = buildPreambleForSection(sec).join("\n");
      const toRun = `${pre}\n\n${sec.text}`;
      const res = await runSbpOnFabMo(toRun);
      setRunMsg(typeof res === "string" ? res : `Submitted: ${sec.title}`);

      // refresh config so checkmarks update if your routine set variables
      try {
        const vars = await getFabMoConfigVars();
        setConfigVars(vars);
      } catch {}
    } catch (err) {
      setRunMsg(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  }

  // Tooltip: show all detected vars (across sections)
  const detectedVars = useMemo(() => {
    const s = new Set();
    sectionModels.forEach(sec => sec.fields.forEach(f => s.add(`&${f.name}`)));
    return Array.from(s).join(", ");
  }, [sectionModels]);

  useEffect(() => { document.title = derivedTitle ? `${derivedTitle} — FabMo` : "FabMo openSBP App"; }, [derivedTitle]);

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold" style={{ color: "black" }}
            title={`Detected variables: ${detectedVars || "(none)"}`}>
          {derivedTitle || "FabMo openSBP App"}
        </h1>
        <div className="flex items-center gap-2 text-sm">
          {/* header controls could go here */}
        </div>
      </header>

      {/* Split layout */}
      <section className="split-resizable">
        {/* LEFT (UI) */}
        <div className="pane" style={{ flex: collapsedLeft ? "0 0 0" : `0 0 ${leftPct}%` }}>
          <div className="pane-header">
            <button className="chev" onClick={collapseLeft} title="Hide UI">«</button>
          </div>

          <div className="space-y-6">
            {sectionModels.map((sec) => (
              <SectionCard
                key={sec.id}
                sec={sec}
                values={values}
                setValues={setValues}
                running={running}
                runSection={runSection}
                buildPreambleForSection={buildPreambleForSection}
                isSectionComplete={isSectionComplete}
              />
            ))}
          </div>
        </div>

        {/* Divider */}
        {!collapsedLeft && !collapsedRight && (
          <div className="divider" onMouseDown={startDrag} onTouchStart={startDrag} title="Drag to resize" />
        )}

        {/* RIGHT (Editor) */}
        <div className="pane" style={{ flex: collapsedRight ? "0 0 0" : `1 1 0` }}>
          <div className="pane-header">
            <h2 className="font-semibold">Editor</h2>
            <div className="flex items-center gap-2">
              <button
                className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200"
                onClick={() => setCode(DEFAULT_SNIPPET)}
                title="Replace with sample"
              >Load Sample</button>
              <button className="chev" onClick={collapseRight} title="Hide Editor">»</button>
            </div>
          </div>

          <Editor
            height="calc(100vh - 240px)"
            defaultLanguage="opensbp"
            theme="sbp-light"
            value={code}
            beforeMount={handleBeforeMount}
            onChange={(v) => setCode(v ?? "")}
            options={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 13, minimap: { enabled: false }, wordWrap: "on",
              scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderWhitespace: "boundary",
            }}
          />
        </div>

        {/* Edge tabs (to re-open panes) */}
        {collapsedLeft && (
          <button className="edge-tab" style={{ left: 6 }} onClick={expandLeft} title="Show UI">» UI</button>
        )}
        {collapsedRight && (
          <button className="edge-tab" style={{ right: 6 }} onClick={expandRight} title="Show Editor">Editor «</button>
        )}
      </section>

      {runMsg && <div className="text-sm text-gray-700">{runMsg}</div>}
    </div>
  );
}

/* ---------------------- Sample openSBP snippet ---------------------- */
const DEFAULT_SNIPPET = `' Shape Cutting App
' A toolkit of simple cutters

' #Circle Cutter
' @input &Radius    type=number min=0.1 max=48 step=0.01 label="Radius (in)" default=1.5
' @input &FeedRate  type=number default=120
' @checkmark $RanCircle
MS, &FeedRate
JZ, 0.25
' ... circle code using &Radius ...
' (your SBP could set $RanCircle = 1 when complete)
PAUSE "Circle complete"

' #Rectangle Cutter
' @input &Length type=number default=4
' @input &Width  type=number default=2
' @input &Depth  type=number default=0.125
' @checkmark $RanRectangle
MS, &FeedRate
JZ, 0.25
' ... rectangle code using &Length &Width &Depth ...
' (your SBP could set $RanRectangle = 1 when complete)
PAUSE "Rectangle complete"
`;
