const Zotero = require("Zotero");

// item types whose own "title" field should be Title Case (book/thesis/report
// titles conventionally use Title Case). Everything else - journal articles,
// book section titles, and any other item type - gets Sentence Case instead.
const TITLE_CASE_TYPES = new Set(["book", "thesis", "report"]);

const SMALL_WORDS = new Set([
    "a", "an", "and", "as", "at", "but", "by", "en", "for", "if", "in",
    "nor", "of", "on", "or", "per", "the", "to", "v", "v.", "via", "vs", "vs.", "y", "o"
]);

// Words that introduce a lettered/numbered division label - e.g. "Appendix
// A", "Section B", "Part IV", "Table S1", "Appendix A.1". Whatever token
// directly follows one of these (in Sentence Case) is a designator/code, not
// an English word, so it's left exactly as typed instead of being run
// through the normal casing rules - this is what keeps the "A" in
// "Appendix A" capitalized instead of being treated as the article "a".
const SECTION_WORDS = [
    "appendix", "section", "part", "volume", "vol", "chapter", "table",
    "figure", "fig", "annex", "supplement", "book",
];
const SECTION_WORD_BEFORE_RE = new RegExp(`(?:${SECTION_WORDS.join("|")})\\.?\\s+$`, "iu");

// true if the text immediately before `offset` in `string` ends with one of
// SECTION_WORDS (optionally followed by a period, e.g. "Vol."), meaning the
// token starting at `offset` is a division label/code to leave untouched
function isSectionLabel(string, offset) {
    return SECTION_WORD_BEFORE_RE.test(string.slice(0, offset));
}

// Proper nouns/phrases (place names, taxonomic orders and families, etc.)
// that should always keep this exact capitalization no matter where they
// land in the title - Sentence Case would otherwise lower them like any
// other non-first word. Add to this list as needed; matching is whole-word/
// whole-phrase and case-insensitive, so any casing of these in the original
// title gets normalized to the form written here.
const PROPER_NOUNS = [
    "Amazon",
    "Amazonia",
    "Atlantic Forest",
    "Mexico",
    "Peru",
    "Peruvian",
    "Ecuador",
    "Ecuadorian",
    "Europe",
    "Europeans",
    "Colombia",
    "Colombian",
    "New World",
    "Old World",
    "Sulawesi",
    "Misiones",
    "Argentina",
    "Argentine",
    "Argentinian",
    "United States",
    "American",
    "Brazil",
    "Brazilian",
    "Illumina",
    "Oxford Nanopore",
    "East Anglia",
    "Aotus",
    "Cebidae",
    "Pitheciidae",
    "Atelidae",
    "Callitrichidae",
    "Azara's",
    "Rensch's",
    "Rubin's",
    "Darwin",
    "Darwin's",
    "Lukas",
    "Clutton-Brock",
    "South Africa",
    "Africa",
    "Hemelrijk",
    "Tree of Life",
    "America",
    "Americas",
    "French Guiana",
    "Felsenstein",
    "Felsenstein's",
    "Dixson",
    "Bayes",
    "Bayes'",
    "Bayesian",
    "Taï National Park",
    "Côte d'Ivoire",
    "Argentinean",
    "Chaco",
    "Platyrrhini",
    "South America",
    "South American",
    "Primates, Platyrrhini",
    "Platyrrhini, Primates",
    "Santa Cruz Province",
    "Miocene",
    "Formosa",
    "Andes",
    "Río Santa Cruz",
    "Río Bote"
];

// build a single case-insensitive, word-boundary regex out of PROPER_NOUNS,
// longest phrase first so e.g. "Atlantic Forest" matches before "Atlantic"
const PROPER_NOUN_RE = PROPER_NOUNS.length
    ? new RegExp(
        "\\b(" +
        PROPER_NOUNS
            .slice()
            .sort((a, b) => b.length - a.length)
            .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|") +
        ")\\b",
        "gi"
    )
    : null;

