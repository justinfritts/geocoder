/**
 * Resolves one location to coordinates, or explains why it did not.
 *
 * The governing rule, inherited from the Power BI Flow Map this tool mirrors: being *silently*
 * wrong is the only unacceptable outcome. A row that fails produces a message naming the
 * cause; a row that matches two different places is rejected rather than guessed at. Handing
 * back a coordinate in the wrong county with no indication is worse than handing back nothing.
 *
 * Three properties of the data drive the input format, all measured rather than assumed:
 *
 *  - 31 of 56 US state codes are also ISO 3166-1 alpha-2 country codes. CA is California and
 *    Canada; IL is Illinois and Israel. Only fixed field positions disambiguate, which is why
 *    the combined form is three fields with the state left blank rather than omitted.
 *  - Fifteen ISO country names contain a comma - "Korea, Republic of" among them - so pipe is
 *    the documented delimiter for the combined form. Comma is still accepted, because parsing
 *    right to left and validating against the gazetteer makes it safe.
 *  - NFD does not decompose every Latin letter, which is why fold.js exists.
 */

import { fold, foldAdmin } from "./fold.js";
import { getIndex, getShard } from "./gazetteer.js";

/**
 * Places that no longer stand: abandoned, destroyed, historical, a former capital, and the
 * airfield equivalent. GeoNames carries them, and a great many of them have names that are
 * still in use for something else nearby.
 */
const FORMER = new Set(["PPLQ", "PPLW", "PPLH", "PPLCH", "AIRQ", "MFGQ",
    "ADM1H", "ADM2H", "ADM3H", "ADM4H", "ADM5H", "ADMDH"]);

/**
 * Administrative areas - townships, counties, districts, shires.
 *
 * An area is not a point. Whatever coordinate GeoNames records for a county is a
 * representative position inside it, so every row that resolves to one is reported as
 * approximate however precise the number looks, and they rank below anything that genuinely
 * has a location.
 */
const ADMIN = new Set(["ADM1", "ADM2", "ADM3", "ADM4", "ADM5", "ADMD", "ADMS",
    "PRSH", "TERR", "ZN", "ZNB", "LTER",
    "ADM1H", "ADM2H", "ADM3H", "ADM4H", "ADM5H", "ADMDH"]);

/**
 * Places that exist but are a part of something rather than a thing: a named section of a
 * city, or a locality with no municipal standing of its own.
 */
const SECTION = new Set(["PPLX", "PPLL"]);

/** Neither kind may win a tie against a real town. */
const MINOR = new Set([...FORMER, ...SECTION]);

const TIER_LABEL = ["national capital", "populated place", "facility", "building",
    "administrative area", "minor or former place"];

/**
 * Why a match is worth a second look, or an empty string where it is not.
 *
 * Surfaced on every matched row so a live dataset can be judged on evidence: filter the
 * output on this and you can see exactly how many of your rows leant on a ghost town or a
 * subdivision name before deciding whether carrying them is worth it.
 */
function caveatOf(code) {
    if (FORMER.has(code)) {
        return "abandoned, destroyed or historical - no longer a standing place";
    }
    if (SECTION.has(code)) {
        return "a section or locality within a larger place, not a town in its own right";
    }
    if (ADMIN.has(code)) {
        return "an administrative area, not a settlement - the point is somewhere inside it";
    }
    if (code === "BLDG") {
        return "a single named building";
    }
    return "";
}

/**
 * Readable names for the feature codes this gazetteer carries.
 *
 * GeoNames codes are opaque - nobody reading a spreadsheet knows that PPLQ is a ghost town or
 * that INSM is a military installation - and the whole point of the Match Type column is that
 * a wrong match should be visible at a glance. The raw code is kept alongside so the column
 * stays machine-filterable.
 */
