#!/usr/bin/env node
/**
 * Geocodes a delimited file from the command line, in constant memory.
 *
 *   node scripts/geocode.mjs input.csv [output.csv] [options]
 *
 *     --city=N --state=N --county=N --country=N --combined=N   zero-based column overrides
 *     --no-header            the first row is data, not column titles
 *     --default-country=USA  used only where a row names no country
 *     --fallback=none|state|country
 *     --ambiguity=none|dominant|inhabited   how hard to try when a name is shared
 *     --dominant             shorthand for --ambiguity=dominant
 *
 * The page does the same work and is nicer to use, but it has a ceiling: a browser tab holds
 * the parsed rows, and building a result there costs roughly two and a half times the input.
 * Measured on this machine, a million five-column rows cost 124 MB parsed and another 130 MB
 * copied - so a four million row file exhausts a tab somewhere around a quarter of the way
 * through, which is exactly where one was reported to die.
 *
 * This reads a record at a time and writes a record at a time, so the only thing that grows
 * with the input is the output file. What it holds is the gazetteer shards for the countries
 * the file actually mentions - the US shard is 111 MB decoded, most are far smaller - and
 * nothing else. A file of any length works in well under a gigabyte.
 *
 * It reads the input twice: once to find which countries appear, then again to geocode.
 * Loading shards demands knowing the countries up front, and reading a file from disk twice
 * is enormously cheaper than holding it in memory once.
 */

import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "dist", "data");

// The resolver registers its callbacks on window and expects a DOM to hang script tags from.
// Both are load-bearing in the browser, so rather than abstract them away they are stubbed.
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

const { locate, splitCombined, resolveCountry, isLocated } = await import("../src/locate.js");
const { getIndex } = await import("../src/gazetteer.js");
const { sniffDelimiter, parseDelimited, detectColumns, looksLikeHeader, toCsvRow, CSV_BOM } =
    await import("../src/table.js");

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) {
        flags[m[1]] = m[2] === undefined ? true : m[2];
    } else {
        positional.push(a);
    }
}
const input = positional[0];
if (!input || !existsSync(input)) {
    console.error("usage: node scripts/geocode.mjs input.csv [output.csv] [options]");
    process.exit(1);
}
const output = positional[1] || input.replace(/\.[^.]+$/, "") + "-geocoded.csv";

if (!existsSync(join(dataDir, "index.js"))) {
    console.error("No place data. Unzip geocoder-data.zip into dist/, or run scripts/build-gazetteer.mjs.");
    process.exit(1);
}
const feed = (file) => new Function(readFileSync(join(dataDir, file), "utf8"))();
feed("index.js");
const loadedShards = new Set();
const loadShard = (cc) => {
    if (!loadedShards.has(cc) && existsSync(join(dataDir, cc + ".js"))) {
        feed(cc + ".js");
        loadedShards.add(cc);
    }
};

const options = {
    defaultCountry: flags["default-country"] || "",
    fallback: flags.fallback || "none",
    ambiguity: flags.ambiguity || (flags.dominant ? "dominant" : "none"),
};

/**
 * Reads logical records, not lines.
 *
 * A quoted field may contain a newline, so a record can span several lines. Lines are held
 * only until the quotes balance, which is one record at a time rather than the whole file.
 */
async function* records(path, delimiter) {
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    let held = "";
    for await (const line of rl) {
        held = held ? held + "\n" + line : line;
        let quotes = 0;
        for (let i = 0; i < held.length; i++) {
            if (held[i] === '"') {
                quotes++;
            }
        }
        if (quotes % 2 === 1) {
            continue;
        }
        const rows = parseDelimited(held, delimiter);
        held = "";
        if (rows.length) {
            yield rows[0];
        }
    }
    if (held) {
        const rows = parseDelimited(held, delimiter);
        if (rows.length) {
            yield rows[0];
        }
    }
}

// --- delimiter and columns, from the head of the file ---
const head = readFileSync(input, "utf8").slice(0, 65536);
const delimiter = sniffDelimiter(head);
const headRows = parseDelimited(head, delimiter);
const hasHeader = flags["no-header"] ? false : looksLikeHeader(headRows[0]);
const headers = hasHeader
    ? headRows[0].map((h, i) => String(h || "").trim() || "Column " + (i + 1))
    : headRows[0].map((_, i) => "Column " + (i + 1));
