import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[CSV Batch Reader] extension loaded");

const NODE_TYPE = "CSVBatchReader";
const UPLOAD_SUBFOLDER = "csv_prompts";
const CONFIG_WIDGET = "columns_config";
// These two come from the node definition in csv_batch_reader.py (see
// beforeRegisterNodeDef below), so the values here are only a fallback.
let MAX_COLUMNS = 16;
let DEFAULT_COLUMNS = [
    { id: "positive", name: "positive", type: "text", default: "" },
    { id: "negative", name: "negative", type: "text", default: "" },
    { id: "width", name: "width", type: "int", default: 1024 },
    { id: "height", name: "height", type: "int", default: 1024 },
    { id: "duration", name: "duration", type: "float", default: 5 },
];
const SLOT_TYPES = { text: "STRING", int: "INT", float: "FLOAT", boolean: "BOOLEAN" };
const TYPE_LABELS = { text: "Text", int: "Integer", float: "Float (decimal)", boolean: "Boolean" };

// node id -> { start, finishing } for a "Run all rows" batch in progress
const batches = new Map();

// ---------------------------------------------------------------- helpers

function showError(summary, detail) {
    const toast = app.extensionManager?.toast;
    if (toast) {
        toast.add({ severity: "error", summary, detail, life: 6000 });
    } else {
        alert(`${summary}: ${detail}`);
    }
}

function findNode(id) {
    const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
    return nodes.find((n) => String(n.id) === String(id) && (n.comfyClass ?? n.type) === NODE_TYPE);
}

function setItemNumber(node, value) {
    const widget = node?.widgets?.find((w) => w.name === "item_number");
    if (!widget) return;
    widget.value = value;
    widget.callback?.(value);
    node.setDirtyCanvas?.(true, true);
}

function markChanged() {
    try { app.canvas?.setDirty?.(true, true); } catch (e) { /* ignore */ }
    try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch (e) { /* ignore */ }
}

// ------------------------------------------- columns / outputs (the settings)
// The list of columns is kept as JSON in a hidden widget. Because it is a normal
// widget value, it is saved inside the workflow and sent to the server when queued.

function newId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function cleanDefault(type, value) {
    if (type === "int") {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? n : 0;
    }
    if (type === "float") {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }
    if (type === "boolean") {
        return value === true || /^(true|yes|y|1|on)$/i.test(String(value ?? "").trim());
    }
    return value == null ? "" : String(value);
}

function sanitize(columns) {
    const out = [];
    const ids = new Set();
    for (const c of Array.isArray(columns) ? columns : []) {
        const name = String(c?.name ?? "").trim();
        if (!name || out.length >= MAX_COLUMNS) continue;
        const type = SLOT_TYPES[c?.type] ? c.type : "text";
        let id = String(c?.id || name);
        while (ids.has(id)) id = newId();
        ids.add(id);
        out.push({ id, name, type, default: cleanDefault(type, c?.default) });
    }
    return out;
}

function configWidget(node) {
    return node.widgets?.find((w) => w.name === CONFIG_WIDGET);
}

function readColumns(node) {
    try {
        const data = JSON.parse(configWidget(node)?.value);
        const cols = sanitize(Array.isArray(data) ? data : data?.columns);
        if (cols.length) return cols;
    } catch (e) { /* fall through to the defaults */ }
    return sanitize(DEFAULT_COLUMNS);
}

function writeColumns(node, columns) {
    const widget = configWidget(node);
    if (!widget) return;
    widget.value = JSON.stringify({ version: 1, columns });
    widget.callback?.(widget.value);
}

function hideWidget(widget) {
    if (!widget || widget.__csvHidden) return;
    widget.__csvHidden = true;
    try {
        widget.hidden = true;
        widget.computeSize = () => [0, -4];
        widget.type = "converted-widget"; // the classic way to hide a widget but keep its value
    } catch (e) { /* if hiding fails the JSON box simply stays visible */ }
}

function fitHeight(node) {
    try {
        const size = node.computeSize?.();
        if (size && node.setSize) node.setSize([node.size?.[0] ?? size[0], size[1]]);
    } catch (e) { /* ignore */ }
}

