#!/usr/bin/env node
/**
 * Exercises the resolver against the real shards.
 *
 *   node test/run-tests.mjs
 *
 * gazetteer.js registers its callbacks on `window` and loads shards with a script tag, both of
 * which only exist in a browser. Rather than abstract that away - the script tag is load-
 * bearing, since it is what makes file:// work - the harness shims the two globals and feeds
 * the shard files in directly. What is under test is the decoding and the resolution, which is
 * where the ways to be silently wrong live.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, "dist", "data");
if (!existsSync(join(data, "index.js"))) {
    console.error("No data built. Run: node scripts/build-gazetteer.mjs <geonames-dir>");
    process.exit(1);
}

globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

const { locate, splitCombined, resolveCountry } = await import("../src/locate.js");
const { getIndex } = await import("../src/gazetteer.js");

const feed = (file) => new Function(readFileSync(join(data, file), "utf8"))();
feed("index.js");
const loaded = new Set();
const need = (cc) => {
    if (!loaded.has(cc) && existsSync(join(data, cc + ".js"))) {
        feed(cc + ".js");
        loaded.add(cc);
    }
};

let pass = 0;
let fail = 0;

/**
 * `expect` is either coordinates to land near, or a string the failure message must contain.
 * Checking the message and not just "it failed" matters: a row that fails for the wrong reason
 * sends the user to fix the wrong thing.
 */
function check(label, input, expect, options) {
    const fields = typeof input === "string" ? splitCombined(input) : input;
    const country = resolveCountry(fields.country || (options && options.defaultCountry) || "");
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(fields, options || {});
    let ok;
    let detail;
    if (typeof expect === "string") {
        ok = Boolean(got.error) && got.error.toLowerCase().includes(expect.toLowerCase());
        detail = got.error || ("resolved to " + got.lat + ", " + got.lon + " (" + got.place + ")");
    } else {
        const near = got.lat !== undefined
            && Math.abs(got.lat - expect[0]) < (expect[2] || 0.2)
            && Math.abs(got.lon - expect[1]) < (expect[2] || 0.2);
        ok = near;
        detail = got.error || (got.lat.toFixed(4) + ", " + got.lon.toFixed(4) + "  " + got.place);
    }
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + detail);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + detail);
    }
}

/** Asserts two inputs do NOT collapse onto the same place. */
function checkDistinct(label, a, b) {
    const one = [a, b].map((q) => {
        const f = splitCombined(q);
        const c = resolveCountry(f.country);
        if (c !== null) {
            need(getIndex().ccc[c]);
        }
        return locate(f, {});
    });
    const both = one.every((r) => r.lat !== undefined);
    const apart = both && (one[0].lat !== one[1].lat || one[0].lon !== one[1].lon);
    if (apart) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + one.map((r) => r.lat + "," + r.lon).join("  vs  "));
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + (both ? "same point - they were merged" : "one did not resolve"));
    }
}

/** Asserts what a matched row says about itself, rather than where it landed. */
function checkFlag(label, input, expectCaveat) {
    const fields = typeof input === "string" ? splitCombined(input) : input;
    const country = resolveCountry(fields.country);
    if (country !== null) {
        need(getIndex().ccc[country]);
    }
    const got = locate(fields, {});
    const caveat = got.caveat === undefined ? "(not matched)" : got.caveat;
    const ok = got.lat !== undefined && (expectCaveat
        ? caveat.includes(expectCaveat)
        : caveat === "");
    const detail = got.error || (got.kind + "  " + (caveat || "no caveat"));
    if (ok) {
        pass++;
        console.log("  ok    " + label.padEnd(42) + detail);
    } else {
        fail++;
        console.log("  FAIL  " + label.padEnd(42) + detail);
    }
}

console.log("\nThe three the Flow Map's coverage note called unreachable");
// All present now: the first two because no population threshold is applied at all, the third
// because the facility slice carries feature class S, which no cities* file does.
check("Andover, MA", "Andover|MA|USA", [42.6583, -71.1368]);
check("Moorestown, NJ", "Moorestown|NJ|USA", [39.9687, -74.9488]);
check("Hanscom AFB", "Hanscom AFB|MA|USA", [42.4700, -71.2890]);

