# Geocoder

Turn a spreadsheet of cities, states and countries into one with latitude and longitude.

Runs entirely in the browser from a local file. **No API, no account, no network request** —
the place data sits on disk next to the HTML file, and only the countries your file actually
mentions are ever read.

Built to mirror the location handling in the Power BI [Map Flow Visual][flow], down to the
input format, the normalization rules and the refusal to guess. The gazetteer here is far
deeper: that visual bundles 26,000 cities, this carries 5.4 million places including military
bases, airports, ports and rail terminals.

[flow]: ../Map%20Flow%20Visual

## Using it

The app is in the repository; the place data is not. Two steps:

1. Download `geocoder-data.zip` from the [latest release][releases] (84 MB).
2. Unzip it into `dist/`, so that `dist/data/` sits next to `dist/geocoder.html`.

```
dist/
  geocoder.html
  data/
    index.js
    US.js
    ...
```

Then open `dist/geocoder.html` — double-click it, no server needed. Drop in a CSV, confirm the
columns it detected, click Geocode, download the result.

[releases]: https://github.com/justinfritts/geocoder/releases/latest

The data is a release asset rather than a committed file because Git keeps every version of
everything forever. At 288 MB unpacked, each rebuild would add another 288 MB to the
repository's history permanently — deleted or not — and two refreshes would put a clone near a
gigabyte. Git LFS has the same problem in a different shape: GitHub's free tier allows 1 GB of
LFS storage and 1 GB of monthly bandwidth, so this data would allow four versions and about
four clones a month. A release asset has neither limit and can be replaced in place.

### Hosting it (Docker)

To run it on a server so anyone on the network can use it from a browser:

```bash
git clone https://github.com/justinfritts/geocoder.git && cd geocoder
docker compose up -d --build
```

Then open `http://<host>:8231`. The build downloads the latest data release itself, so the
clone does not need it. To pin a data version, pass
`--build-arg DATA_URL=https://github.com/justinfritts/geocoder/releases/download/v0.2.0/geocoder-data.zip`.

The container is only nginx serving static files. Geocoding still runs in each visitor's
browser, so uploaded spreadsheets never reach the server and a single small host can serve
anyone. Shards are stored gzipped: the image carries 84 MB of data rather than 288 MB, and a US
lookup downloads 7 MB instead of 26 MB. To update, `git pull` and run the
same command again.

Five columns are appended to your original file:

| Column | Contents |
|---|---|
| `Latitude` / `Longitude` | Decimal degrees to 4 places (~11 m), or empty |
| `Matched Place` | What it actually matched — `Andover, Essex County, Massachusetts, US` |
| `Match Type` | What kind of thing it matched — `airport (AIRP)`, `military installation (INSM)`, `abandoned populated place (PPLQ)` |
| `Status` | `OK`, or every caveat that applies, or the reason it could not be placed |

`Matched Place` is the column to scan. A wrong match is only dangerous when it is invisible.

### Former and minor places are flagged

The gazetteer carries places that no longer stand and places that are part of something
larger, so a historical or informal address still resolves. They are ranked last, so they can
never beat a living town, and every row that lands on one says so in `Status`:

```
Check: abandoned, destroyed or historical - no longer a standing place
Check: a section or locality within a larger place, not a town in its own right
```

Filter on `Check:` to see how much of a real dataset depends on them. Caveats stack — a row can
be both chosen over a smaller namesake and a ghost town, and the Status column says both.

A wrinkle worth knowing if you audit the raw data: GeoNames names most of these
`Mustang Field (historical)`, which folds to `mustangfieldhistorical` and is unreachable by the
name anyone would actually type. The importer indexes the stripped form as well, so they are
answerable — otherwise they would look unused for the wrong reason.

## Input

Either shape works, and the app detects which you have:

**Separate columns** — a City column, a State column, a Country column, and optionally a
County column. Header spelling is matched loosely (`city`, `town`, `municipality`, `ciudad`…),
and every guess is a dropdown you can correct before anything runs.

**One combined column** — `City|State|Country`, parsed right to left.

- **City** — required. Everything before the last two fields, so an internal delimiter
  survives.
- **State** — the subdivision. Blank where the country has none: `Rotterdam||NLD`. Accepts
  either the code or the name.
- **Country** — ISO 3166-1 **alpha-3 preferred** (`USA`, `KOR`, `NLD`). Alpha-2 and common
  names also work.