// Makes the node's output sockets match the column list: same count, names, types.
function applyColumns(node, resize) {
    const cols = readColumns(node);
    if (!node.outputs) node.outputs = [];
    cols.forEach((col, i) => {
        const slotType = SLOT_TYPES[col.type];
        if (!node.outputs[i]) node.addOutput(col.name, slotType);
        const out = node.outputs[i];
        // a connection of the wrong kind would feed bad data, so drop it
        if (out.type && out.type !== "*" && out.type !== slotType && out.links?.length) {
            node.disconnectOutput(i);
        }
        out.type = slotType;
        out.name = col.name;
        out.label = col.name;
        out.localized_name = col.name;
    });
    while (node.outputs.length > cols.length) node.removeOutput(node.outputs.length - 1);
    if (resize) fitHeight(node);
    node.setDirtyCanvas?.(true, true);
}

// Saves new settings and updates the sockets, keeping connections on columns that stay.
function commitColumns(node, oldCols, newCols) {
    const keep = new Set(newCols.map((c) => c.id));
    const keptOld = oldCols.filter((c) => keep.has(c.id));
    const sameOrder = keptOld.every((c, i) => newCols[i]?.id === c.id);
    if (sameOrder) {
        // remove sockets of deleted columns (last first, so the others keep their links)
        for (let i = oldCols.length - 1; i >= 0; i--) {
            if (!keep.has(oldCols[i].id) && node.outputs?.[i]) node.removeOutput(i);
        }
    } else {
        // the order can't be matched up (e.g. after Reset): rebuild every socket
        while (node.outputs?.length) node.removeOutput(node.outputs.length - 1);
    }
    writeColumns(node, newCols);
    applyColumns(node, true);
    markChanged();
}

// ------------------------------------------------------------ settings dialog

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    const { style, ...rest } = props;
    if (style) Object.assign(el.style, style);
    Object.assign(el, rest);
    for (const child of children) el.append(child);
    return el;
}

const FIELD_STYLE = {
    background: "var(--comfy-input-bg, #222)", color: "var(--input-text, #ddd)",
    border: "1px solid var(--border-color, #4e4e4e)", borderRadius: "4px",
    padding: "5px 7px", fontSize: "13px", width: "100%", boxSizing: "border-box",
};
const BUTTON_STYLE = {
    background: "var(--comfy-input-bg, #353535)", color: "var(--input-text, #ddd)",
    border: "1px solid var(--border-color, #4e4e4e)", borderRadius: "4px",
    padding: "6px 14px", fontSize: "13px", cursor: "pointer",
};

