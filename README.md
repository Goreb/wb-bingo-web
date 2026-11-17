# Bingo Facility Observatory — 1.0

[Live site](https://bingo-facility-observatory.pages.dev/)

This fork expands the original Wildberries dashboard with facility categories,
dated incident histories, source attribution, review filters, media galleries,
favorites, and an approximate town-level map. Historical incidents do not establish
current operation. Russian operator/government claims remain separately labelled.

The public snapshot contains 672 AI-reviewed facility records. Unapproved discovery
entries and reports remain visibly distinct; review badges do not authenticate photos.
Source links, uncertainty labels, and third-party attribution are retained.

## Run and verify

Requires Node.js and Python 3. Serve over HTTP so JSON loading works:

```sh
npm start
npm run check
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build:pages
```

The optional Climate TRACE collector and its tests require Python `requests`.
The Pages build is written to `pipeline/runtime/pages-site` using an explicit public
file allowlist and media hash checks. Deploy that directory, never the repository root.
No automatic deployment or research schedule is installed by this repository.

The public data matches the November 17, 2026 Pages snapshot. Local SQLite databases,
raw research, pending candidates, review working files, credentials, and personal
instructions are excluded. The reusable review gate and offline tests are included;
see [pipeline documentation](pipeline/README.md). Its local audit database is not
reconstructible from the public export alone.

## Upstream attribution and original documentation

The original licence and acknowledgements are preserved below. The original overview
and contribution instructions describe the upstream version, not this fork's review
policy or town-level public projection.

# WB Bingo Web

> OSINT tracking dashboard for Wildberries logistics hubs, thermal incidents, damage telemetry, and distance metrics.

[Live Demo](https://drarroway.github.io/wb-bingo-web/)

---

## Overview

WB Bingo Web is a static, dependency-free dashboard built with HTML5, CSS Grid, and Vanilla JS. All data (footprint, border distance, GPS coordinates, strike logs, and sources) is driven by `facilities.json`.

## How to Contribute

Data accuracy and media coverage are open to contributions:

1. **Update & Review Data:** Verify or correct GPS coordinates, footprints ($m^2$), or strike history in `facilities.json`.
2. **Add Imagery:** Submit non-copyrighted imagery or satellite crops for facility tiles via Pull Request.

---

## AI Disclosure & Data Disclaimer

This project was built using AI (Gemini) at first for coding, CSS layout, and initial data population. 

**Note on Data:** Initial dataset entries were generated via AI search and synthesis. While designed to be more detailed than static online bingo cards, the entries was reviewed under human verification but may still contain inaccuracies until that escaped my knowledge. Contributions to fact-check sources and telemetry are welcome!

Big thanks to Reddit users: WastingMyLifeToday & SamiKitlami that helped me to improve the layout and the data accuracy.