const map = hasHeader ? detectColumns(headers) : { city: -1, state: -1, county: -1, country: -1, combined: -1 };
for (const role of ["city", "state", "county", "country", "combined"]) {
    if (flags[role] !== undefined) {
        map[role] = Number(flags[role]);
    }
}
if (map.combined < 0 && map.city < 0) {
    console.error("Could not tell which column holds the place. Pass --city=N or --combined=N.");
    console.error("Columns: " + headers.map((h, i) => i + "=" + h).join("  "));
    process.exit(1);
}

const fieldsFor = (row) => {
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
};

const sizeMb = (statSync(input).size / 1048576).toFixed(0);
console.log("input       " + input + "  (" + sizeMb + " MB, " + delimiter.replace("\t", "tab") + " separated)");
console.log("columns     " + ["city", "state", "county", "country", "combined"]
    .filter((r) => map[r] >= 0).map((r) => r + "=" + headers[map[r]]).join("  "));

// --- pass 1: which countries appear ---
const wanted = new Map();
let seen = 0;
for await (const row of records(input, delimiter)) {
    if (seen === 0 && hasHeader) {
        seen++;
        continue;
    }
    seen++;
    if (seen % 500000 === 0) {
        process.stdout.write("\r  scanning " + seen.toLocaleString());
    }
    const country = resolveCountry(fieldsFor(row).country || options.defaultCountry);
    if (country !== null) {
        const cc = getIndex().ccc[country];
        wanted.set(cc, (wanted.get(cc) || 0) + 1);
    }
}
const total = seen - (hasHeader ? 1 : 0);
console.log("\rrows        " + total.toLocaleString() + "                    ");
console.log("countries   " + wanted.size + "  loading shards");
for (const cc of [...wanted.keys()].sort()) {
    loadShard(cc);
}
console.log("            heap " + Math.round(process.memoryUsage().heapUsed / 1048576) + " MB after shards");

// --- pass 2: geocode and write ---
const out = createWriteStream(output, { encoding: "utf8" });
const write = (text) => {
    // Respect backpressure: without this the write queue becomes the memory problem the
    // streaming was meant to avoid.
    if (!out.write(text)) {
        return new Promise((resolve) => out.once("drain", resolve));
    }
    return null;
};

await write(CSV_BOM + toCsvRow(headers.concat(["Latitude", "Longitude", "Matched Place", "Match Type", "Status"])));

let ok = 0;
let approximate = 0;
let flagged = 0;
let failed = 0;
let n = 0;
let first = true;
for await (const row of records(input, delimiter)) {
    if (first && hasHeader) {
        first = false;
        continue;
    }
    first = false;
    n++;
    if (n % 200000 === 0) {
        process.stdout.write("\r  geocoding " + n.toLocaleString() + " of " + total.toLocaleString()
            + "   heap " + Math.round(process.memoryUsage().heapUsed / 1048576) + " MB");
    }
    const result = locate(fieldsFor(row), options);
    const line = row.slice();
    while (line.length < headers.length) {
        line.push("");
    }
    if (isLocated(result)) {
        const notes = [];
        if (result.approximate) {
            notes.push("Approximate");
        }
        if (result.dominant) {
            notes.push("Chosen as far larger than the alternatives");
        }
        if (result.onlyInhabited) {
            notes.push("Check: chosen as many times larger than the other candidates");
        }
        if (result.adjusted) {
            notes.push("Check: " + result.adjusted);
        }
        if (result.caveat) {
            notes.push("Check: " + result.caveat);
        }
        line.push(result.lat.toFixed(4), result.lon.toFixed(4), result.place, result.kind,
            notes.length ? notes.join("; ") : "OK");
        if (result.approximate) {
            approximate++;
        } else {
            ok++;
        }
        if (result.caveat || result.adjusted || result.onlyInhabited) {
            flagged++;
        }
    } else {
        line.push("", "", "", "", result.error);
        failed++;
    }
    const wait = write(toCsvRow(line));
    if (wait) {
        await wait;
    }
}
await new Promise((resolve) => out.end(resolve));

console.log("\routput      " + output + "                                        ");
console.log("            " + ok.toLocaleString() + " matched, " + approximate.toLocaleString()
    + " approximate, " + failed.toLocaleString() + " not placed ("
    + ((ok + approximate) / Math.max(total, 1) * 100).toFixed(1) + "% resolved)");
console.log("            " + flagged.toLocaleString() + " flagged \"Check:\" in the Status column");
console.log("            peak heap " + Math.round(process.memoryUsage().heapUsed / 1048576) + " MB");