function openSettings(node) {
    if (document.getElementById("csv-batch-reader-settings")) return;
    const original = readColumns(node);
    let draft = original.map((c) => ({ ...c }));

    const gridStyle = { display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 32px", gap: "6px", alignItems: "center" };

    const overlay = h("div", {
        id: "csv-batch-reader-settings",
        style: {
            position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)", zIndex: "10000",
            display: "flex", alignItems: "center", justifyContent: "center",
        },
    });
    const panel = h("div", {
        style: {
            background: "var(--comfy-menu-bg, #202020)", color: "var(--input-text, #ddd)",
            border: "1px solid var(--border-color, #4e4e4e)", borderRadius: "8px", padding: "18px",
            width: "min(720px, 94vw)", maxHeight: "86vh", overflow: "auto",
            fontFamily: "sans-serif", fontSize: "13px", boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        },
    });
    overlay.append(panel);

    const body = h("div");
    const errorBox = h("div", { style: { color: "#ff6b6b", minHeight: "18px", margin: "10px 0 4px" } });
    const counter = h("span", { style: { opacity: "0.7", marginLeft: "8px" } });

    function close() {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
    }

    function defaultEditor(col) {
        if (col.type === "boolean") {
            return h("input", {
                type: "checkbox", checked: !!col.default,
                onchange: (e) => { col.default = e.target.checked; },
            });
        }
        const input = h("input", {
            type: col.type === "text" ? "text" : "number",
            value: String(col.default ?? ""),
            style: FIELD_STYLE,
            oninput: (e) => { col.default = e.target.value; },
        });
        if (col.type === "int") input.step = "1";
        if (col.type === "float") input.step = "any";
        return input;
    }

    function render() {
        body.replaceChildren();
        body.append(
            h("div", { style: { ...gridStyle, opacity: "0.7", margin: "10px 0 4px" } },
                h("div", {}, "Column name (also the output name)"),
                h("div", {}, "Output type"),
                h("div", {}, "Default if empty/missing"),
                h("div"),
            ),
        );
        draft.forEach((col, i) => {
            const nameInput = h("input", {
                type: "text", value: col.name, placeholder: "column name", style: FIELD_STYLE,
                oninput: (e) => { col.name = e.target.value; },
            });
            const typeSelect = h("select", {
                style: FIELD_STYLE,
                onchange: (e) => {
                    col.type = e.target.value;
                    col.default = cleanDefault(col.type, col.default);
                    render();
                },
            });
            for (const [value, label] of Object.entries(TYPE_LABELS)) {
                const option = h("option", { value, textContent: label });
                if (value === col.type) option.selected = true;
                typeSelect.append(option);
            }
            const remove = h("button", {
                textContent: "\u2715", title: "Remove this column", disabled: draft.length <= 1,
                style: { ...BUTTON_STYLE, padding: "4px 0", width: "32px" },
                onclick: () => { draft.splice(i, 1); render(); },
            });
            body.append(h("div", { style: { ...gridStyle, marginBottom: "6px" } },
                nameInput, typeSelect, defaultEditor(col), remove));
        });
        counter.textContent = `${draft.length} of ${MAX_COLUMNS} columns`;
        addButton.disabled = draft.length >= MAX_COLUMNS;
    }

    function fail(message) { errorBox.textContent = message; return false; }

    function save() {
        const names = new Set();
        const cols = [];
        for (const c of draft) {
            const name = String(c.name).trim();
            if (!name) return fail("Every column needs a name.");
            if (names.has(name.toLowerCase())) return fail(`"${name}" is used more than once. Each name must be different.`);
            names.add(name.toLowerCase());
            if ((c.type === "int" || c.type === "float") && !Number.isFinite(Number(c.default))) {
                return fail(`The default for "${name}" must be a number.`);
            }
            cols.push({ id: c.id, name, type: c.type, default: cleanDefault(c.type, c.default) });
        }
        if (!cols.length) return fail("Keep at least one column.");
        commitColumns(node, original, cols);
        close();
        return true;
    }

    const addButton = h("button", {
        textContent: "+ Add column", style: BUTTON_STYLE,
        onclick: () => { draft.push({ id: newId(), name: "", type: "text", default: "" }); errorBox.textContent = ""; render(); },
    });
    const resetButton = h("button", {
        textContent: "Reset to defaults", style: BUTTON_STYLE,
        title: "Back to positive, negative, width, height, duration",
        onclick: () => { draft = sanitize(DEFAULT_COLUMNS); errorBox.textContent = ""; render(); },
    });

    panel.append(
        h("div", { style: { fontSize: "16px", fontWeight: "bold", marginBottom: "6px" } }, "CSV Batch Reader settings"),
        h("div", { style: { opacity: "0.8", lineHeight: "1.4" } },
            "Each line is a column to read from the CSV and an output on the node. The output has the same name as the column. " +
            "If a column is missing from the CSV, or a cell is empty, the default is used instead."),
        body,
        errorBox,
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
            addButton, resetButton, counter,
            h("span", { style: { flex: "1" } }),
            h("button", { textContent: "Cancel", style: BUTTON_STYLE, onclick: close }),
            h("button", { textContent: "Save", style: { ...BUTTON_STYLE, background: "#2b6cb0", color: "#fff" }, onclick: save }),
        ),
    );
    render();
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
}

// ------------------------------------------------------------- preview window

const TYPE_BADGES = { text: "TEXT", int: "INT", float: "FLOAT", boolean: "BOOL" };
const COLOR = { accent: "#4da3ff", warn: "#e0a93b", bad: "#ff6b6b", good: "#5cc27a", muted: "var(--descrip-text, #999)" };