console.log("\nMilitary sites, by the name people actually write");
check("Hanscom Air Force Base", "Hanscom Air Force Base|MA|USA", [42.4700, -71.2890]);
check("Fort Bragg, NC", "Fort Bragg|NC|USA", [35.1390, -79.0060, 0.4]);
check("Camp Lejeune", "Camp Lejeune|NC|USA", [34.6400, -77.3400, 0.4]);
check("Ramstein AB, Germany", "Ramstein Air Base||DEU", [49.4369, 7.6003, 0.4]);
check("Yokota AB, Japan", "Yokota Air Base||JPN", [35.7486, 139.3486, 0.4]);

console.log("\nOrdinary places");
check("Springfield, IL", "Springfield|IL|USA", [39.8017, -89.6437]);
check("Paris, TX", "Paris|TX|USA", [33.6609, -95.5555]);
check("Paris, France", "Paris||FRA", [48.8534, 2.3488]);
check("Rotterdam (no subdivision)", "Rotterdam||NLD", [51.9225, 4.4792]);
check("Rotterdam, Zuid-Holland", "Rotterdam|Zuid-Holland|NLD", [51.9225, 4.4792]);
check("London, ON (alias code)", "London|ON|CAN", [42.9834, -81.2330]);
check("Zurich accented", "Zürich||CHE", [47.3667, 8.5500]);
check("Kirklareli, Turkey", "Kırklareli||TUR", [41.7333, 27.2167]);
check("St. Louis, MO", "St. Louis|MO|USA", [38.6270, -90.1994]);
check("Saint Louis, MO", "Saint Louis|MO|USA", [38.6270, -90.1994]);
check("Washington, D.C.", "Washington|DC|USA", [38.8951, -77.0364]);
check("Tel Aviv-Yafo", "Tel Aviv-Yafo||ISR", [32.0853, 34.7818]);

console.log("\nCountry naming");
check("alpha-2", "Seoul||KR", [37.5683, 126.9778]);
check("alpha-3", "Seoul||KOR", [37.5683, 126.9778]);
check("inverted ISO name, pipe-split", "Seoul||Korea, Republic of", [37.5683, 126.9778]);
check("inverted ISO name, comma-split", "Seoul,,Korea, Republic of", "unknown country");
check("common name", "Munich||Germany", [48.1374, 11.5755]);
check("The Netherlands", "Rotterdam||The Netherlands", [51.9225, 4.4792]);

console.log("\nSeparate columns, and a default country");
check("city+state, default USA", { city: "Andover", state: "MA", county: "", country: "" }, [42.6583, -71.1368], { defaultCountry: "US" });
check("county breaks a tie", { city: "Springfield", state: "", county: "Sangamon", country: "US" }, [39.8017, -89.6437]);
check("no country at all", { city: "Andover", state: "MA", county: "", country: "" }, "no country given");

console.log("\nRefusals - these must NOT resolve");
check("ambiguous without a state", { city: "Springfield", state: "", county: "", country: "USA" }, "ambiguous");
check("unknown country", "Somewhere||Freedonia", "unknown country");
check("no such place", "Xqzzyville|MA|USA", "no place of that name");
check("real city, wrong state", "Boston|CA|USA", "no \"boston\" in california");
check("empty", { city: "", state: "", county: "", country: "" }, "no country given");

console.log("\nRows that name no city");
check("country only", "||AUS", [-25.0, 134.0, 6]);
check("state only", "|Texas|USA", [31.0, -99.0, 4]);
check("state only, unknown state", "|Freedonia|USA", "not a subdivision");

console.log("\nA number stuck on the front of the name");
// Dropped only on a retry, after the name as written has already missed.
check("0409 Singapore", "0409 Singapore||SGP", [1.2897, 103.8501, 0.6]);
check("01 Dakar", "01 Dakar||SEN", [14.6937, -17.4441, 0.6]);
check("0114 Oslo", "0114 Oslo||NOR", [59.9127, 10.7461, 0.6]);
check("no number, unaffected", "Oslo||NOR", [59.9127, 10.7461, 0.6]);
// The reason it is a retry and not a fold rule: these must stay distinct.
check("Al Majaz 1 keeps its digit", { city: "Al Majaz 1", state: "", county: "", country: "ARE" }, [25.33, 55.38, 0.5]);
check("Al Majaz 3 is a different place", { city: "Al Majaz 3", state: "", county: "", country: "ARE" }, [25.33, 55.38, 0.5]);
checkDistinct("Al Majaz 1 and 3 are not the same point", "Al Majaz 1||ARE", "Al Majaz 3||ARE");

