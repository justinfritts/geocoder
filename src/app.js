/**
 * The page: pick a file, confirm which columns hold what, run, download.
 *
 * Everything happens in the browser. There is no request to any server at any point - the only
 * things fetched are the place-data shards sitting next to this file, and only for the
 * countries the uploaded file actually names.
 */

const el = (id) => document.getElementById(id);
const show = (id, visible) => {
    el(id).hidden = !visible;
};

const state = {
    rows: [],
    headers: [],
    hasHeader: true,
    delimiter: ",",
    filename: "locations.csv",
    output: null,
};

// ---------------------------------------------------------------------------
// Startup: the index has to load before anything can be resolved.
// ---------------------------------------------------------------------------
setDataPath("data/");
loadIndex().then(() => {
    const idx = getIndex();
    const places = Object.values(idx.shards).reduce((s, v) => s + v.rows, 0);
    el("data-status").textContent = places.toLocaleString() + " places in " + idx.ccc.length
        + " countries, " + idx.a1c.length.toLocaleString() + " subdivisions, "
        + idx.a2n.length.toLocaleString() + " counties. Loaded from the data folder as needed.";
    el("data-status").className = "status ok";
    const pick = el("default-country");
    const order = idx.ccc.map((cc, i) => [idx.ccn[i], cc]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const entry of order) {
        const option = document.createElement("option");
        option.value = entry[1];
        option.textContent = entry[0] + " (" + entry[1] + ")";
        pick.appendChild(option);
    }
    show("step-file", true);
}).catch((err) => {
    el("data-status").textContent = err.message
        + " The data folder must sit beside this HTML file. Run: node scripts/build-gazetteer.mjs <geonames-dir>";
    el("data-status").className = "status bad";
});

// ---------------------------------------------------------------------------
// File in.
// ---------------------------------------------------------------------------
const drop = el("drop");
drop.addEventListener("click", () => el("file").click());
drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files.length) {
        readFile(e.dataTransfer.files[0]);
    }
});
el("file").addEventListener("change", (e) => {
    if (e.target.files.length) {
        readFile(e.target.files[0]);
    }
});

function readFile(file) {
    state.filename = file.name;
    const reader = new FileReader();
    reader.onload = () => {
        const text = String(reader.result);
        state.delimiter = sniffDelimiter(text);
        const rows = parseDelimited(text, state.delimiter);
        if (!rows.length) {
            el("file-status").textContent = "That file has no rows in it.";
            el("file-status").className = "status bad";
            return;
        }
        state.rows = rows;
        state.hasHeader = looksLikeHeader(rows[0]);
        el("has-header").checked = state.hasHeader;
        const name = { "\t": "tab", ",": "comma", ";": "semicolon", "|": "pipe" }[state.delimiter];
        el("file-status").textContent = file.name + " - " + (rows.length - (state.hasHeader ? 1 : 0)).toLocaleString()
            + " rows, " + rows[0].length + " columns, " + name + "-separated.";
        el("file-status").className = "status ok";
        // Clear any previous run before building the mapping, not after: buildMapping() is
        // what reveals step 3, so hiding it afterwards leaves the page with a preview and no
        // way to act on it.
        state.output = null;
        show("result", false);
        show("step-map", true);
        buildMapping();
    };
    reader.readAsText(file, "utf-8");
}

el("has-header").addEventListener("change", () => {
    state.hasHeader = el("has-header").checked;
    buildMapping();
});

// ---------------------------------------------------------------------------
// Column mapping. Every guess is a dropdown, because a wrong guess here would quietly
// geocode the wrong column and the output would look perfectly plausible.
// ---------------------------------------------------------------------------
const ROLES = [
    ["combined", "One combined column", "City|State|Country in a single cell. Pipe preferred, comma accepted."],
    ["city", "City / place", "Also matches a base, airport, port or station by name."],
    ["state", "State / province", "Code or name. Leave unset where the country has none."],
    ["county", "County (optional)", "Only used to break a tie between two places of the same name."],
    ["country", "Country", "ISO alpha-3 preferred, alpha-2 and common names accepted."],
];