const FEATURE_NAME = {
    PPL: "populated place", PPLA: "first-order administrative seat",
    PPLA2: "second-order administrative seat", PPLA3: "third-order administrative seat",
    PPLA4: "fourth-order administrative seat", PPLA5: "fifth-order administrative seat",
    PPLC: "national capital", PPLCH: "former national capital", PPLF: "farm village",
    PPLG: "seat of government", PPLH: "historical populated place", PPLL: "locality",
    PPLQ: "abandoned populated place", PPLR: "religious populated place",
    PPLS: "populated places", PPLW: "destroyed populated place",
    PPLX: "section of a populated place",
    MILB: "military base", NVB: "naval base", INSM: "military installation",
    BRKS: "barracks", AIRB: "air base", MVA: "maneuver area", LTER: "leased area",
    RNGA: "artillery range", AIRP: "airport", AIRF: "airfield", AIRH: "heliport",
    AIRQ: "abandoned airfield", AIRT: "airport terminal", AIRS: "seaplane landing area",
    PRT: "port", HBR: "harbour", DCKY: "dockyard", WHRF: "wharf", LDNG: "landing",
    FY: "ferry", FYT: "ferry terminal", RSTN: "railway station", RSTP: "railway stop",
    BUSTN: "bus station", BUSTP: "bus stop", PSTB: "border post", PSTC: "customs post",
    CSTM: "customs house",
    FT: "fort", STNC: "coast guard station", MFGM: "munitions plant",
    SCHM: "military school", ZNB: "buffer zone", BTYD: "boatyard",
    TRMO: "oil pipeline terminal", TRANT: "transit terminal",
    MFG: "factory", MFGQ: "abandoned factory", BLDO: "office building",
    DPOF: "fuel depot", OILR: "oil refinery", ADMF: "government facility",
    CTRF: "facility centre", BLDG: "building",
    ADM1: "first-order administrative division", ADM2: "county or second-order division",
    ADM3: "township or third-order division", ADM4: "fourth-order administrative division",
    ADM5: "fifth-order administrative division", ADMD: "administrative division",
    ADMS: "school district", PRSH: "parish", TERR: "territory", ZN: "zone",
    ADM1H: "former first-order division", ADM2H: "former county",
    ADM3H: "former township", ADM4H: "former fourth-order division",
    ADM5H: "former fifth-order division", ADMDH: "former administrative division",
};

function describeKind(code) {
    const name = FEATURE_NAME[code];
    return name ? name + " (" + code + ")" : code;
}

/**
 * Ranks a match so an unavoidable choice is made on a stated rule rather than on sort order.
 *
 * This is the one place the tool narrows candidates by something other than what the user
 * typed, so the rule is deliberately coarse and has nothing to do with which place is bigger
 * or more famous. A town outranks a railway platform, and both outrank a demolished hamlet.
 * Two towns of the same rank are never separated - that is reported as ambiguous.
 *
 * The national capital is the one exception, and it earns its own rank for a structural
 * reason rather than a popularity one: there is exactly one per country, so promoting it can
 * never itself be ambiguous. Without it "Paris, France" is rejected because a hamlet in Savoie
 * shares the name, which is a technically defensible answer that no user would accept.
 *
 * Note what is deliberately NOT promoted: first-order administrative seats. Doing so would
 * quietly resolve "Springfield, USA" to Illinois because it is the state capital, and that is
 * exactly the silent wrongness this tool exists to avoid - 84 places called Springfield is a
 * genuinely underspecified row, and it is reported as one.
 */
function tierOf(code) {
    if (code === "PPLC") {
        return 0;
    }
    if (MINOR.has(code) || FORMER.has(code)) {
        return 5;
    }
    if (ADMIN.has(code)) {
        // Below everything that has a real position. An exact point always beats an area: a
        // row saying "Bedford" means the town, not the borough that contains it, and only
        // falls through to the area when no such town exists.
        return 4;
    }
    if (code === "BLDG") {
        // A named building outranks nothing much. Carried on request, ranked here so a fire
        // station can never displace the town it stands in.
        return 3;
    }
    return code.slice(0, 3) === "PPL" ? 1 : 2;
}

/** Rows this far apart are the same place recorded twice, not a genuine ambiguity. */
const DUPLICATE_TOLERANCE_DEG = 0.15;

function allWithinTolerance(rows, shard, scale) {
    for (let i = 1; i < rows.length; i++) {
        const dLon = Math.abs(shard.lon[rows[i]] - shard.lon[rows[0]]) / scale;
        const dLat = Math.abs(shard.lat[rows[i]] - shard.lat[rows[0]]) / scale;
        if (dLon > DUPLICATE_TOLERANCE_DEG || dLat > DUPLICATE_TOLERANCE_DEG) {
            return false;
        }
    }
    return true;
}

