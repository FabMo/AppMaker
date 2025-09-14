import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor from '@monaco-editor/react'


/**
 * FabMo openSBP App — Editor + GUI (single-file React component)
 * ------------------------------------------------------------------
 * What it does
 * - Left/Right flip between an openSBP code editor and an auto-generated GUI.
 * - Parses variables like &BitDiameter from your code, plus optional @input directives
 *   in comments to customize labels, types, defaults, validation, etc.
 * - One-click Run: prefixes the code with variable assignments and sends to FabMo.
 * - Saves/restores your latest code + form values from localStorage.
 *
 * Notes
 * - Replace the runSbp() function to call your actual FabMo runtime (SDK or REST).
 * - This file uses Tailwind classes (no extra imports needed in Canvas). If you're
 *   dropping this into your own app, ensure Tailwind is available or swap to CSS.
 * - No external editor libs are used; the <textarea> is simple but reliable. You can
 *   easily swap it for Monaco or CodeMirror later.
 */

// ---------------------- Utility: localStorage helpers ----------------------
const LS_CODE_KEY = "fabmo_sbp_code";
const LS_VALS_KEY = "fabmo_sbp_values";

const loadLS = (key, fallback) => {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const saveLS = (key, val) => {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
};

// Register a simple openSBP language before the editor mounts
function handleBeforeMount(monaco) {
  // language id
  const id = 'opensbp'
  if (!monaco.languages.getEncodedLanguageId(id)) {
    monaco.languages.register({ id })

    monaco.languages.setMonarchTokensProvider(id, {
      // SBP: ; comments
      tokenizer: {
        root: [
          [/;.*$/, 'comment'],
          // &VarName
          [/&[A-Za-z][A-Za-z0-9_]*/, 'variable'],
          // numbers (ints, floats)
          [/\b-?(?:\d+\.\d+|\d+)\b/, 'number'],
          // strings
          [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
          // common commands (tune these as you like)
          [/\b(MS|MZ|JZ|J2|J3|PAUSE|FP|SA|SO|TR|HOME|C3|C2|C1)\b/i, 'keyword'],
          // commas
          [/,/, 'delimiter'],
        ],
        string: [
          [/[^"]+/, 'string'],
          [/""/, 'string.escape'],
          [/"/, { token: 'string.quote', bracket: '@close', next: '@root' }]
        ]
      }
    })

    monaco.editor.defineTheme('sbp-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6A9955' },
        { token: 'variable', foreground: '4FC1FF' },
        { token: 'number', foreground: 'B5CEA8' },
        { token: 'keyword', foreground: 'C586C0', fontStyle: 'bold' },
        { token: 'string', foreground: 'CE9178' },
      ],
      colors: {}
    })
  }
}

function handleEditorChange(value /* string | undefined */) {
  setCode(value ?? '')
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function toNumOrEmpty(v) {
  if (v === '' || v === undefined || v === null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}


// ---------------------- Parser: variables and directives ----------------------
// Match &VarName where VarName starts with a letter and continues with letters/digits/_
const VAR_REGEX = /&([A-Za-z][A-Za-z0-9_]*)/g;

// Matches lines like:
// ' @input &BitDiameter type=number ...
// ; @input &BitDiameter type=number ...   (back-compat)
const DIRECTIVE_REGEX =
  /^\s*[';]\s*@input\s+(&[A-Za-z][A-Za-z0-9_]*)\s+([^\r\n]*)/gmi;


function parseDirectives(code) {
  const map = {}; // varName -> config
  let m;
  while ((m = DIRECTIVE_REGEX.exec(code))) {
    const rawVar = m[1];
    const varName = rawVar.replace(/^&/, "");
    const attrs = m[2];
    const cfg = {};
    // parse key=value pairs (value may be quoted)
    const attrRegex = /(\w+)=(("[^"]*")|('[^']*')|[^\s]+)/g;
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

function extractVariables(code) {
  const set = new Set();
  let m;
  while ((m = VAR_REGEX.exec(code))) {
    set.add(m[1]);
  }
  return Array.from(set);
}

// ---------------------- Default field inference ----------------------
function inferField(varName, cfg = {}) {
  let type = cfg.type || 'text';
  if (!cfg.type) {
    const n = varName.toLowerCase();
    if (/(diameter|radius|depth|height|width|speed|feed|x|y|z|angle|thickness|step|offset|distance|length)/.test(n)) {
      type = 'number';
    } else if (/^(use|enable|flag|do|is_)/.test(n)) {
      type = 'checkbox';
    }
  }

  const label = cfg.label || varName;

  // defaults
  let def = cfg.default ?? '';
  if (type === 'checkbox') def = toBool(def);
  else if (type === 'number') def = toNumOrEmpty(def);

  // options, ranges
  const options = cfg.options ? String(cfg.options).split(/\s*,\s*/) : null;
  const min = cfg.min !== undefined ? Number(cfg.min) : undefined;
  const max = cfg.max !== undefined ? Number(cfg.max) : undefined;
  const step = cfg.step !== undefined ? Number(cfg.step) : undefined;

  return { type, label, default: def, options, min, max, step, placeholder: cfg.placeholder };
}


// ---------------------- FabMo runner (replace with real implementation) ----------------------
async function runSbpOnFabMo(fullSbpCode) {
  // If the FabMo Browser SDK is available, try that first
  if (typeof window !== "undefined" && window.fabmo && typeof window.fabmo.runSBP === "function") {
    return new Promise((resolve, reject) => {
      window.fabmo.runSBP(fullSbpCode, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  // Otherwise, provide a placeholder REST call you can wire to your controller.
  // TODO: Replace URL + auth with your actual FabMo endpoint. Some setups accept
  // posting jobs to /api/v2/jobs with {"file": <sbp string>} or a multipart file.
  try {
    const res = await fetch("/api/fabmo/run-sbp", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: fullSbpCode,
    });
    if (!res.ok) throw new Error(`FabMo run failed: ${res.status}`);
    return await res.text();
  } catch (err) {
    throw err;
  }
}

// ---------------------- Main Component ----------------------
export default function FabMoOpenSBPApp() {
  const [code, setCode] = useState(() => loadLS(LS_CODE_KEY, DEFAULT_SNIPPET));
  const [showEditor, setShowEditor] = useState(true);
  const [showGui, setShowGui] = useState(true);


  const directives = useMemo(() => parseDirectives(code), [code]);
  const variables = useMemo(() => extractVariables(code), [code]);

  // Build field definitions from variables + directives
  const fields = useMemo(() => {
    return variables.map((v) => {
      const cfg = directives[v] || {};
      return { name: v, ...inferField(v, cfg) };
    });
  }, [variables, directives]);

  // Load prior values or defaults
  const [values, setValues] = useState(() => {
    const saved = loadLS(LS_VALS_KEY, {});
    // apply defaults for any missing
    const vv = { ...saved };
    fields.forEach((f) => {
      if (vv[f.name] === undefined || vv[f.name] === null || vv[f.name] === "") {
        vv[f.name] = f.default ?? (f.type === "checkbox" ? false : "");
      }
    });
    return vv;
  });

  // Keep values in sync when fields change (e.g., code edits add/remove variables)
  // Prevent both panes from being hidden at once
useEffect(() => {
  if (!showEditor && !showGui) setShowEditor(true);
}, [showEditor, showGui]);

  useEffect(() => {
    setValues((prev) => {
      const next = { ...prev };
      const fieldNames = new Set(fields.map((f) => f.name));
      // remove stale
      Object.keys(next).forEach((k) => {
        if (!fieldNames.has(k)) delete next[k];
      });
      // add new with defaults
      fields.forEach((f) => {
        if (!(f.name in next)) next[f.name] = f.default ?? (f.type === "checkbox" ? false : "");
      });
      return next;
    });
  }, [fields]);

  // Persist
  useEffect(() => saveLS(LS_CODE_KEY, code), [code]);
  useEffect(() => saveLS(LS_VALS_KEY, values), [values]);

  // Utility: truthy check for “has a value”
const hasVal = (v) => v !== '' && v !== null && v !== undefined;

// Build assignment preamble OR DIALOG prompts
const assignmentLines = useMemo(() => {
  return fields.map((f) => {
    const val = values[f.name];
    const cfg = directives[f.name] || {};
    // Build prompt message (directive `prompt=`, else default from label/name)
    const promptMsg = (cfg.prompt || `Please input ${f.label || f.name}`).replace(/"/g, '""');

    // If the field is empty: emit a DIALOG to capture the value at runtime
    if (!hasVal(val)) {
      // e.g., DIALOG "Please input Length", &Length
      return `DIALOG "${promptMsg}", &${f.name}`;
    }

    // Otherwise assign as usual
    if (f.type === 'number' && !isNaN(Number(val))) {
      return `&${f.name} = ${val}`;
    }
    if (f.type === 'checkbox') {
      return `&${f.name} = ${val ? 1 : 0}`;
    }
    // strings / selects → quoted, escape quotes by doubling them
    const s = String(val).replace(/"/g, '""');
    return `&${f.name} = "${s}"`;
  });
  // include directives so prompt=... updates live
}, [fields, values, directives]);


  const fullSbp = useMemo(() => `${assignmentLines.join("\n")}\n\n${code}`, [assignmentLines, code]);

  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");
  const [confirm, setConfirm] = useState(false);

  // --- Splitter state ---
const [leftPct, setLeftPct] = useState(50);        // UI width (%)
const [dragging, setDragging] = useState(false);
const [collapsedLeft, setCollapsedLeft] = useState(false);
const [collapsedRight, setCollapsedRight] = useState(false);
const lastLeftPctRef = useRef(leftPct);

useEffect(() => {
  // don't allow both collapsed
  if (collapsedLeft && collapsedRight) setCollapsedRight(false);
}, [collapsedLeft, collapsedRight]);

function startDrag(e) {
  e.preventDefault();
  setDragging(true);
}

useEffect(() => {
  function onMove(e) {
    if (!dragging) return;
    const container = document.querySelector('.split-resizable');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX ?? (e.touches?.[0]?.clientX || 0);
    const pct = ((x - rect.left) / rect.width) * 100;
    // clamp and avoid 0/100 (leave room for divider)
    const clamped = Math.min(90, Math.max(10, pct));
    lastLeftPctRef.current = clamped;
    setLeftPct(clamped);
    // while dragging, panels are implicitly un-collapsed
    setCollapsedLeft(false);
    setCollapsedRight(false);
  }
  function onUp() {
    setDragging(false);
  }
  if (dragging) {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }
  return () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchend', onUp);
  };
}, [dragging]);

// Collapse/expand helpers
function collapseLeft() {
  setCollapsedLeft(true);
}
function expandLeft() {
  setCollapsedLeft(false);
  if (collapsedRight) setCollapsedRight(false);
  setLeftPct(lastLeftPctRef.current || 50);
}
function collapseRight() {
  setCollapsedRight(true);
}
function expandRight() {
  setCollapsedRight(false);
  if (collapsedLeft) setCollapsedLeft(false);
  setLeftPct(lastLeftPctRef.current || 50);
}


  async function handleRun() {
    setRunMsg("");
    // Basic guardrail — require explicit confirmation each session (toggleable)
    if (!confirm) {
      alert("⚠️ Safety check: Ensure the machine is clear, correct bit is installed, and Z is known. Enable 'I understand' to proceed.");
      return;
    }
    try {
      setRunning(true);
      const res = await runSbpOnFabMo(fullSbp);
      setRunMsg(typeof res === "string" ? res : "Job submitted.");
    } catch (err) {
      setRunMsg(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      <style>{`
  .split-resizable {
    position: relative;
    display: flex;
    gap: 0;             /* divider supplies visual gap */
    width: 100%;
    min-height: 60vh;
  }
  .pane {
    display: flex; flex-direction: column;
    min-width: 0; min-height: 0;
    overflow: hidden;
  }
  .divider {
    width: 6px;
    cursor: col-resize;
    background: linear-gradient(180deg, #e5e7eb, #cbd5e1);
    position: relative;
    z-index: 2;
  }
  .divider::after {
    content: '';
    position: absolute; inset: 0;
    border-left: 1px solid #cbd5e1;
    border-right: 1px solid #cbd5e1;
    opacity: .6;
  }
  .pane-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 0;
  }
  .input-narrow {
    width: 25% !important;
    min-width: 150px !important;
  }
  .chev {
    font-weight: 700; line-height: 1;
    padding: 2px 6px; border-radius: 6px;
    border: 1px solid #e5e7eb; background:#353366;
  }
  .edge-tab {
    position: absolute; top: 6px;
    padding: 4px 8px; border-radius: 6px;
    background:#f8fafc; border:1px solid #e5e7eb;
    z-index: 3;
  }
  .edge-tab:hover, .chev:hover { background:#eef2f7; }
`}</style>


      <header className="flex items-center justify-between">
  <h1 style={{ color: 'black' }} className="text-2xl font-bold">FabMo openSBP App</h1>
  <div className="flex items-center gap-3 text-sm">
    <span className="text-gray-600">
      Detected variables: {variables.length ? variables.map(v => `&${v}`).join(", ") : "(none)"}
    </span>
  </div>
</header>

{/* Split layout */}
<section
  className="split-resizable"
  style={{
    // if a side is collapsed, force widths; else use leftPct/rightPct
    gridTemplateColumns: undefined
  }}
>
  {/* LEFT PANE — UI (Parameters + Run + Preview) */}
  <div
    className="pane"
    style={{
      flex: collapsedLeft ? '0 0 0' : `0 0 ${leftPct}%`
    }}
  >
    <div className="pane-header">
      <h2 className="font-semibold">Parameters & Run</h2>
      <button className="chev" onClick={collapseLeft} title="Hide UI">«</button>
    </div>

    {/* --- Parameters --- */}
    <div className="p-3 border rounded-lg mb-4">
      <form className="space-y-3" onSubmit={(e)=>e.preventDefault()}>
        {fields.length === 0 && (
          <div className="text-gray-500 text-sm">No variables found. Add &Vars in your SBP code.</div>
        )}
        {fields.map((f) => (
          <div key={f.name} className="grid grid-cols-1 gap-1">
            <label className="text-sm text-gray-700" htmlFor={`v-${f.name}`}>
              {f.label}<span className="text-gray-400 ml-1">(&{f.name})</span>
            </label>
            {f.options ? (
              <select
                id={`v-${f.name}`}
                className="border rounded px-2 py-1 input-narrow"
                value={String(values[f.name] ?? "")}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              >
                {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <input
                id={`v-${f.name}`}
                type="checkbox"
                className="h-4 w-4"
                checked={Boolean(values[f.name])}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
              />
            ) : (
              <input
                id={`v-${f.name}`}
                type={f.type}
                inputMode={f.type === "number" ? "decimal" : undefined}
                className="border rounded px-2 py-1 input-narrow"
                placeholder={f.placeholder || ""}
                value={values[f.name] ?? (f.type === "checkbox" ? false : "")}
                min={f.min ?? undefined}
                max={f.max ?? undefined}
                step={f.step ?? (f.type === "number" ? 0.01 : undefined)}
                onChange={(e) => {
                  const val = f.type === "number"
                    ? (e.target.value === "" ? "" : Number(e.target.value))
                    : e.target.value;
                  setValues((v) => ({ ...v, [f.name]: val }));
                }}
              />
            )}
          </div>
        ))}
      </form>
    </div>

    {/* --- Run --- */}
    <div className="p-3 border rounded-lg space-y-2 mb-4">
      <div className="flex items-center gap-2">
        <input id="ack" type="checkbox" className="h-4 w-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        <label htmlFor="ack" className="text-sm">I understand running will move the machine and I've verified safety.</label>
      </div>
      <button
        disabled={running || fields.length === 0 || !confirm}
        onClick={handleRun}
        className={`w-full py-2 rounded text-white ${running || fields.length === 0 || !confirm ? "bg-gray-400" : "bg-emerald-600 hover:bg-emerald-700"}`}
        title={fields.length === 0 ? "No variables detected in code." : "Send to FabMo"}
      >
        {running ? "Running..." : "Run on Machine"}
      </button>
      {runMsg && <div className="text-sm text-gray-700">{runMsg}</div>}
    </div>

    {/* --- Preview --- */}
    <div className="p-3 border rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">Final SBP Preview</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setCode(DEFAULT_SNIPPET); }}
            className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200 text-sm"
            title="Load sample code"
          >Load Sample</button>
          <button
            onClick={() => navigator.clipboard?.writeText(fullSbp)}
            className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200 text-sm"
          >Copy</button>
        </div>
      </div>
      <pre className="bg-gray-50 p-3 rounded overflow-auto max-h-[36vh] text-sm whitespace-pre-wrap">{fullSbp}</pre>
    </div>
  </div>

  {/* DIVIDER */}
  {!collapsedLeft && !collapsedRight && (
    <div
      className="divider"
      onMouseDown={startDrag}
      onTouchStart={startDrag}
      title="Drag to resize"
    />
  )}

  {/* RIGHT PANE — Editor (Monaco) */}
  <div
    className="pane"
    style={{
      flex: collapsedRight ? '0 0 0' : `1 1 0`,
      // If both open, right flexes to remainder; if left collapsed, fills; if right collapsed, width=0
    }}
  >
    <div className="pane-header">
      <h2 className="font-semibold">Editor</h2>
      <button className="chev" onClick={collapseRight} title="Hide Editor">»</button>
    </div>

    <Editor
      height="calc(100vh - 240px)"
      defaultLanguage="opensbp"
      theme="vs"            // or 'sbp-light' / 'sbp-dark'
      value={code}
      beforeMount={handleBeforeMount}
      onChange={(v) => setCode(v ?? '')}
      options={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        minimap: { enabled: false },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'boundary',
      }}
    />
  </div>

  {/* EDGE TABS (to bring panes back when collapsed) */}
  {collapsedLeft && (
    <button className="edge-tab" style={{ left: 6 }} onClick={expandLeft} title="Show UI">» UI</button>
  )}
  {collapsedRight && (
    <button className="edge-tab" style={{ right: 6 }} onClick={expandRight} title="Show Editor">Editor «</button>
  )}
</section>


    </div>
  );  
}

// ---------------------- Sample openSBP snippet ----------------------
const DEFAULT_SNIPPET = `' Sample pocketing routine (demonstration)
' Variables used by GUI:
' @input &BitDiameter  type=number min=0.0625 max=1 step=0.001 label="Bit Diameter (in)" default=0.25
' @input &FeedRate     type=number min=10 max=300 step=1 label="Feed Rate (ipm)" default=120
' @input &PlungeRate   type=number min=5  max=100 step=1 label="Plunge Rate (ipm)" default=30
' @input &PocketWidth  type=number min=0.5 max=48 step=0.01 label="Pocket Width (in)" default=4
' @input &PocketHeight type=number min=0.5 max=48 step=0.01 label="Pocket Height (in)" default=2
' @input &Depth        type=number min=0.01 max=2 step=0.01 label="Depth (in)" default=0.125
' @input &Material     options="Plywood,Aluminum,HDPE" label="Material" default="Plywood"
' @input &UseTabs      type=checkbox label="Use tabs" default=false

' ---- Your normal SBP below (this is illustrative, not a full working routine) ----
' Set speeds
MS, &FeedRate, &PlungeRate

' Move to start (assumes you already zeroed X/Y/Z)
JZ, 1.0
J2, 0, 0

' Example: use variables inline
'Cut a rectangle using &PocketWidth by &PocketHeight at depth &Depth with bit &BitDiameter
JZ, 0.1
MZ, -1 * &Depth
J2, &PocketWidth, 0
J2, &PocketWidth, &PocketHeight
J2, 0, &PocketHeight
J2, 0, 0
JZ, 0.5

PAUSE "pause for inspection"
`;