function buildMapping() {
    const headers = state.hasHeader
        ? state.rows[0].map((h, i) => String(h || "").trim() || "Column " + (i + 1))
        : state.rows[0].map((_, i) => "Column " + (i + 1));
    state.headers = headers;
    const guess = state.hasHeader
        ? detectColumns(headers)
        : { city: -1, state: -1, county: -1, country: -1, combined: -1 };

    const box = el("mapping");
    box.textContent = "";
    for (const role of ROLES) {
        const wrap = document.createElement("label");
        wrap.className = "field";
        const title = document.createElement("span");
        title.className = "field-name";
        title.textContent = role[1];
        const hint = document.createElement("span");
        hint.className = "field-hint";
        hint.textContent = role[2];
        const select = document.createElement("select");
        select.id = "col-" + role[0];
        const none = document.createElement("option");
        none.value = "-1";
        none.textContent = "- not in this file -";
        select.appendChild(none);
        headers.forEach((h, i) => {
            const option = document.createElement("option");
            option.value = String(i);
            option.textContent = h;
            select.appendChild(option);
        });
        select.value = String(guess[role[0]]);
        wrap.appendChild(title);
        wrap.appendChild(select);
        wrap.appendChild(hint);
        box.appendChild(wrap);
    }

    // With no country column there is nothing to resolve against, so offer a default - but
    // only preselect one when the data actually looks like it.
    if (guess.country < 0 && guess.combined < 0) {
        el("default-country").value = looksAmerican(guess.state) ? "US" : "";
    }
    renderPreview();
    for (const role of ROLES) {
        el("col-" + role[0]).addEventListener("change", renderPreview);
    }
    show("step-run", true);
}

/** Cheap test: do the state values in this file read as US subdivisions? */
function looksAmerican(stateColumn) {
    if (stateColumn < 0) {
        return false;
    }
    const idx = getIndex();
    const body = state.rows.slice(state.hasHeader ? 1 : 0, state.hasHeader ? 41 : 40);
    let hits = 0;
    let seen = 0;
    for (const row of body) {
        const value = String(row[stateColumn] || "").trim();
        if (!value) {
            continue;
        }
        seen++;
        if (idx.a1ByCode.has("US." + value.toUpperCase()) || idx.a1ByName.has("US|" + fold(value))) {
            hits++;
        }
    }
    return seen > 0 && hits / seen > 0.8;
}

function mapping() {
    const out = {};
    for (const role of ROLES) {
        out[role[0]] = Number(el("col-" + role[0]).value);
    }
    return out;
}

/** The fields for one data row, after mapping and after splitting a combined column. */
function fieldsFor(row, map) {
    if (map.combined >= 0) {
        const parts = splitCombined(row[map.combined]);
        if (map.country >= 0 && String(row[map.country] || "").trim()) {
            parts.country = row[map.country];
        }
        return parts;
    }
    return {
        city: map.city >= 0 ? row[map.city] : "",
        state: map.state >= 0 ? row[map.state] : "",
        county: map.county >= 0 ? row[map.county] : "",
        country: map.country >= 0 ? row[map.country] : "",
    };
}