/** Accepts ISO 3166-1 alpha-3 (documented), alpha-2, or a recognized name. */
export function resolveCountry(token) {
    const idx = getIndex();
    if (!idx || !token) {
        return null;
    }
    const upper = String(token).trim().toUpperCase();
    if (upper.length === 3 && idx.a3[upper] !== undefined) {
        return idx.a3[upper];
    }
    if (upper.length === 2) {
        const at = idx.ccIndex.get(upper);
        if (at !== undefined) {
            return at;
        }
    }
    const byName = idx.cn[fold(token)];
    return byName === undefined ? null : byName;
}

/**
 * Accepts a subdivision code or its English name.
 *
 * GeoNames stores postal codes for the US (US.CO) and letter codes for Great Britain
 * (GB.ENG), but FIPS-style numerics elsewhere - Canada is CA.01, Australia AU.08. The alias
 * table bridges the codes people actually type for those countries; everywhere else the
 * subdivision's name works.
 */
function resolveSubdivision(token, countryCode) {
    const idx = getIndex();
    const upper = String(token).trim().toUpperCase();
    const byCode = idx.a1ByCode.get(countryCode + "." + upper);
    if (byCode !== undefined) {
        return byCode;
    }
    const alias = idx.a1a[countryCode + "|" + upper];
    if (alias !== undefined) {
        return alias;
    }
    const byName = idx.a1ByName.get(countryCode + "|" + fold(token));
    return byName === undefined ? null : byName;
}

/**
 * County lookup by name, built once on first use.
 *
 * Scanning 39,720 counties per row would be visible on a large file, and most files never
 * need this path at all, so the map is built lazily and keyed by country to keep Bedford the
 * English borough apart from Bedford County, Virginia.
 */
let countyByName = null;

function resolveCounty(token, countryCode, idx) {
    if (!countyByName) {
        countyByName = new Map();
        for (let i = 0; i < idx.a2n.length; i++) {
            if (!idx.a2n[i] || !idx.a2p[i]) {
                continue;
            }
            const key = idx.a2cc[i] + "|" + foldAdmin(idx.a2n[i]);
            // First wins: a duplicate name inside one country cannot be told apart here, and
            // the anchors of two counties sharing a name are not far enough apart to matter at
            // the precision an area centre claims.
            if (!countyByName.has(key)) {
                countyByName.set(key, i);
            }
        }
    }
    const at = countyByName.get(countryCode + "|" + foldAdmin(token));
    return at === undefined ? -1 : at;
}

/**
 * The location as the author wrote it, made readable.
 *
 * Messages naming only the city left the reader unable to tell what was actually looked up -
 * "No place called TANAGRA" is true of a great many countries, and unhelpful in all of them.
 */
function describeInput(parts) {
    return parts.map((p) => String(p == null ? "" : p).trim()).filter((p) => p !== "").join(", ");
}

function countryName(country) {
    const idx = getIndex();
    return idx.ccn[country] || idx.ccc[country];
}

/** How a matched row reads back, so a wrong match is visible rather than buried. */
function describe(row, shard, country) {
    const idx = getIndex();
    const parts = [shard.names[row]];
    const a2 = shard.a2[row];
    if (a2 >= 0 && idx.a2n[a2]) {
        parts.push(idx.a2n[a2]);
    }
    const a1 = shard.a1[row];
    if (a1 >= 0 && idx.a1n[a1]) {
        parts.push(idx.a1n[a1]);
    }
    parts.push(idx.ccc[country]);
    return parts.join(", ");
}

/** One line per rejected candidate, so the user can see what to add to their data. */
function listCandidates(rows, shard, country, limit) {
    const idx = getIndex();
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const a2 = shard.a2[row];
        const a1 = shard.a1[row];
        let where = "";
        if (a2 >= 0 && idx.a2n[a2]) {
            where = idx.a2n[a2];
        } else if (a1 >= 0 && idx.a1n[a1]) {
            where = idx.a1n[a1];
        }
        const pop = shard.pop[row];
        let label = where || describeKind(idx.fcc[shard.fc[row]]);
        if (pop > 0) {
            label += " (pop " + pop.toLocaleString() + ")";
        }
        if (seen.has(label)) {
            continue;
        }
        seen.add(label);
        out.push(label);
        if (out.length >= limit) {
            break;
        }
    }
    return out.join("; ");
}

export function isLocated(result) {
    return result && result.lat !== undefined;
}