console.log("\nA county or region in the city column");
// UK exports do this constantly. Answered with the area anchor, flagged approximate.
check("Buckinghamshire, a county", "Buckinghamshire||GBR", [51.8, -0.8, 1.2]);
check("Antrim still finds the town", "Antrim||GBR", [54.7195, -6.2072, 0.3]);
check("Belfast still finds the city", "Belfast||GBR", [54.5964, -5.9301, 0.3]);
check("Bedford still finds the town", "Bedford||GBR", [52.1350, -0.4667, 0.3]);

console.log("\nTownships and administrative areas");
// GeoNames files a US township as ADM3 named "Township of Parker", never as a populated
// place, so no depth in class P could reach one. Both word orders must land on it.
check("Township of Moorestown", "Township of Moorestown|NJ|USA", [39.96, -74.94, 0.3]);
check("Moorestown Township, as written", "Moorestown Township|NJ|USA", [39.96, -74.94, 0.3]);
check("the town still wins over the township", "Moorestown|NJ|USA", [39.9671, -74.9427, 0.1]);
// Moorestown resolves to the TOWN for both spellings, and should: the populated place carries
// "Moorestown Township" among its alternate names, so an exact point beats the area. A
// township only answers for itself where no settlement shares the name.
check("a township with no town of the name", "Township of Lost River|IN|USA", [38.5, -86.4, 1.5]);
checkFlag("that township is an area, not a point", "Township of Lost River|IN|USA", "administrative area");
check("Buckinghamshire, now a real record", "Buckinghamshire||GBR", [51.8, -0.8, 1.2]);
checkFlag("Buckinghamshire is flagged as an area", "Buckinghamshire||GBR", "administrative area");
checkFlag("Bedford is still the town", "Bedford||GBR", "");

console.log("\nHarbours - 6,220 of them, previously dropped by a class mismatch");
check("Stromness Harbour", "Stromness Harbour||GBR", [58.96, -3.29, 0.5]);

console.log("\nForts and other military additions");
check("Fort Ticonderoga", "Fort Ticonderoga|NY|USA", [43.84, -73.38, 0.3]);

console.log("\nFormer and minor places are matched, but flagged");
// Carried so a historical address still resolves, ranked last so they never win a tie, and
// marked so a live dataset can show whether carrying them was worth it.
checkFlag("Blakeley, AL - historical", "Blakeley|AL|USA", "abandoned, destroyed or historical");
// Attu deliberately expects NO flag: Alaska holds both the abandoned village and the still
// occupied Attu Station, and the tier rule is supposed to prefer the one that exists.
checkFlag("Attu, AK - the living one wins", "Attu|AK|USA", "");
checkFlag("Mustang Field, TX - abandoned airfield", "Mustang Field|TX|USA", "abandoned, destroyed or historical");
checkFlag("Bay View Estates, AL - section", "Bay View Estates|AL|USA", "section or locality");
checkFlag("Andover, MA - an ordinary town", "Andover|MA|USA", "");
checkFlag("Hanscom AFB - a facility", "Hanscom AFB|MA|USA", "");

console.log("\nDominant-match setting, off by default");
// The point of the thresholds is that the first pair flips and the second pair does not.
check("Busan, setting off", "Busan||KOR", "ambiguous");
check("Busan, setting on", "Busan||KOR", [35.1028, 129.0403], { acceptDominant: true });
check("Springfield, setting on", { city: "Springfield", state: "", county: "", country: "USA" }, "ambiguous", { acceptDominant: true });
check("Paris needs no setting", "Paris||FRA", [48.8534, 2.3488]);

console.log("\nApproximate fallback, blank by default");
check("missing place, blank", "Notaplaceatall|MA|USA", "no place of that name");
check("missing place, to the state", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { fallback: "state" });
// The state level deliberately cannot help a row with no state - that is what the country
// level is for, and why it is a separate choice rather than the same one.
check("no state, state level cannot help", "Notaplaceatall||FRA", "no place of that name", { fallback: "state" });
check("no state, country level can", "Notaplaceatall||FRA", [46.6, 2.4, 3], { fallback: "country" });
check("country level still prefers the state", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { fallback: "country" });
// A row naming no city at all resolves regardless of the setting: there is nothing else it
// could mean, so it is not a fallback.
check("no city named, no setting", "||AUS", [-25.0, 134.0, 6]);
check("old option name still honoured", "Notaplaceatall|MA|USA", [42.2, -71.7, 1.5], { approximateToSubdivision: true });

console.log("\n  " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