const PROPER_NOUN_LOOKUP = new Map(PROPER_NOUNS.map(p => [p.toLowerCase(), p]));

// re-capitalize any proper nouns/phrases to their canonical form, overriding
// whatever the casing logic above decided for them
function restoreProperNouns(text) {
    if (!PROPER_NOUN_RE) return text;
    return text.replace(PROPER_NOUN_RE, match => PROPER_NOUN_LOOKUP.get(match.toLowerCase()) ?? match);
}

// Taxonomic order names used to recognize parenthetical notes like
// "(Primates, Cebidae)" or "(Primates: Cebidae)". Unlike PROPER_NOUNS (an
// exact list of words/phrases), this lets any family name following a known
// order in that bracketed pattern get capitalized automatically - so you
// don't have to enumerate every family name, just the orders that introduce
// them in parentheses. Add more orders here as needed (e.g. "Carnivora",
// "Rodentia", "Chiroptera").
const TAXONOMIC_ORDERS = [
    "Primates",
    "Hymenoptera",
    "Carnivora"
];

const ORDER_LOOKUP = new Map(TAXONOMIC_ORDERS.map(o => [o.toLowerCase(), o]));
const ORDER_ALTERNATION = TAXONOMIC_ORDERS
    .map(o => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

// matches "(Order, Family[, Family2, ...])" or "(Order: Family[, ...])"
const TAXONOMIC_PAREN_RE = TAXONOMIC_ORDERS.length
    ? new RegExp(`\\((${ORDER_ALTERNATION})((?:\\s*[,:]\\s*\\p{L}+)+)(\\s*\\))`, "giu")
    : null;

function restoreTaxonomicParens(text) {
    if (!TAXONOMIC_PAREN_RE) return text;
    return text.replace(TAXONOMIC_PAREN_RE, (match, order, rest, close) => {
        const canonicalOrder = ORDER_LOOKUP.get(order.toLowerCase()) ?? order;
        const fixedRest = rest.replace(/([,:]\s*)(\p{L}+)/gu,
            (m, sep, word) => sep + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
        return `(${canonicalOrder}${fixedRest}${close}`;
    });
}

// characters to skip over (right-to-left) when looking for the punctuation
// that precedes a word, so we can tell whether a word follows a colon/dash
const SKIP_BEFORE = /[\s'"“‘„«¡¿\uFFFD]/;

// "sentence case" a scientific name: lowercase everything, then uppercase
// only the very first letter (the start of the genus name) - e.g.
// "ESCHERICHIA COLI" or "escherichia Coli subsp. Foo" -> "Escherichia coli subsp. foo"
function sentenceCaseScientificName(str) {
    const lower = str.toLowerCase();
    return lower.replace(/\p{L}/u, ch => ch.toUpperCase());
}

function titleCase(text) {
    // strip tags before checking all-caps, so a lowercase tag name like
    // "<i>" (which itself would become "<I>" under toUpperCase) doesn't
    // spuriously break the comparison and mask an otherwise all-caps title
    const bareText = text.replace(/<[^>]+>/g, "");
    const allcaps = bareText === bareText.toUpperCase();
    const preserve = [];

    // protect nocase spans - restored verbatim, untouched
    text.replace(/<span class="nocase">.*?<\/span>|<nc>.*?<\/nc>/g, (match, offset) => {
        preserve.push({ start: offset, end: offset + match.length, text: match });
        return match;
    });

    // mask html tags so word-matching doesn't step on markup
    let masked = text.replace(/<[^>]+>/g, (match, offset) => {
        preserve.push({ start: offset, end: offset + match.length, text: match });
        return "\uFFFD".repeat(match.length);
    });

    // protect <i>...</i> (used here for scientific names), applying sentence
    // case: genus (first word) capitalized, species/subspecies epithets lowercase.
    // Case-insensitive so <I>, <i>...</I>, etc. all match; the tags themselves
    // are always normalized to lowercase <i>...</i> in the output. Pushed after
    // the generic tag-masking above so it wins on restore (overrides those
    // per-tag entries for this span instead of being overridden by them).
    text.replace(/<i>([\s\S]*?)<\/i>/gi, (match, inner, offset) => {
        const fixed = `<i>${sentenceCaseScientificName(inner)}</i>`;
        preserve.push({ start: offset, end: offset + match.length, text: fixed });
        return match;
    });

    const wordRe = /[\p{L}\p{N}\uFFFD][\p{L}\p{N}\p{Pc}'’\uFFFD]*/gu;

    // collect every "real" word (i.e. contains at least one unmasked character)
    const words = [];
    let m;
    while ((m = wordRe.exec(masked)) !== null) {
        const unmasked = m[0].replace(/\uFFFD/g, "");
        if (unmasked.length > 0) {
            words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
        }
    }
    if (!words.length) return text;

    const firstIdx = 0;
    const lastIdx = words.length - 1;

    let result = masked;
    // walk back-to-front so earlier splice indices stay valid
    for (let idx = words.length - 1; idx >= 0; idx--) {
        const { text: word, start, end } = words[idx];
        const unmasked = word.replace(/\uFFFD/g, "");

        let precedingChar = "";
        for (let p = start - 1; p >= 0; p--) {
            const ch = result[p];
            if (SKIP_BEFORE.test(ch)) continue;
            precedingChar = ch;
            break;
        }
        const afterColonOrDash = precedingChar === ":" || precedingChar === "—" || precedingChar === "–" || precedingChar === "-";
        const isFirstOrLast = idx === firstIdx || idx === lastIdx;
        const isSmall = SMALL_WORDS.has(unmasked.toLowerCase());

        let newUnmasked;
        if (isSectionLabel(result, start)) {
            // "Appendix A", "Section IV", "Table S1", etc. - this token is a
            // division label/code, not an English word, so leave it exactly
            // as typed (otherwise "A" would be treated as the small word
            // "a", and an all-caps roman numeral like "IV" would get
            // mangled into "Iv")
            newUnmasked = unmasked;
        } else if (allcaps) {
            const lower = unmasked.toLowerCase();
            newUnmasked = (isSmall && !isFirstOrLast && !afterColonOrDash)
                ? lower
                : lower.charAt(0).toUpperCase() + lower.slice(1);
        } else if (/\p{Lu}/u.test(unmasked.slice(1))) {
            // internal capital already present (McDonald, iPhone, DNA) - leave as-is
            newUnmasked = unmasked;
        } else if (isSmall && !isFirstOrLast && !afterColonOrDash) {
            newUnmasked = unmasked.toLowerCase();
        } else {
            newUnmasked = unmasked.charAt(0).toUpperCase() + unmasked.slice(1).toLowerCase();
        }

        // redistribute the recased letters back into their original positions,
        // leaving any embedded mask (tag) characters untouched in place
        let newWord;
        if (word.includes("\uFFFD")) {
            let ui = 0;
            newWord = "";
            for (const ch of word) {
                newWord += ch === "\uFFFD" ? ch : newUnmasked[ui++];
            }
        } else {
            newWord = newUnmasked;
        }

        result = result.substring(0, start) + newWord + result.substring(end);
    }

    // restore html tags / nocase spans / italic scientific names
    for (const { start, end, text: replacement } of preserve) {
        result = result.substring(0, start) + replacement + result.substring(end);
    }

    return result;
}

function sentenceCase(text) {
    const preserve = [];
    // strip tags before checking all-caps, so a lowercase tag name like
    // "<i>" (which itself would become "<I>" under toUpperCase) doesn't
    // spuriously break the comparison and mask an otherwise all-caps title
    const bareText = text.replace(/<[^>]+>/g, "");
    const allcaps = bareText === bareText.toUpperCase();

    // sub-sentence start (after . ? !)
    text.replace(/([.?!][\s]+)(<[^>]+>)?([\p{Lu}])/ug, (match, end, markup, char, i) => {
        markup = markup || "";
        if (!text.substring(0, i + 1).match(/(\p{Lu}[.]){2,}$/u)) {
            preserve.push({ start: i + end.length + markup.length, end: i + end.length + markup.length + char.length });
        }
    });

    // protect leading capital
    text.replace(/^(<[^>]+>)?([\p{Lu}])/u, (match, markup, char) => {
        markup = markup || "";
        preserve.push({ start: markup.length, end: markup.length + char.length });
    });

    // protect nocase spans
    text.replace(/<span class="nocase">.*?<\/span>|<nc>.*?<\/nc>/gi, (match, i) => {
        preserve.push({ start: i, end: i + match.length, description: 'nocase' });
    });

    // mask html tags
    let masked = text.replace(/<[^>]+>/g, (match, i) => {
        preserve.push({ start: i, end: i + match.length, description: 'markup' });
        return '\uFFFD'.repeat(match.length);
    });

    // protect <i>...</i> (used here for scientific names), applying sentence
    // case: genus (first word) capitalized, species/subspecies epithets lowercase.
    // Case-insensitive so <I>, <i>...</I>, etc. all match; the tags themselves
    // are always normalized to lowercase <i>...</i> in the output. Pushed after
    // the generic tag-masking above so it wins on restore (overrides those
    // per-tag entries for this span instead of being overridden by them).
    text.replace(/<i>([\s\S]*?)<\/i>/gi, (match, inner, i) => {
        const fixed = `<i>${sentenceCaseScientificName(inner)}</i>`;
        preserve.push({ start: i, end: i + match.length, text: fixed, description: 'italic-scientific-name' });
    });

    masked = masked
        .replace(/[;:]\uFFFD*\s+\uFFFD*A\s/g, match => match.toLowerCase())
        .replace(/[–—]\uFFFD*\s*\uFFFD*A\s/g, match => match.toLowerCase())
        .replace(/([\u{FFFD}\p{L}\p{N}\p{No}]+([\u{FFFD}\p{L}\p{N}\p{No}\p{Pc}]*))|(\s(\p{Lu}+[.]){2,})?/ug, function (word) {
            const offset = arguments[arguments.length - 2];
            const fullString = arguments[arguments.length - 1];

            // "Appendix A", "Section IV", "Table S1", "Vol. A.1", etc. - the
            // token right after one of these is a division label/code, not
            // an English word, so leave it exactly as typed regardless of
            // any of the rules below (this runs before the allcaps check too,
            // since otherwise an all-caps title would still lowercase it)
            if (isSectionLabel(fullString, offset)) {
                return word;
            }

            const unmasked = word.replace(/\uFFFD/g, '');
            if (unmasked.length === 1) {
                // single-letter words (the pronoun "I", roman numerals,
                // section/appendix/volume letters like the "B" in
                // "Appendix B") stay capitalized no matter the casing mode -
                // except "A", which is always lowercase mid-title (this
                // check runs before the allcaps branch below, since that
                // branch would otherwise blindly lowercase every word,
                // including these)
                if (unmasked.toUpperCase() === 'A') return word.toLowerCase();
                return allcaps ? word.toUpperCase() : word;
            }
            if (allcaps) return word.toLowerCase();
            if (unmasked.match(/.\p{Lu}/u)) {
                return word;
            }
            if (unmasked.match(/^\p{L}\p{L}*[\p{N}\p{No}][\p{L}\p{N}\p{No}]*$/u) || unmasked.match(/^[\p{Lu}\p{N}\p{No}]+$/u)) {
                return word;
            }
            return word.toLowerCase();
        });

    for (const { start, end, text: replacement } of preserve) {
        const chunk = replacement !== undefined ? replacement : text.substring(start, end);
        masked = masked.substring(0, start) + chunk + masked.substring(end);
    }

    return masked;
}

// sentence-case wrapper matching the original standalone script's behavior:
// also force-capitalize the first letter after a colon (handles cases the
// core sentenceCase() sub-sentence-start regex might not catch cleanly)
function applySentenceCase(text) {
    let cased = sentenceCase(text);
    cased = cased.replace(/(:\s+)((?:['"“‘„«¡¿]*))([a-z])/g,
        (match, sep, punct, letter) => sep + punct + letter.toUpperCase());
    return cased;
}

// trim leading/trailing whitespace and collapse any run of whitespace
// (2+ spaces, tabs, etc.) down to a single space
function cleanWhitespace(text) {
    return text.trim().replace(/\s+/g, " ");
}

// insert a space after a colon when it's missing before the next word, e.g.
// "Chapter 36:the effects" -> "Chapter 36: the effects" (only triggers when
// the colon is directly followed by a letter, so times like "3:30" and
// URLs like "http://" are left alone)
function insertSpaceAfterColon(text) {
    return text.replace(/:(?=\p{L})/gu, ": ");
}

// remove stray whitespace just inside parentheses, e.g.
// "( <i>Escherichia coli</i> )" -> "(<i>Escherichia coli</i>)"
function trimParenSpaces(text) {
    return text.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

// drop trailing period(s) at the very end of the title (titles shouldn't end
// with one), but leave a genuine ellipsis ("..." or more) alone
function stripTerminalPeriod(text) {
    const match = text.match(/\.+$/);
    if (!match || match[0].length >= 3) return text;
    return text.slice(0, -match[0].length);
}

function normalizeTitle(text) {
    let cleaned = cleanWhitespace(text);
    cleaned = trimParenSpaces(cleaned);
    cleaned = insertSpaceAfterColon(cleaned);
    cleaned = stripTerminalPeriod(cleaned);
    return cleaned;
}

// process a single field on an item with a given casing function;
// returns 'updated', 'skipped', or 'error'
async function processField(targetItem, fieldName, caseFn) {
    let original;
    try {
        original = targetItem.getField(fieldName);
    } catch (e) {
        return "skipped";
    }
    if (!original) {
        return "skipped";
    }

    try {
        const cased = restoreTaxonomicParens(restoreProperNouns(caseFn(normalizeTitle(original))));
        if (cased !== original) {
            targetItem.setField(fieldName, cased);
            await targetItem.save();
            return "updated";
        }
        return "skipped";
    } catch (e) {
        Zotero.logError(`Clean Titles error on item ${targetItem.id}, field "${fieldName}": ${e}`);
        return "error";
    }
}

(async () => {
    let targetItems = items || (item ? [item] : []);
    if (!targetItems.length) {
        return;
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    await Zotero.DB.executeTransaction(async function () {
        for (const targetItem of targetItems) {
            const itemTypeName = Zotero.ItemTypes.getName(targetItem.itemTypeID);

            // "title" field: Title Case for book/thesis/report, Sentence Case
            // for everything else (journal articles, book section titles, etc.)
            const titleCaser = TITLE_CASE_TYPES.has(itemTypeName) ? titleCase : applySentenceCase;
            const titleResult = await processField(targetItem, "title", titleCaser);
            if (titleResult === "updated") updated++;
            else if (titleResult === "error") errors++;
            else skipped++;

            // "bookTitle" field only exists on bookSection - the name of the
            // book it's a chapter of - and always gets Title Case
            if (itemTypeName === "bookSection") {
                const bookTitleResult = await processField(targetItem, "bookTitle", titleCase);
                if (bookTitleResult === "updated") updated++;
                else if (bookTitleResult === "error") errors++;
                else skipped++;
            }
        }
    });

    Zotero.alert(null, "Clean Titles",
        `Updated ${updated} field(s). Skipped ${skipped}.${errors ? ` Errors: ${errors} (check error console).` : ""}`);
})();