function renderPreview() {
    const map = mapping();
    const body = state.rows.slice(state.hasHeader ? 1 : 0, state.hasHeader ? 6 : 5);
    const table = el("preview");
    table.textContent = "";
    const head = document.createElement("tr");
    for (const label of ["City / place", "State", "County", "Country"]) {
        const th = document.createElement("th");
        th.textContent = label;
        head.appendChild(th);
    }
    table.appendChild(head);
    for (const row of body) {
        const f = fieldsFor(row, map);
        const tr = document.createElement("tr");
        for (const key of ["city", "state", "county", "country"]) {
            const td = document.createElement("td");
            td.textContent = String(f[key] || "").trim() || "-";
            if (!String(f[key] || "").trim()) {
                td.className = "empty";
            }
            tr.appendChild(td);
        }
        table.appendChild(tr);
    }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
el("run").addEventListener("click", run);

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run() {
    const map = mapping();
    if (map.combined < 0 && map.city < 0) {
        el("progress").textContent = "Choose which column holds the city, or the combined location.";
        el("progress").className = "status bad";
        return;
    }
    /**
     * Ask where to save BEFORE anything else, while the click is still warm.
     *
     * showSaveFilePicker needs transient user activation, which lasts a few seconds and is
     * spent by the call. Scanning four million rows for their countries takes far longer than
     * that, so the dialog has to be raised here, on the click itself, rather than when the
     * result is ready.
     *
     * The payoff is that the result is written to disk as it is produced and never exists in
     * memory at all. Without it the output accumulates, and on a large file the run does not
     * merely end in a crash - it slows to a crawl well before that, because a heap this full
     * spends an ever-growing share of every second collecting garbage.
     */
    let writable = null;
    let savedAs = "";
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: state.filename.replace(/\.[^.]+$/, "") + "-geocoded.csv",
                types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
            });
            writable = await handle.createWritable();
            savedAs = handle.name;
        } catch (err) {
            if (err && err.name === "AbortError") {
                return;
            }
            // Any other failure - an unsupported origin, a denied permission - is not fatal.
            // The in-memory path still works; it just cannot go as large.
            console.warn("Streaming to disk unavailable, holding the result in memory: " + err.message);
        }
    }

    el("run").disabled = true;
    show("result", false);
    const body = state.rows.slice(state.hasHeader ? 1 : 0);
    const options = {
        defaultCountry: el("default-country").value,
        fallback: el("fallback").value,
        ambiguity: el("dominant").value,
    };

    /**
     * Which shards this file needs. Resolving the country first is what lets a US-only file
     * load 26 MB instead of 288 MB.
     *
     * The parsed fields are deliberately NOT kept from this pass. Holding them costs about
     * 110 MB per million rows, and recomputing each one in the second pass costs a string
     * split. On a 4.1 million row file that trade is most of a gigabyte against a few seconds.
     */
    const wanted = new Map();
    for (let i = 0; i < body.length; i++) {
        if (i % 200000 === 0) {
            el("progress").textContent = "Reading countries, " + i.toLocaleString() + " of " + body.length.toLocaleString();
            await pause();
        }
        const country = resolveCountry(fieldsFor(body[i], map).country || options.defaultCountry);
        if (country !== null) {
            const cc = getIndex().ccc[country];
            wanted.set(cc, (wanted.get(cc) || 0) + 1);
        }
    }

    const order = [...wanted.entries()].sort((a, b) => b[1] - a[1]);
    let done = 0;
    for (const entry of order) {
        el("progress").className = "status";
        el("progress").textContent = "Loading place data for " + entry[0] + " (" + entry[1].toLocaleString()
            + " rows) - " + (done + 1) + " of " + order.length + " countries";
        await pause();
        try {
            await loadShard(entry[0]);
        } catch (err) {
            // A missing shard is not fatal to the whole run: every other country still
            // resolves, and the rows for this one report why they did not.
            console.warn(err.message);
        }
        done++;
    }

    const header = (state.hasHeader ? state.rows[0].slice() : state.headers.slice())
        .concat(["Latitude", "Longitude", "Matched Place", "Match Type", "Status"]);

    /**
     * The result is accumulated as CSV text, in blocks, rather than as a second array of rows.
     *
     * Building the output as rows and serializing at the end needs the whole file three times
     * over - the parsed input, the row copies, and then one enormous string from join() - and
     * a 4.1 million row file runs a browser tab out of memory around a quarter of the way in.
     * Measured on this machine: a million five-column rows cost 124 MB parsed and another
     * 130 MB copied, before the string.
     *
     * Serializing straight into blocks keeps one copy instead of three, and Blob accepts the
     * array of blocks directly, so the giant intermediate string never exists at all.
     */
    const blocks = [];
    let pending = [CSV_BOM + toCsvRow(header)];
    const flushBlock = async () => {
        if (!pending.length) {
            return;
        }
        const text = pending.join("");
        pending = [];
        if (writable) {
            // Written straight through to the file. Nothing is retained.
            await writable.write(text);
        } else {
            blocks.push(text);
        }
    };

    const failures = [];
    let ok = 0;
    let approximate = 0;
    let dominant = 0;
    let flagged = 0;

    for (let i = 0; i < body.length; i++) {
        if (i % 2000 === 0) {
            el("progress").textContent = "Geocoding " + i.toLocaleString() + " of " + body.length.toLocaleString();
            await pause();
        }
        const result = locate(fieldsFor(body[i], map), options);
        const row = body[i].slice();
        while (row.length < state.headers.length) {
            row.push("");
        }
        if (isLocated(result)) {
            // Caveats are additive: a row can be both chosen over a smaller namesake and a
            // ghost town, and hiding either behind the other is how a bad match goes unnoticed.
            const notes = [];
            if (result.approximate) {
                notes.push("Approximate");
            }
            if (result.dominant) {
                notes.push("Chosen as far larger than the alternatives");
            }
            if (result.onlyInhabited) {
                notes.push("Check: chosen as the only candidate recorded as inhabited");
            }
            if (result.adjusted) {
                notes.push("Check: " + result.adjusted);
            }
            if (result.caveat) {
                notes.push("Check: " + result.caveat);
            }
            row.push(result.lat.toFixed(4), result.lon.toFixed(4), result.place, result.kind,
                notes.length ? notes.join("; ") : "OK");
            if (result.approximate) {
                approximate++;
            } else {
                ok++;
                if (result.dominant) {
                    dominant++;
                }
            }
            if (result.caveat || result.adjusted || result.onlyInhabited) {
                flagged++;
            }
        } else {
            row.push("", "", "", "", result.error);
            if (failures.length < 200) {
                failures.push([i + (state.hasHeader ? 2 : 1), result.error]);
            }
        }
        pending.push(toCsvRow(row));
        if (pending.length >= 5000) {
            await flushBlock();
            if (writable) {
                /**
                 * Release the rows already written.
                 *
                 * Only when streaming to disk, because only then is the run guaranteed to be
                 * a single pass over the data. It is the other half of the memory: the parsed
                 * input costs about 124 MB per million five-column rows, so on a large file
                 * it outweighs everything else still held.
                 *
                 * Both references have to go. `body` is a slice of `state.rows`, which is a
                 * copy of the pointers rather than of the rows, so clearing one leaves the
                 * other holding every row alive.
                 */
                const upto = i + 1;
                const offset = state.hasHeader ? 1 : 0;
                for (let j = upto - 5000; j < upto; j++) {
                    if (j >= 0) {
                        body[j] = null;
                        state.rows[j + offset] = null;
                    }
                }
            }
        }
    }
    await flushBlock();
    if (writable) {
        await writable.close();
        // The rows are gone, so a second run on the same file is not possible.
        state.rows = [];
    }

    state.output = writable ? null : blocks;
    state.savedAs = savedAs;
    const failed = body.length - ok - approximate;
    el("progress").textContent = "";
    el("progress").className = "status";
    el("summary").textContent = ok.toLocaleString() + " matched"
        + (dominant ? " (" + dominant.toLocaleString() + " of them chosen over a much smaller namesake)" : "")
        + ", " + approximate.toLocaleString() + " approximate, " + failed.toLocaleString() + " not placed"
        + " (" + ((ok + approximate) / body.length * 100).toFixed(1) + "% resolved).";
    el("summary").className = failed ? "status warn" : "status ok";

    // Reported separately from the pass/fail counts, because these rows did resolve - the
    // question they raise is whether the gazetteer should be carrying such places at all.
    el("flagged").textContent = flagged
        ? flagged.toLocaleString() + " row" + (flagged === 1 ? "" : "s")
            + " matched something worth checking - a former or minor place, or a name this tool had "
            + "to adjust to find, such as one with a number stuck on the front. Each says so in the "
            + "Status column, prefixed \"Check:\". Filter on that to review them."
        : "";
    el("flagged").className = flagged ? "status warn" : "status";

    const list = el("failures");
    list.textContent = "";
    if (failures.length) {
        const caption = document.createElement("p");
        caption.className = "field-hint";
        caption.textContent = "First " + failures.length + " unplaced rows. Every one of them is in the "
            + "downloaded file too, with the same explanation in the Status column.";
        list.appendChild(caption);
        const table = document.createElement("table");
        for (const f of failures) {
            const tr = document.createElement("tr");
            const line = document.createElement("td");
            line.className = "line";
            line.textContent = "row " + f[0];
            const why = document.createElement("td");
            why.textContent = f[1];
            tr.appendChild(line);
            tr.appendChild(why);
            table.appendChild(tr);
        }
        list.appendChild(table);
    }
    // When it streamed to disk the file is already complete, so offering a download would be
    // both wrong and impossible - nothing was kept to download.
    el("download").hidden = Boolean(writable);
    el("saved").textContent = writable
        ? "Written to " + savedAs + " as it was geocoded. Re-running needs the file dropped in again, "
            + "because the rows were released as they were written."
        : "";
    el("saved").className = writable ? "status ok" : "status";

    show("result", true);
    el("run").disabled = false;
}

el("download").addEventListener("click", () => {
    if (!state.output) {
        return;
    }
    // Blob takes the blocks as they are. Concatenating them first would rebuild the entire
    // file as one string, which is the allocation this whole path exists to avoid.
    const blob = new Blob([CSV_BOM].concat(state.output), { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = state.filename.replace(/\.[^.]+$/, "") + "-geocoded.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
