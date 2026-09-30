/**
 * Reading and writing the user's file.
 *
 * Deliberately narrow: delimited text in, delimited text out, with the original columns
 * preserved byte for byte where they were not quoted. The tool's job is to add two columns,
 * not to reinterpret a spreadsheet.
 */

/**
 * Picks the delimiter by counting candidates outside quotes on the first few lines.
 *
 * Counting on one line is not enough - a header of "Location" has no delimiter at all, and a
 * single row with a comma inside a quoted city name would outvote a genuine tab file.
 */
export function sniffDelimiter(text) {
    const sample = text.slice(0, 65536).split(/\r?\n/).filter((l) => l.length).slice(0, 20);
    const candidates = ["\t", ",", ";", "|"];
    let best = ",";
    let bestScore = -1;
    for (const d of candidates) {
        let total = 0;
        let consistent = 0;
        let first = -1;
        for (const line of sample) {
            let count = 0;
            let quoted = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') {
                    quoted = !quoted;
                } else if (ch === d && !quoted) {
                    count++;
                }
            }
            total += count;
            if (first < 0) {
                first = count;
            }
            if (count === first) {
                consistent++;
            }
        }
        // A delimiter that appears the same number of times on every line is the real one.
        const score = total === 0 ? -1 : consistent * 1000 + total;
        if (score > bestScore) {
            bestScore = score;
            best = d;
        }
    }
    return best;
}

/** RFC 4180 parse: quoted fields, doubled quotes, CR/LF inside quotes. */
export function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let i = 0;
    // A byte order mark survives every round trip through Excel and would otherwise become
    // part of the first header name, breaking column detection on the very first column.
    if (text.charCodeAt(0) === 0xfeff) {
        i = 1;
    }
    for (; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === delimiter) {
            row.push(field);
            field = "";
        } else if (ch === "\n") {
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
        } else if (ch !== "\r") {
            field += ch;
        }
    }
    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }
    return repairSpuriousQuoting(rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")), delimiter);
}

/**
 * Undoes CSV comma-quoting applied to a file that is not comma separated.
 *
 * Exports do this: the writer quotes any value containing a comma, as CSV requires, but the
 * file is pipe separated. A correct RFC 4180 parse then swallows the pipes inside the quotes
 * and returns the whole line as one field, so the state and country silently vanish:
 *
 *   "PRAHA - VINOHRADY, PRAHA 10||CZECH REPUBLIC"
 *
 * reads as a single value rather than three. In one real 9,424 row file this affected 404
 * rows, every one of which failed with "no country given" - a confusing message, because the
 * country was plainly there in the source.
 *
 * Only short rows are touched, and only when re-splitting actually yields the width the rest
 * of the file has, so a genuinely quoted value containing a delimiter is left alone.
 */
function repairSpuriousQuoting(rows, delimiter) {
    if (rows.length < 2) {
        return rows;
    }
    const width = new Map();
    for (const r of rows) {
        width.set(r.length, (width.get(r.length) || 0) + 1);
    }
    let common = 1;
    let best = 0;
    for (const [n, count] of width) {
        if (count > best) {
            best = count;
            common = n;
        }
    }
    if (common < 2) {
        return rows;
    }
    return rows.map((r) => {
        if (r.length >= common || r.length !== 1 || r[0].indexOf(delimiter) < 0) {
            return r;
        }
        const split = r[0].split(delimiter);
        return split.length === common ? split : r;
    });
}

function quote(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * One CSV line, terminated.
 *
 * Rows are serialized one at a time as they are produced rather than collected and joined at
 * the end. Joining needs the entire output as a single string, which on a multi-million row
 * file is hundreds of megabytes of contiguous heap on top of the rows it was built from.
 */
export function toCsvRow(values) {
    return values.map(quote).join(",") + "\r\n";
}

/**
 * The byte order mark that makes Excel read a UTF-8 CSV correctly.
 *
 * Without it Excel mangles every accented place name, and the output of this tool is full of
 * them. Kept separate so it can be prepended to a stream of blocks rather than to one string.
 */
export const CSV_BOM = "﻿";

/** Serializes a whole table at once. Convenient for small results; not used on the big path. */
export function toCsv(rows) {
    return CSV_BOM + rows.map(toCsvRow).join("");
}

/**
 * Guesses which columns hold what.
 *
 * Only ever a starting point - every guess is shown in a dropdown the user can change before
 * anything runs, because a wrong guess here would quietly geocode the wrong column.
 */
const PATTERNS = {
    city: /^(city|town|municipality|locality|city[_ ]?name|ciudad|ville|stadt)$|city/i,
    state: /^(state|province|prov|region|prefecture|subdivision|admin1?|st|state[_ ]?code|state[_ ]?name)$|state|province/i,
    county: /^(county|parish|borough|district|admin2)$|county|parish/i,
    country: /^(country|nation|ctry|country[_ ]?code|country[_ ]?name|iso|iso2|iso3)$|country|nation/i,
    combined: /^(location|address|place|site|origin|destination|full[_ ]?address|city[_ ]?state[_ ]?country)$|location|address/i,
};

export function detectColumns(headers) {
    const found = { city: -1, state: -1, county: -1, country: -1, combined: -1 };
    for (const role of Object.keys(PATTERNS)) {
        for (let i = 0; i < headers.length; i++) {
            const name = String(headers[i] || "").trim();
            if (!name) {
                continue;
            }
            if (PATTERNS[role].test(name)) {
                // County must not steal a header that is really the state, and vice versa.
                if (role === "state" && PATTERNS.county.test(name)) {
                    continue;
                }
                if (found[role] < 0) {
                    found[role] = i;
                }
            }
        }
    }
    // A file with real city and country columns is not a combined file, whatever else a
    // header happens to be called.
    if (found.city >= 0 && (found.country >= 0 || found.state >= 0)) {
        found.combined = -1;
    } else if (found.combined >= 0) {
        found.city = -1;
        found.state = -1;
        found.county = -1;
        found.country = -1;
    } else if (found.city >= 0) {
        // A lone city-ish column with nothing else is more likely to be a combined value than
        // a bare city name, but the user gets the final say in the dropdown.
        found.combined = -1;
    }
    return found;
}

/**
 * True where a row looks like column titles rather than data.
 *
 * Wrong either way is cheap to correct - it is a checkbox in the UI - but getting it right by
 * default matters, because a header row geocoded as data produces one confusing failure and a
 * data row treated as a header silently drops a location.
 */
export function looksLikeHeader(row) {
    if (!row || !row.length) {
        return false;
    }
    const text = row.join(" ");
    if (/^\s*$/.test(text)) {
        return false;
    }
    // Numbers in the first row almost always mean there is no header.
    const numeric = row.filter((c) => c !== "" && Number.isFinite(Number(c))).length;
    if (numeric > row.length / 2) {
        return false;
    }
    for (const pattern of Object.values(PATTERNS)) {
        if (row.some((c) => pattern.test(String(c || "").trim()))) {
            return true;
        }
    }
    return false;
}
