const Zotero = require("Zotero");

// trim leading/trailing whitespace and collapse any run of whitespace
// (2+ spaces, tabs, etc.) down to a single space
function cleanWhitespace(text) {
    return text.trim().replace(/\s+/g, " ");
}

// Matches a run of one-or-more "initial units" glued together with no space
// between them (e.g. "I.M." or "H.-I.M."), where each unit is a single
// uppercase letter (optionally followed by a period), optionally chained to
// further single letters via hyphens (e.g. "H.-I."). Guarded with a
// lookbehind/lookahead so it never matches the start of an ordinary
// multi-letter word like "Robin", "Ian", "Camacho", or "Hernandez" - those
// contain lowercase letters, which immediately break the match, so compound
// names ("Juan Carlos", "Camacho-Hernandez", "Camacho Hernandez") are safe
// and left untouched regardless of anything else in this script.
const INITIAL_RUN_RE = /(?<![\p{L}])(?:\p{Lu}\.?(?:-\p{Lu}\.?)*)+(?![\p{Ll}])/gu;

// splits a matched run into its constituent units (a lone initial, or a
// hyphen-chain of initials that should stay joined)
const UNIT_RE = /\p{Lu}\.?(?:-\p{Lu}\.?)*/gu;

// formats one unit per mode - e.g. "H.-I." -> "H-I" (remove) or "H.-I." (add);
// hyphens are always preserved, only the periods are added/stripped
function formatUnit(unit, mode) {
    const letters = unit.split("-").map(part => part.replace(/\./g, ""));
    const formatted = letters.map(letter => (mode === "add" ? `${letter}.` : letter));
    return formatted.join("-");
}

// normalize all initials in a name string.
// allowBareRuns: when true, a bare run of 2+ plain capital letters with no
// periods/hyphens (e.g. "RIM") is treated as jammed-together initials and
// split up. When false, such a run is left untouched because it's too
// ambiguous with a real acronym/organization name.
function normalizeInitials(text, mode, allowBareRuns) {
    if (!text) return text;
    let cleaned = cleanWhitespace(text);

    cleaned = cleaned.replace(INITIAL_RUN_RE, run => {
        const hasPeriod = run.includes(".");
        const hasHyphen = run.includes("-");
        const letterCount = (run.match(/\p{Lu}/gu) || []).length;
        const isAmbiguousBareRun = !hasPeriod && !hasHyphen && letterCount > 1;
        if (isAmbiguousBareRun && !allowBareRuns) {
            return run;
        }
        const units = run.match(UNIT_RE) || [run];
        return units.map(u => formatUnit(u, mode)).join(" ");
    });

    return cleanWhitespace(cleaned);
}

// Ask the user whether to add or remove periods. Tries a native two-button
// dialog first; if that API isn't available in this script's environment,
// falls back to a plain text prompt. Returns "add", "remove", or null
// (user cancelled / gave no usable answer).
function promptForMode(win) {
    try {
        if (typeof Services !== "undefined" && Services.prompt && Services.prompt.confirmEx) {
            const flags =
                Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_CANCEL;
            const choice = Services.prompt.confirmEx(
                win,
                "Clean Creator Initials",
                "Add periods after initials, or remove them?",
                flags,
                "Add Periods",
                "Remove Periods",
                null,
                null,
                {}
            );
            if (choice === 0) return "add";
            if (choice === 1) return "remove";
            return null;
        }
    } catch (e) {
        // fall through to the plain-prompt fallback below
    }

    const answer = win.prompt(
        'Clean Creator Initials\n\nType "add" to add periods after initials, or "remove" to strip them:'
    );
    if (answer === null) return null;
    const normalized = answer.trim().toLowerCase();
    if (normalized === "add" || normalized === "a") return "add";
    if (normalized === "remove" || normalized === "r") return "remove";
    return null;
}

(async () => {
    let targetItems = items || (item ? [item] : []);
    if (!targetItems.length) {
        return;
    }

    const win = Zotero.getMainWindow();
    const mode = promptForMode(win);
    if (!mode) {
        return;
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    await Zotero.DB.executeTransaction(async function () {
        for (const targetItem of targetItems) {
            let creators;
            try {
                creators = targetItem.getCreators();
            } catch (e) {
                skipped++;
                continue;
            }
            if (!creators || !creators.length) {
                skipped++;
                continue;
            }

            try {
                let changed = false;
                for (const creator of creators) {
                    if (creator.fieldMode === 1) {
                        // single-field (unsplit) creator - the whole name
                        // lives in lastName, firstName is unused. Keep the
                        // conservative guard here since this field commonly
                        // holds organization names (acronyms like "IBM" or
                        // "NASA" must not get split into initials).
                        const cleaned = normalizeInitials(creator.lastName, mode, /* allowBareRuns */ false);
                        if (cleaned !== creator.lastName) {
                            creator.lastName = cleaned;
                            changed = true;
                        }
                    } else {
                        // two-field creator's firstName - loosened guard, so
                        // a bare jammed run like "RIM" also gets split into
                        // initials. Note: this can't distinguish that from an
                        // all-caps real name typed by mistake (e.g. "JUAN"),
                        // which would also get split - a rare edge case, but
                        // worth knowing.
                        const cleaned = normalizeInitials(creator.firstName, mode, /* allowBareRuns */ true);
                        if (cleaned !== creator.firstName) {
                            creator.firstName = cleaned;
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    targetItem.setCreators(creators);
                    await targetItem.save();
                    updated++;
                } else {
                    skipped++;
                }
            } catch (e) {
                Zotero.logError(`Clean Creator Initials error on item ${targetItem.id}: ${e}`);
                errors++;
            }
        }
    });

    Zotero.alert(null, `Clean Creator Initials (${mode === "add" ? "Add Periods" : "Remove Periods"})`,
        `Updated ${updated} item(s). Skipped ${skipped}.${errors ? ` Errors: ${errors} (check error console).` : ""}`);
})();