/**
 * Resolves one location.
 *
 * `input` carries the fields already separated: city, state, county and country. The caller is
 * responsible for splitting a combined column, because only the caller knows whether the
 * spreadsheet had one column or four.
 *
 * The shard for the country must already be loaded; resolveCountry() answers which one that is
 * without any shard, which is what lets the app load only what a file actually needs.
 */
export function locate(input, options) {
    const opts = options || {};
    const idx = getIndex();
    const parts = [input.city, input.state, input.county, input.country];

    const countryToken = input.country || opts.defaultCountry || "";
    if (!countryToken) {
        return { error: "No country given, and no default country is set" };
    }
    const country = resolveCountry(countryToken);
    if (country === null) {
        return { error: 'Unknown country "' + String(countryToken).trim() + '" - use an ISO 3166-1 alpha-3 code such as USA or NLD' };
    }
    const countryCode = idx.ccc[country];
    const shard = getShard(countryCode);
    if (!shard) {
        return { error: "No place data loaded for " + countryCode };
    }
    const scale = idx.scale;

    /**
     * An unrecognized subdivision is set aside rather than treated as fatal.
     *
     * GeoNames models one administrative level per country, and it is often not the one a user
     * has. Belgium's admin1 is the region, so "Herstal, Liege, BEL" names a real province that
     * simply is not in the data - yet "Herstal, , BEL" resolves without trouble. Discarding the
     * row would lose data we can place perfectly well; discarding the TOKEN is safe because the
     * match still has to be unique on city and country alone, so nothing is being guessed.
     */
    const stateToken = String(input.state == null ? "" : input.state).trim();
    let subdivision = null;
    let ignoredState = false;
    if (stateToken) {
        subdivision = resolveSubdivision(stateToken, countryCode);
        if (subdivision === null) {
            ignoredState = true;
        }
    }

    const countyKey = foldAdmin(input.county);
    const cityText = String(input.city == null ? "" : input.city).trim();
    const cityKey = fold(cityText);
    /**
     * A leading number, as in "0409 Singapore", "01 Dakar", "0114 Oslo".
     *
     * Real exports carry routing, branch and postal codes glued to the front of the town name.
     * The obvious fix - strip every digit from every name - is wrong, and measurably so: 7,005
     * populated places have a digit in their name, and dropping digits merges "Al Majaz 1" with
     * "Al Majaz 3" and collapses the UAE's "U01", "U26" and "U52" all onto "u".
     *
     * So the number is only dropped on a RETRY, after the name as written has already failed to
     * match. Nothing that resolves today changes, a place genuinely called "4th Mikrorayon"
     * still matches on its own name, and the retry is reported so the row can be checked.
     */
    const NUMERIC_PREFIX = /^\s*\d+\s*[-_.,:/]?\s+/;
    const strippedText = NUMERIC_PREFIX.test(cityText) ? cityText.replace(NUMERIC_PREFIX, "").trim() : "";

    /**
     * A row naming no city is still a legitimate location - country-level and state-level
     * data are real - so it resolves to the anchor point, flagged as approximate.
     */
    if (!cityKey) {
        if (stateToken && subdivision === null) {
            return { error: 'Cannot place "' + describeInput(parts) + '" - no city given, and "' + stateToken + '" is not a subdivision ' + countryCode + " recognizes" };
        }
        if (subdivision !== null) {
            const point = idx.a1p[subdivision];
            if (point) {
                return {
                    lat: point[1] / scale,
                    lon: point[0] / scale,
                    place: idx.a1n[subdivision] + ", " + countryName(country),
                    kind: "subdivision centre",
                    approximate: true,
                };
            }
        }
        const anchor = idx.cp[countryCode];
        if (!anchor) {
            return { error: 'Cannot place "' + describeInput(parts) + '" - no city given, and no anchor point for ' + countryCode };
        }
        return {
            lat: anchor[1] / scale,
            lon: anchor[0] / scale,
            place: countryName(country),
            kind: "country centre",
            approximate: true,
        };
    }

    let candidates = shard.byName.get(cityKey);
    let adjusted = "";
    if (!candidates && strippedText) {
        const retry = shard.byName.get(fold(strippedText));
        if (retry) {
            candidates = retry;
            adjusted = 'ignored the leading number in "' + cityText + '"';
        }
    }

    /**
     * The name is not a place but an administrative area - a county or a province.
     *
     * Exports map a region column onto the city field constantly, and UK data is the worst
     * offender: "Buckinghamshire" is a county, GeoNames feature class A, and no populated
     * place carries the name, so there is nothing for the ordinary lookup to find. The area
     * anchor is the honest answer - it is where the place is, to within the size of the county
     * - and it is returned flagged as approximate, exactly as a state-only row already is.
     */
    if (!candidates) {
        const areaText = strippedText || cityText;
        const asSubdivision = resolveSubdivision(areaText, countryCode);
        if (asSubdivision !== null && idx.a1p[asSubdivision]) {
            const point = idx.a1p[asSubdivision];
            return {
                lat: point[1] / scale,
                lon: point[0] / scale,
                place: idx.a1n[asSubdivision] + ", " + countryName(country),
                kind: "subdivision centre",
                approximate: true,
                adjusted: adjusted,
            };
        }
        const asCounty = resolveCounty(areaText, countryCode, idx);
        if (asCounty >= 0) {
            const point = idx.a2p[asCounty];
            return {
                lat: point[1] / scale,
                lon: point[0] / scale,
                place: idx.a2n[asCounty] + ", " + countryName(country),
                kind: "county centre",
                approximate: true,
                adjusted: adjusted,
            };
        }
    }

    if (!candidates) {
        /**
         * How far to climb when the place itself cannot be found.
         *
         * "state" stops at the subdivision, which is where the Flow Map stopped: without a
         * subdivision there is nothing close by to approximate to, and falling back to the
         * whole country moves the point hundreds of miles while still looking exact.
         *
         * "country" accepts that trade knowingly. It is worth having for a dataset where a
         * coarse point everywhere beats a sparse one - a country-level map, or a first pass to
         * see the shape of the data - and every row it produces is marked Approximate and says
         * in its own text where it was actually placed.
         */
        const level = opts.fallback || (opts.approximateToSubdivision ? "state" : "none");
        if (level !== "none" && subdivision !== null) {
            const point = idx.a1p[subdivision];
            if (point) {
                return {
                    lat: point[1] / scale,
                    lon: point[0] / scale,
                    place: cityText + " - shown at the centre of " + idx.a1n[subdivision] + ", " + countryName(country),
                    kind: "subdivision centre",
                    approximate: true,
                    adjusted: adjusted,
                };
            }
        }
        if (level === "country") {
            const anchor = idx.cp[countryCode];
            if (anchor) {
                return {
                    lat: anchor[1] / scale,
                    lon: anchor[0] / scale,
                    place: cityText + " - shown at the centre of " + countryName(country),
                    kind: "country centre",
                    approximate: true,
                    adjusted: adjusted,
                };
            }
        }
        return { error: 'Cannot find "' + describeInput(parts) + '" - no place of that name is in ' + countryCode };
    }

    let matches = candidates;
    if (subdivision !== null) {
        const narrowed = matches.filter((row) => shard.a1[row] === subdivision);
        if (narrowed.length === 0) {
            return { error: 'Cannot find "' + describeInput(parts) + '" - no "' + cityText + '" in ' + (idx.a1n[subdivision] || stateToken) + ", " + countryCode };
        }
        matches = narrowed;
    }

    // A county narrows further where the user has one, and is ignored where it does not match
    // anything - same reasoning as the subdivision, since the result must still be unique.
    if (countyKey) {
        const narrowed = matches.filter((row) => {
            const a2 = shard.a2[row];
            return a2 >= 0 && foldAdmin(idx.a2n[a2]) === countyKey;
        });
        if (narrowed.length > 0) {
            matches = narrowed;
        }
    }

    // Take the best tier present, so a town is never rejected as ambiguous merely because a
    // bus stop shares its name.
    //
    // Seeded from the candidates rather than from a literal: hard-coding the worst tier here
    // once meant that adding a tier below it filtered every match away, leaving matches[0]
    // undefined and returning NaN coordinates with no error - the exact silent failure this
    // file exists to prevent.
    let best = Infinity;
    for (const row of matches) {
        const tier = tierOf(idx.fcc[shard.fc[row]]);
        if (tier < best) {
            best = tier;
        }
    }
    matches = matches.filter((row) => tierOf(idx.fcc[shard.fc[row]]) === best);
    if (!matches.length) {
        return { error: 'Cannot find "' + describeInput(parts) + '" - internal error ranking candidates' };
    }

    let dominant = false;
    if (matches.length > 1 && !allWithinTolerance(matches, shard, scale) && opts.acceptDominant) {
        /**
         * Accepts a match where one candidate is not merely the largest but is of a wholly
         * different order from the rest.
         *
         * This is off by default and is deliberately NOT "take the biggest one". Ranking by
         * population resolves "Springfield, USA" to whichever Springfield happens to lead, and
         * the leader changes with the census - that is the silent wrongness this tool exists
         * to avoid, and no threshold makes it safe.
         *
         * The distinction the thresholds draw is between a genuine choice and a non-choice.
         * "Busan, KOR" matches a city of 3.3 million and a hamlet in Jangseong-gun; nobody
         * writing a spreadsheet meant the hamlet. "Springfield, USA" matches Missouri at
         * 167,882, Massachusetts at 153,606 and Illinois at 116,565, and there is no honest way
         * to pick - so it stays ambiguous whether this setting is on or not, because no
         * candidate is 20x the next.
         */
        const ranked = matches.slice().sort((a, b) => shard.pop[b] - shard.pop[a]);
        const top = shard.pop[ranked[0]];
        const next = shard.pop[ranked[1]];
        if (top >= 50000 && top >= next * 20) {
            matches = [ranked[0]];
            dominant = true;
        }
    }

    if (matches.length > 1 && !allWithinTolerance(matches, shard, scale)) {
        const where = listCandidates(matches, shard, country, 4);
        // Only now does an unusable subdivision matter: it was the thing that would have
        // resolved this, so the message has to name it rather than just asking for a state.
        if (ignoredState) {
            return {
                error: 'Ambiguous: "' + describeInput(parts) + '" matches ' + matches.length + " places in "
                    + countryCode + ', and "' + stateToken + '" is not a subdivision it recognizes'
                    + (where ? " - candidates: " + where : ""),
            };
        }
        return {
            error: 'Ambiguous: "' + describeInput(parts) + '" matches ' + matches.length + " " + TIER_LABEL[best] + "s in "
                + (subdivision !== null ? idx.a1n[subdivision] || countryCode : countryCode)
                + (where ? " - add a county to choose: " + where : ""),
        };
    }

    const row = matches[0];
    const code = idx.fcc[shard.fc[row]];
    return {
        lat: shard.lat[row] / scale,
        lon: shard.lon[row] / scale,
        place: describe(row, shard, country),
        kind: describeKind(code),
        code: code,
        caveat: caveatOf(code),
        // An area's coordinate is a representative point inside it, not the location of a
        // thing, so it is reported the same way a state-only row already is.
        approximate: ADMIN.has(code) || undefined,
        dominant: dominant,
        adjusted: adjusted,
    };
}