function formatDefault(column) {
    if (column.type === "boolean") return column.default ? "yes" : "no";
    if (column.type === "text") return column.default === "" ? "empty" : String(column.default);
    return String(column.default);
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function openPreview(node) {
    if (document.getElementById("csv-batch-reader-preview")) return;
    const file = node.widgets?.find((w) => w.name === "csv_filename")?.value;
    let current = Number(node.widgets?.find((w) => w.name === "item_number")?.value) || 1;

    const overlay = h("div", {
        id: "csv-batch-reader-preview",
        style: {
            position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)", zIndex: "10000",
            display: "flex", alignItems: "center", justifyContent: "center",
        },
    });
    const panel = h("div", {
        style: {
            background: "var(--comfy-menu-bg, #202020)", color: "var(--input-text, #ddd)",
            border: "1px solid var(--border-color, #4e4e4e)", borderRadius: "8px", padding: "18px",
            width: "min(1180px, 96vw)", height: "min(760px, 90vh)", display: "flex", flexDirection: "column",
            fontFamily: "sans-serif", fontSize: "13px", boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        },
    });
    overlay.append(panel);

    function close() {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
    }

    const info = h("div", { style: { opacity: "0.85", margin: "6px 0 0" } });
    const notice = h("div", { style: { margin: "8px 0 0", lineHeight: "1.5" } });
    const startLabel = h("span", { style: { color: COLOR.accent } });
    const wrapBox = h("input", { type: "checkbox", id: "csv-batch-reader-wrap" });
    const toolbar = h("div", {
        style: { display: "none", alignItems: "center", gap: "14px", margin: "10px 0 8px", flexWrap: "wrap" },
    },
        h("label", { style: { display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" } },
            wrapBox, "Wrap long text"),
        h("span", { style: { opacity: "0.7" } }, "Click a row to make it the starting row."),
        h("span", { style: { flex: "1" } }),
        startLabel,
    );
    const body = h("div", {
        style: {
            flex: "1", overflow: "auto", minHeight: "0",
            border: "1px solid var(--border-color, #4e4e4e)", borderRadius: "4px",
        },
    }, "Loading...");

    panel.append(
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px" } },
            h("div", { style: { fontSize: "16px", fontWeight: "bold" } }, "CSV preview"),
            h("div", { style: { opacity: "0.7", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(file ?? "")),
            h("button", { textContent: "Close", style: BUTTON_STYLE, onclick: close }),
        ),
        info, notice, toolbar, body,
    );
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);

    if (!file || String(file).startsWith("Put_CSV")) {
        body.textContent = "No CSV chosen yet. Click \"Browse for CSV...\" on the node first, then open the preview.";
        body.style.padding = "16px";
        return;
    }

    let data;
    try {
        const response = await api.fetchApi("/csv_batch_reader/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file, config: configWidget(node)?.value ?? "", limit: 500 }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`);
    } catch (err) {
        body.textContent = String(err?.message ?? err);
        body.style.padding = "16px";
        body.style.color = COLOR.bad;
        return;
    }
    if (!document.body.contains(overlay)) return; // closed while loading

    // header position -> the Settings column that reads it
    const readBy = new Map();
    for (const column of data.columns) {
        if (column.header_index >= 0 && !readBy.has(column.header_index)) readBy.set(column.header_index, column);
    }
    const missing = data.columns.filter((c) => c.header_index < 0);
    let emptyCells = 0;
    let badCells = 0;
    for (const marks of data.status) {
        for (const mark of marks) {
            if (mark === "empty") emptyCells++;
            else if (mark === "bad") badCells++;
        }
    }

    info.textContent = `${plural(data.total_rows, "row")}` +
        (data.truncated ? ` (showing the first ${data.rows.length})` : "") +
        ` \u00b7 ${plural(data.headers.length, "column")}`;

    const lines = [];
    const inRows = data.truncated ? " in the rows shown" : "";
    if (missing.length) {
        lines.push([COLOR.warn, "Not found in this CSV, so their defaults are used: " +
            missing.map((c) => `${c.name} (${formatDefault(c)})`).join(", ") + "."]);
    }
    if (emptyCells) lines.push([COLOR.warn, `${plural(emptyCells, "empty cell")}${inRows} will use the column's default.`]);
    if (badCells) lines.push([COLOR.bad, `${plural(badCells, "cell")}${inRows} can't be read as the column's type and will use the default.`]);
    if (!lines.length) lines.push([COLOR.good, "All the columns in Settings were found and every cell can be read."]);
    for (const [color, text] of lines) notice.append(h("div", { style: { color } }, text));

    const cellStyle = { padding: "4px 8px", borderBottom: "1px solid var(--border-color, #3a3a3a)", verticalAlign: "top", textAlign: "left" };
    const clipStyle = { maxWidth: "320px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
    const wrapStyle = { maxWidth: "320px", whiteSpace: "normal", overflow: "visible", textOverflow: "clip", wordBreak: "break-word" };
    const textCells = [];

    const headerRow = h("tr", {}, h("th", {
        style: { ...cellStyle, position: "sticky", top: "0", background: "var(--comfy-menu-bg, #202020)", zIndex: "1", opacity: "0.7" },
    }, "#"));
    data.headers.forEach((name, i) => {
        const column = readBy.get(i);
        headerRow.append(h("th", {
            style: { ...cellStyle, position: "sticky", top: "0", background: "var(--comfy-menu-bg, #202020)", zIndex: "1", opacity: column ? "1" : "0.55" },
        },
            h("div", {}, name || "(no name)"),
            h("div", { style: { fontWeight: "normal", fontSize: "11px", color: column ? COLOR.accent : COLOR.muted } },
                column ? `\u2192 ${column.name} \u00b7 ${TYPE_BADGES[column.type] ?? column.type}` : "ignored"),
        ));
    });

    const rowEls = [];
    function paintRow(tr, n) {
        tr.style.background = n === current ? "rgba(77,163,255,0.22)" : "";
    }
    function select(n) {
        current = n;
        setItemNumber(node, n);
        rowEls.forEach((el, i) => paintRow(el, i + 1));
        startLabel.textContent = `Starting row: ${n}`;
    }

    const tbody = h("tbody");
    data.rows.forEach((cells, r) => {
        const n = r + 1;
        const tr = h("tr", {
            style: { cursor: "pointer" },
            onclick: () => select(n),
            onmouseenter: () => { if (n !== current) tr.style.background = "rgba(255,255,255,0.06)"; },
            onmouseleave: () => paintRow(tr, n),
        }, h("td", { style: { ...cellStyle, opacity: "0.7", textAlign: "right" } }, String(n)));
        cells.forEach((raw, i) => {
            const column = readBy.get(i);
            const status = data.status[r][i];
            const td = h("td", { style: { ...cellStyle, opacity: column ? "1" : "0.55" } });
            const inner = h("div", { title: raw });
            if (column && status === "empty") {
                inner.append(h("span", { style: { color: COLOR.warn, fontStyle: "italic" } }, `(default: ${formatDefault(column)})`));
                inner.title = `Empty. The default (${formatDefault(column)}) is used.`;
            } else if (column && status === "bad") {
                inner.append(h("span", { style: { color: COLOR.bad } }, `${raw} \u2192 default ${formatDefault(column)}`));
                inner.title = `Can't be read as ${TYPE_BADGES[column.type] ?? column.type}. The default (${formatDefault(column)}) is used.`;
            } else {
                inner.textContent = raw;
            }
            textCells.push(inner);
            td.append(inner);
            tr.append(td);
        });
        rowEls.push(tr);
        paintRow(tr, n);
        tbody.append(tr);
    });

    function applyWrap() {
        const style = wrapBox.checked ? wrapStyle : clipStyle;
        for (const el of textCells) Object.assign(el.style, style);
    }
    wrapBox.onchange = applyWrap;
    applyWrap();

    startLabel.textContent = `Starting row: ${current}`;
    toolbar.style.display = "flex";
    body.replaceChildren(h("table", { style: { borderCollapse: "collapse", width: "100%", fontSize: "12px" } },
        h("thead", {}, headerRow), tbody));
    rowEls[current - 1]?.scrollIntoView?.({ block: "center" });
}

// -------------------------------------------------------------- Browse button

function browseForCsv(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const body = new FormData();
            body.append("image", file, file.name); // ComfyUI's upload field name, any file type
            body.append("type", "input");
            body.append("subfolder", UPLOAD_SUBFOLDER);
            body.append("overwrite", "true"); // re-browsing an edited file replaces the copy
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status !== 200) throw new Error(`${resp.status} ${resp.statusText}`);
            const data = await resp.json();
            const value = `${data.subfolder || UPLOAD_SUBFOLDER}/${data.name}`;

            const combo = node.widgets?.find((w) => w.name === "csv_filename");
            if (!combo) return;
            const values = combo.options?.values;
            if (Array.isArray(values)) {
                // drop the "put a CSV in the folder" placeholder once a real file exists
                const placeholder = values.indexOf("Put_CSV_in_csv_files_folder.csv");
                if (placeholder >= 0) values.splice(placeholder, 1);
                if (!values.includes(value)) values.push(value);
            }
            combo.value = value;
            combo.callback?.(value);
            node.setDirtyCanvas?.(true, true);
        } catch (err) {
            showError("CSV upload failed", String(err?.message ?? err));
        }
    };
    input.click();
}

// ------------------------------------------------------------------ extension

app.registerExtension({
    name: "CSVBatchReader",

    // Take the number of outputs and the default columns from the Python side,
    // so they only have to be changed in one place.
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;
        try {
            if (Array.isArray(nodeData.output) && nodeData.output.length) MAX_COLUMNS = nodeData.output.length;
            const config = JSON.parse(nodeData.input?.required?.[CONFIG_WIDGET]?.[1]?.default);
            const columns = sanitize(config?.columns);
            if (columns.length) DEFAULT_COLUMNS = columns;
        } catch (e) { /* keep the fallback values above */ }
    },

    setup() {
        // The node reports which row it is processing; show it in item_number.
        api.addEventListener("csv_batch_reader.row", ({ detail }) => {
            if (!detail) return;
            const id = String(detail.node);
            const node = findNode(id);
            if (!detail.run_all) {
                batches.delete(id);
                setItemNumber(node, detail.row);
                return;
            }
            if (!batches.has(id)) batches.set(id, { start: detail.row, finishing: false });
            if (detail.last) batches.get(id).finishing = true;
            setItemNumber(node, detail.row);
        });

        // When the whole batch has finished, go back to the row it started from
        // so the next Queue runs the whole list again.
        const finish = () => {
            for (const [id, batch] of [...batches]) {
                if (!batch.finishing) continue;
                setItemNumber(findNode(id), batch.start);
                batches.delete(id);
            }
        };
        api.addEventListener("execution_success", finish);
        api.addEventListener("executing", ({ detail }) => {
            if (detail == null || detail?.node == null) finish(); // older frontends
        });
        // Cancelled or failed: stay on the row it reached, so Queue resumes from there.
        api.addEventListener("execution_interrupted", () => batches.clear());
        api.addEventListener("execution_error", () => batches.clear());
    },

    nodeCreated(node) {
        if ((node.comfyClass ?? node.type) !== NODE_TYPE) return;
        if (node.__csvBatchReady) return; // never set up twice
        node.__csvBatchReady = true;

        hideWidget(configWidget(node));
        node.addWidget("button", "Browse for CSV...", null, () => browseForCsv(node));
        node.addWidget("button", "Preview CSV...", null, () => openPreview(node));
        node.addWidget("button", "Settings...", null, () => openSettings(node));
        applyColumns(node, true);

        // When a saved workflow loads, its saved settings arrive after the node is
        // created, so line the output sockets up with them again.
        const previous = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = previous?.apply(this, args);
            hideWidget(configWidget(this));
            applyColumns(this, false);
            return result;
        };
    },
});