Pipe is the documented delimiter; comma is accepted. That asymmetry is not arbitrary. Fifteen
ISO country short names contain a comma — `Korea, Republic of` among them — so:

```
Seoul||Korea, Republic of   →  resolves. Pipe-split, so the comma is inert.
Seoul,,Korea, Republic of   →  BLOCKED: unknown country "Republic of"
Seoul||KOR                  →  resolves. The reason alpha-3 is preferred.
```

Accepting comma at all is only safe because parsing runs right to left and every field is
validated against the gazetteer, so the one case a comma cannot express fails loudly.

### Why the state field is positional

31 of 56 US state codes are also ISO country codes. `CA` is California *and* Canada; `IL` is
Illinois *and* Israel. Only a fixed field position tells them apart, which is why the state is
left blank rather than omitted.

## What it will not do

**It never guesses.** A row it cannot place comes back with empty coordinates and a reason:

```
Ambiguous: "Springfield, USA" matches 84 populated places in US
  - add a county to choose: Sangamon County (pop 116,565); Hampden County; …
Cannot find "Boston, CA, USA" - no "Boston" in California, US
Unknown country "Freedonia" - use an ISO 3166-1 alpha-3 code such as USA or NLD
```

Putting a point in the wrong state and saying nothing is worse than returning nothing. Adding a
County column resolves most ambiguity in US data.

There are exactly two places a choice is made for you, both deliberate and both stated:

1. **Rank.** A town outranks a bus stop; both outrank a demolished hamlet; a *national capital*
   outranks everything, since there is only one per country and promoting it cannot itself be
   ambiguous. Without that last rule `Paris, France` is rejected because a hamlet in Savoie
   shares the name. Administrative seats are **not** promoted — that would silently resolve
   `Springfield, USA` to Illinois.
2. **Duplicates.** Rows within 0.15° of each other are the same place recorded twice.

Rows naming no city resolve to a state or country anchor, flagged `Approximate`.

### Two things it will fix for you, and say so

**A number stuck on the front of the name.** Real exports carry routing and branch codes glued
to the town: `0409 Singapore`, `01 Dakar`, `0114 Oslo`. The number is dropped and the lookup
retried — but only *after* the name as written has already missed, and the row is flagged.

The obvious version of this rule, strip every digit from every name, is wrong and measurably
so. 7,005 populated places have a digit in their name. Dropping digits merges `Al Majaz 1` with
`Al Majaz 3`, two real and distinct places in Sharjah, and collapses the UAE's `U01`, `U26` and
`U52` all onto `u`. Doing it as a retry means nothing that already resolves can change, and a
place genuinely called `4th Mikrorayon` still matches on its own name.

**A county or region in the city column.** Exports map a region column onto the city field
constantly, and UK data is the worst offender: `Buckinghamshire` is a county, GeoNames feature
class `A`, and no populated place carries the name. If a city name matches no place but does
match a subdivision or county in that country, the area's anchor is returned, flagged
`Approximate` — the same treatment a state-only row already gets. Real towns are unaffected:
`Bedford`, `Belfast` and `Antrim` still resolve to the towns, because the place lookup runs
first and only a miss falls through to the area.

### Two settings, both off by default

**What to do when a place is not in the gazetteer** — three levels, blank by default:

| Level | `Nowheresville, TX, USA` | `Nowheresville, , FRA` |
|---|---|---|
| Leave blank | blank, with a reason | blank, with a reason |
| State centre | centre of Texas | blank — no state to fall back to |
| State, then country | centre of Texas | centre of France |

Blank by default because a point in the middle of Pennsylvania looks exactly as precise as a
real one, and nothing in a spreadsheet says otherwise. The country level is coarser still and
earns its place only when a rough point everywhere beats an exact one in fewer places. Either
way the row is marked `Approximate` and its `Matched Place` says where it actually went.

This applies **only to places that could not be found**. A row naming no city at all already
resolves to its state or country centre regardless of the setting, because there is nothing
else it could mean.

**Take a candidate that is vastly larger than the rest.** Not "pick the biggest" — a candidate
qualifies only at 50,000 people *and* twenty times the next one. The thresholds exist to
separate a real choice from a non-choice:

| | Candidates | Setting on |
|---|---|---|
| `Busan, KOR` | a city of 3,285,147 and a hamlet in Jangseong-gun | resolves to Busan |
| `Springfield, USA` | Missouri 167,882, Massachusetts 153,606, Illinois 116,565 | still ambiguous |

Nobody writing a spreadsheet meant the hamlet. Nobody can honestly pick between the three
Springfields, and the leader changes with the census. Rows decided this way say so in `Status`.

## Coverage

6,114,354 places across 248 countries, 4,478 subdivisions, 47,643 counties.

Every populated place GeoNames records, with **no population threshold at all**, plus four
slices chosen for what people actually geocode:

| Slice | Contents |
|---|---|
| **Military** | Bases, naval bases, installations, barracks, air bases, forts, artillery ranges, manoeuvre areas, coast guard stations, munitions plants, military schools, leased areas |
| **Transport** | Airports, airfields, heliports, terminals, seaplane landings, ports, harbours, dockyards, wharves, landings, boatyards, ferries, rail stations and stops, bus stations, border and customs posts |
| **Industry** | Factories, oil refineries, fuel depots, pipeline and transit terminals, office buildings, government facilities, and named buildings generally |
| **Administrative** | Townships, counties, districts and every other civil division, ADM1 through ADM5 |

Deliberately excluded: terrain, water, vegetation, roads and undersea features — 4.6M records
of streams and hillsides with no geocoding value here, and a standing risk of turning a clean
miss into a confident-looking point on a mountain.

**Townships are why the administrative slice exists.** GeoNames files a US township as
`A.ADM3` named `Township of Parker` — 29,387 of them — never as a populated place, so no
amount of depth in class `P` could reach one. `fold()` normalizes the word order, so
`Parker Township` and `Township of Parker` land on the same key.

Administrative areas rank below anything with a real position, and are always reported
`Approximate`: `Bedford` still finds the town, and only falls through to the borough when no
settlement carries the name.

That last part is the point. The Flow Map's coverage note diagnosed three absences —

- **Andover, MA** is recorded at population 8,762 (the village, not the town of 36,000), so it
  falls below a `cities15000` threshold.
- **Moorestown, NJ** has population 0 recorded. 84% of US places do, so *no* population tier
  reaches it.
- **Hanscom AFB** is feature class `S.AIRP`, and the `cities*` files contain only class `P`. No
  threshold could ever include it.

— all three of which resolve here, because the depth problem and the class problem are fixed
separately. Military sites match by the name people write: `fold()` rewrites *air force base →
afb*, *naval air station → nas*, *joint base → jb* and a dozen more, on both the data and the
query, so `Hanscom AFB` and `Hanscom Air Force Base` land on the same key.

## Building

```bash
npm install
node scripts/build-gazetteer.mjs <dir with GeoNames dumps>   # ~10 min, run when refreshing data
node scripts/build-app.mjs                                    # instant
node test/run-tests.mjs
```

The data step needs `allCountries.txt`, `admin1CodesASCII.txt`, `admin2Codes.txt` and
`countryInfo.txt` from [download.geonames.org](https://download.geonames.org/export/dump/).
It writes `dist/data/` — 288 MB across 248 shards, of which the US is 25.8 MB and most
countries are under 1 MB. You only need this to refresh the data; to *use* the tool, take the
release asset instead.

To publish a refreshed gazetteer, zip the folder and attach it to a new release — the zip must
contain the `data/` directory itself, not its contents, so it unpacks correctly:

```bash
cd dist && tar --format=zip -cf ../geocoder-data.zip data
```

`dist/geocoder.html` is a single self-contained file. There is no bundler: `build-app.mjs`
strips the `import`/`export` lines and concatenates the modules in dependency order. That is
not laziness — a module script on a `file://` URL cannot import a sibling file, because the
browser treats it as a cross-origin fetch. For the same reason the shards are written as calls
to `GAZ(...)` and loaded with a plain `<script>` tag, which is not subject to that check.

`src/fold.js` is imported by both the importer and the app. The Flow Map keeps two hand-copied
versions of that function, each warning that a divergence would make correct input miss; there
is one copy here.

## Licence

MIT. Place data from [GeoNames](https://www.geonames.org/), CC BY 4.0 — attribution is shipped
in `dist/ATTRIBUTION.txt` and shown in the app footer. Country outlines from Natural Earth,
public domain.