/**
 * Splits a single combined location cell into fields, right to left.
 *
 * Country last, subdivision second to last, city everything before, so a stray delimiter
 * inside a city name degrades to a lookup miss rather than a silently shifted parse. Pipe is
 * the documented delimiter and wins outright where present; comma is accepted because most
 * people will type one regardless, and right-to-left parsing plus gazetteer validation is what
 * makes accepting it safe:
 *
 *   Seoul||Korea, Republic of   ->  resolves. Pipe-split, so the comma is inert.
 *   Seoul,,Korea, Republic of   ->  BLOCKED: unknown country "Republic of"
 *   Seoul||KOR                  ->  resolves. The reason alpha-3 is preferred.
 */
export function splitCombined(text) {
    const raw = String(text == null ? "" : text);
    const parts = (raw.indexOf("|") >= 0 ? raw.split("|") : raw.split(",")).map((p) => p.trim());
    if (parts.length === 1) {
        return { city: parts[0], state: "", county: "", country: "" };
    }
    if (parts.length === 2) {
        // Two fields is "City, Something". Which one it is cannot be settled here, so hand
        // both interpretations to the caller by leaving the state empty and letting the
        // country resolver decide.
        return resolveCountry(parts[1]) !== null
            ? { city: parts[0], state: "", county: "", country: parts[1] }
            : { city: parts[0], state: parts[1], county: "", country: "" };
    }
    return {
        city: parts.slice(0, -2).join(" ").trim(),
        state: parts[parts.length - 2],
        county: "",
        country: parts[parts.length - 1],
    };
}
