/**
 * Name normalization, shared verbatim by the importer and the app.
 *
 * The Power BI Flow Map carries two hand-copied versions of this function, one in
 * src/geocode.ts and one in scripts/import-gazetteer.mjs, each warning that a divergence
 * would make correct input miss. There is no reason to repeat that here: the importer
 * imports this module, and the app build inlines this exact file. One definition, so the
 * keys written into the data and the keys computed from a user's spreadsheet cannot drift.
 *
 * Everything below is lifted from the Flow Map's measured design, plus one addition for
 * military and transport sites, which the Flow Map does not carry.
 */

/**
 * Letters that carry no combining mark, so NFD leaves them intact and a strip to [a-z0-9]
 * would delete them outright. Turkish dotless i, Vietnamese d-bar and Danish o-slash are
 * the cases that bite: without this, "Kirklareli" typed correctly becomes "krklareli".
 */
const TRANSLIT = {
    "\u0131": "i", "\u0130": "i", "\u0111": "d", "\u0110": "D", "\u0142": "l", "\u0141": "L",
    "\u00f8": "o", "\u00d8": "O", "\u00df": "ss", "\u00e6": "ae", "\u00c6": "AE", "\u0153": "oe",
    "\u0152": "OE", "\u0127": "h", "\u0126": "H", "\u00fe": "th", "\u00de": "TH", "\u00f0": "d",
    "\u00d0": "D", "\u014b": "n",
};

const COMBINING = /[\u0300-\u036f]/g;

/**
 * Facility phrases, rewritten to the abbreviation people actually type.
 *
 * GeoNames records the base at Bedford, Massachusetts as "Lawrence G. Hanscom Field"; the
 * shipping label says "Hanscom AFB". The alternate-name column often carries the spelled-out
 * "Hanscom Air Force Base", which only helps if the query's "AFB" and the data's "Air Force
 * Base" land on the same key. Rewriting both sides to "afb" is what closes that gap, and it
 * has to happen while the spaces are still present - after the strip there is no word
 * boundary left to match on.
 *
 * Ordered longest-first so "naval air station" is not eaten by "air station".
 */
const PHRASE = [
    /**
     * "Township of Parker" and "Parker Township" are the same place written two ways, and
     * GeoNames stores the first while every spreadsheet writes the second. Moving the noun to
     * the end normalizes both onto one key, and it is applied to the data and the query alike
     * so neither form can miss.
     *
     * Anchored and non-global, so only a name that begins "<noun> of " is touched at all -
     * "Isle of Wight" is untouched because "isle" is not in the list, and "Stratford-upon-Avon"
     * never had the shape.
     *
     * It does fire on longer names that happen to start that way: "City of London Cemetery"
     * becomes "london cemetery city". That looks wrong written down and costs nothing, because
     * the rule is applied to the stored name and the typed name alike - both sides land on the
     * same key, so no lookup can miss because of it.
     */
    [/^(township|city|town|village|borough|county|parish|municipality|district|province|region|department|commune) of (.+)$/, "$2 $1"],
    [/\bjoint base\b/g, "jb"],
    [/\bnaval air station\b/g, "nas"],
    [/\bnaval air facility\b/g, "naf"],
    [/\bnaval support activity\b/g, "nsa"],
    [/\bnaval station\b/g, "ns"],
    [/\bnaval base\b/g, "nb"],
    [/\bmarine corps air station\b/g, "mcas"],
    [/\bmarine corps base\b/g, "mcb"],
    [/\bair national guard base\b/g, "angb"],
    [/\bair reserve base\b/g, "arb"],
    [/\bair force base\b/g, "afb"],
    [/\bair force station\b/g, "afs"],
    [/\bair base\b/g, "ab"],
    [/\barmy airfield\b/g, "aaf"],
    [/\barmy depot\b/g, "ad"],
    [/\bcoast guard (?:air )?station\b/g, "cgs"],
    [/\bproving ground\b/g, "pg"],
    [/\binternational airport\b/g, "airport"],
    [/\bregional airport\b/g, "airport"],
    [/\bmunicipal airport\b/g, "airport"],
    [/\bairfield\b/g, "airport"],
    [/\bair field\b/g, "airport"],
];

/** Abbreviation equivalences that only make sense anchored at the start of the name. */
const PREFIX = [
    [/^sainte(?=[a-z])/, "ste"], [/^saint(?=[a-z])/, "st"],
    [/^mount(?=[a-z])/, "mt"], [/^fort(?=[a-z])/, "ft"], [/^santa(?=[a-z])/, "sta"],
];

/**
 * Strips every non-alphanumeric character including spaces, then deaccents and lower-cases.
 *
 * Aggressive on purpose, and the aggression is measured rather than assumed. Replacing
 * punctuation with a space and removing it outright each fix one case and break another:
 * "Washington, D.C." = "Washington DC" needs removal, while "Tel Aviv-Yafo" = "Tel Aviv Yafo"
 * needs the space. Removing everything satisfies both.
 *
 * The false merges this creates are absorbed by the lookup key being city plus subdivision
 * plus country rather than a bare name.
 */
export function fold(value) {
    let mapped = "";
    for (const ch of String(value ?? "")) {
        mapped += TRANSLIT[ch] ?? ch;
    }
    let out = mapped.normalize("NFD").replace(COMBINING, "").toLowerCase();
    for (const [re, to] of PHRASE) {
        out = out.replace(re, to);
    }
    out = out.replace(/[^a-z0-9]/g, "");
    for (const [re, to] of PREFIX) {
        out = out.replace(re, to);
    }
    return out;
}

/**
 * The folded words of a name, used to decide whether an alternate name is a variant spelling
 * of this place or a rendering of it in an unrelated language.
 *
 * The phrase rewrites are applied to the whole string first, so "air force base" has already
 * become the single token "afb" by the time it is split.
 */
export function tokens(value) {
    let mapped = "";
    for (const ch of String(value ?? "")) {
        mapped += TRANSLIT[ch] ?? ch;
    }
    let out = mapped.normalize("NFD").replace(COMBINING, "").toLowerCase();
    for (const [re, to] of PHRASE) {
        out = out.replace(re, to);
    }
    return out.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Administrative words that carry no identifying information.
 *
 * GeoNames records the county as "Essex County" and "City of Saint Louis"; a spreadsheet says
 * "Essex" and "St. Louis". Comparing the two without stripping the boilerplate makes the
 * county column useless for breaking ties, which is the only thing it is there for.
 */
const ADMIN_SUFFIX = /(county|parish|borough|district|municipality|municipio|censusarea|departamento|department|province|prefecture|region|township|city|town)$/;
const ADMIN_PREFIX = /^(cityof|countyof|municipalityof|districtof|provinceof|townshipof)/;

/** Folds a county or district name down to the part that actually identifies it. */
export function foldAdmin(value) {
    const folded = fold(value);
    const out = folded.replace(ADMIN_PREFIX, "").replace(ADMIN_SUFFIX, "");
    // Never strip a name down to nothing: a county genuinely called "District" must still
    // compare equal to itself.
    return out || folded;
}

/**
 * True where a string is Latin enough to be worth indexing as an alternate name.
 *
 * Alternate names carry every script GeoNames knows. Cyrillic, Han and Arabic forms all fold
 * to the empty string once non-alphanumerics are stripped, so indexing them is pure weight.
 */
export function isLatin(value) {
    return !/[^\u0000-\u007f\u00c0-\u024f]/.test(value);
}
