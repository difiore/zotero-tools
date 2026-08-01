const Zotero = require("Zotero");

// This script fires once per SELECTED ITEM (not once for the whole
// selection), using only the `item`/`items` variables Actions & Tags injects.
// Since there's no direct signal for when the last per-item invocation of a
// multi-select trigger has arrived, invocations are collected into a
// short-lived batch: each invocation adds its item(s) to the current batch
// and (re)starts a short COLLECT_WINDOW_MS timer, which comfortably bridges
// the back-to-back burst of per-item calls without adding noticeable delay.
// COLLECT_WINDOW_MAX_MS is a hard cap measured from the first item's
// arrival, so a batch can't keep growing indefinitely.
//
// Once the window closes, the whole batch is processed in one pass: one mode
// prompt (which also carries a show-pages checkbox, see promptForRenameMode),
// then one paginated sequence of progress windows, then one summary alert
// (see showPagedResults). A separate "processing" flag - not a timer - locks
// out new triggers for the ENTIRE pass, through the final summary alert being
// dismissed, not just the renaming itself. This is required because
// Zotero.alert() is modal/blocking; letting a second invocation's rename
// work or its own alert() run while a first invocation's alert() is still up
// causes real Zotero hangs. Zotero.ProgressWindow is non-modal and safe to
// have several open at once, so only the alert() tail actually needs
// serializing - but since it's used at all, only one invocation may be
// mid-flight at a time.
const COLLECT_WINDOW_MS = 150;
const COLLECT_WINDOW_MAX_MS = 2000;

// Results are split into pages of PROGRESS_PAGE_SIZE lines (renamed files,
// then errors), each shown in its own normally-sized Zotero.ProgressWindow
// for PROGRESS_PAGE_DISPLAY_MS before the next page appears. Every page,
// including the last, closes on the same timer - see showPagedResults for
// the modal summary alert shown once the last page closes, which is what
// actually gives the user a chance to read the final counts.
const PROGRESS_PAGE_SIZE = 15;
const PROGRESS_PAGE_DISPLAY_MS = 2500;

// Hard ceiling on how many pages a single invocation will ever display, so a
// genuinely pathological batch (e.g. force-renaming an entire multi-thousand
// item library in one go) can't turn into an unattended slideshow running
// for many minutes. Past this many pages, everything beyond the cutoff is
// rolled into a single "...and N more renamed"/"...and N more error(s)"
// pair of lines appended to the final page instead of being paginated
// individually.
const MAX_PROGRESS_PAGES = 30;

// Headline for the "still in progress" notice (see runInvocation). Must
// stay distinct from any real page/summary headline (which is always
// "Rename Attachments", optionally with a "(page X of Y)" suffix) so
// findProgressChromeWindow can never confuse the notice window with an
// actual result window.
const STILL_IN_PROGRESS_HEADLINE = "Rename Attachments — Please Wait";

// Builds a short "Author(s) Year" label for an item, for identifying it in
// the error list. Falls back to just the author(s) or year alone if only
// one is available, then to the title, since not every item type/entry has
// both fields populated.
function getItemLabel(zItem) {
    if (!zItem) return null;
    try {
        const creator = zItem.getField('firstCreator');
        const year = zItem.getField('year');
        if (creator && year) return `${creator} ${year}`;
        if (creator) return creator;
        if (year) return String(year);
        const title = zItem.getField('title');
        if (title) return title;
    } catch (e) {
        // fall through to null below
    }
    return null;
}

// Per-invocation visual feedback is a sequence of Zotero.ProgressWindow
// pages, shown after the actual rename work completes and auto-advancing on
// their own (see PROGRESS_PAGE_SIZE / PROGRESS_PAGE_DISPLAY_MS above, and
// showPagedResults below for the implementation). Two notes on
// ProgressWindow itself: (1) it's a non-modal notification with no reliable
// "user explicitly dismissed it" signal, so pages close on a timer instead
// of needing a click; (2) by default every ItemProgress line sits at 50%
// opacity until .setProgress(100) is called, and its constructor's first
// argument is a Zotero item-type string (resolved to a built-in CSS icon),
// not an icon URL.
//
// Each invocation gets its own fully self-contained page sequence and final
// summary - pages are never shared or reused across separate triggerings of
// the script.

// Small promise-based delay helper, used to space out paginated progress
// windows by PROGRESS_PAGE_DISPLAY_MS.
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Finds the real chrome window behind a Zotero.ProgressWindow instance,
// matched by its document (progressWindow.xhtml) and its current headline
// text (Zotero.ProgressWindow doesn't expose the chrome window as a public
// property). Used only to read/set plain window position and size
// (screenX/screenY/outerWidth/outerHeight, moveTo(), resizeTo()) - not to
// reach into its internal DOM/CSS.
function findProgressChromeWindow(headlineText) {
    try {
        if (typeof Services === "undefined" || !Services.wm) return null;
        const winEnum = Services.wm.getEnumerator(null);
        while (winEnum.hasMoreElements()) {
            const win = winEnum.getNext();
            let href = "";
            try {
                href = win.location.href;
            } catch (e) {
                continue;
            }
            if (!href.includes("progressWindow.xhtml")) continue;
            try {
                const doc = win.document;
                const headline = doc.getElementById("zotero-progress-text-headline");
                const label = headline && headline.querySelector("label");
                const value = label && label.getAttribute("value");
                if (value === headlineText) return win;
            } catch (e) {
                // keep looking at other candidate windows
            }
        }
    } catch (e) {
        Zotero.logError(`Rename Attachments: findProgressChromeWindow failed: ${e}`);
    }
    return null;
}

// Retries findProgressChromeWindow briefly, since the window is created
// asynchronously and may not be enumerable by Services.wm the instant
// pw.show() returns.
async function findProgressChromeWindowWithRetry(headlineText, attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 10;
    const win = findProgressChromeWindow(headlineText);
    if (win) return win;
    if (attemptsLeft <= 0) return null;
    await sleep(50);
    return findProgressChromeWindowWithRetry(headlineText, attemptsLeft - 1);
}

// Centers a ProgressWindow's real chrome window over Zotero's main window
// via moveTo(), so it reads more like "a dialog in the main window" than a
// toast off to the side. Best-effort: fails quietly if Zotero.getMainWindow()
// or its window properties are unavailable.
function centerWindowOverMain(chromeWin) {
    try {
        const mainWin = Zotero.getMainWindow();
        if (!mainWin || typeof mainWin.screenX !== "number") return;
        const x = mainWin.screenX + (mainWin.outerWidth - chromeWin.outerWidth) / 2;
        const y = mainWin.screenY + (mainWin.outerHeight - chromeWin.outerHeight) / 2;
        chromeWin.moveTo(Math.round(x), Math.round(y));
    } catch (e) {
        // best-effort only - worst case it stays wherever Zotero put it
    }
}

// Force-closes every currently-open progress window belonging to this
// script (any headline starting with "Rename Attachments" - covers page
// headlines and the still-in-progress notice alike). Called right after a
// summary alert is dismissed, as a direct cleanup sweep for any window whose
// own close timer hasn't fired yet.
function closeAllRenameProgressWindows() {
    try {
        if (typeof Services === "undefined" || !Services.wm) return;
        const winEnum = Services.wm.getEnumerator(null);
        while (winEnum.hasMoreElements()) {
            const win = winEnum.getNext();
            let href = "";
            try {
                href = win.location.href;
            } catch (e) {
                continue;
            }
            if (!href.includes("progressWindow.xhtml")) continue;
            try {
                const doc = win.document;
                const headline = doc.getElementById("zotero-progress-text-headline");
                const label = headline && headline.querySelector("label");
                const value = label && label.getAttribute("value");
                if (typeof value === "string" && value.startsWith("Rename Attachments")) {
                    win.close();
                }
            } catch (e) {
                // keep sweeping other candidate windows
            }
        }
    } catch (e) {
        Zotero.logError(`Rename Attachments: closeAllRenameProgressWindows failed: ${e}`);
    }
}

// Builds and displays this invocation's full result as a sequence of
// Zotero.ProgressWindow pages, followed by one modal summary alert.
// processBatch awaits this fully before returning, so the processing lock
// stays held through the alert (see the top-of-file comment for why). Any
// error here is still caught and logged rather than thrown, so a display
// failure can't itself leave the processing lock stuck on.
//
// Every page - including the last - is shown for exactly
// PROGRESS_PAGE_DISPLAY_MS and then closes on its own via startCloseTimer().
// Once every page has faded, a single modal Zotero.alert() shows the real
// summary (`finalSummary`), giving a reliable, must-be-dismissed place to
// see the final counts regardless of how many pages came before it.
//
// `renameEntries` is an array of { iconType, text } built in processRenaming
// for each file actually renamed. `errorLabels` is a flat array of
// per-error item labels. `headlineBase` is the base title ("Rename
// Attachments"), used as-is when there's only one page, or suffixed with
// "(page X of Y)" when there's more than one. `finalSummary` is the
// fully-formed summary text (counts, and a pointer to the error console if
// there were errors) shown in the trailing alert.
async function showPagedResults(renameEntries, errorLabels, headlineBase, finalSummary) {
    // Each page is either a run of successful renames or a run of errors -
    // kept as separate pages (rather than interleaving the two kinds within
    // one page) so a page's items can all be drawn the same way (normal
    // line vs. red error line) without extra bookkeeping.
    const pages = [];
    for (let i = 0; i < renameEntries.length; i += PROGRESS_PAGE_SIZE) {
        pages.push({ kind: 'rename', items: renameEntries.slice(i, i + PROGRESS_PAGE_SIZE) });
    }
    for (let i = 0; i < errorLabels.length; i += PROGRESS_PAGE_SIZE) {
        pages.push({ kind: 'error', items: errorLabels.slice(i, i + PROGRESS_PAGE_SIZE) });
    }

    if (pages.length === 0) {
        // Nothing renamed and nothing errored - processBatch already
        // handles "nothing happened at all" via a plain alert before ever
        // calling this, so this shouldn't normally be reached, but bail
        // cleanly either way.
        return;
    }

    // Cap total pages (see MAX_PROGRESS_PAGES) - fold anything beyond the
    // cutoff into two summary counts appended to the final shown page,
    // rather than displaying every single one.
    let overflowRenamed = 0;
    let overflowErrors = 0;
    if (pages.length > MAX_PROGRESS_PAGES) {
        const overflowPages = pages.splice(MAX_PROGRESS_PAGES);
        for (const page of overflowPages) {
            if (page.kind === 'rename') overflowRenamed += page.items.length;
            else overflowErrors += page.items.length;
        }
    }

    // { x, y, width, height } of the first page's real chrome window, once
    // Zotero has sized it to fit that page's content. Every non-last page
    // after the first is forced to exactly this rect via resizeTo()+moveTo()
    // so pages line up despite small height variance from Zotero's own
    // sizeToContent(). The last page is exempt from size-matching (it
    // usually has fewer, "leftover" lines) - it only gets its bottom-left
    // corner aligned to the shared anchor, keeping its own natural height.
    let anchorRect = null;

    // Reference to the previous page's ProgressWindow, re-armed (via
    // startCloseTimer(1)) right before the next page opens or the final
    // alert appears - a defensive nudge to make sure it actually closes
    // after being repositioned/resized above.
    let previousPw = null;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const isLastPage = pageIndex === pages.length - 1;
        const headlineText = pages.length > 1
            ? `${headlineBase} (page ${pageIndex + 1} of ${pages.length})`
            : headlineBase;

        if (previousPw) {
            try {
                previousPw.startCloseTimer(1);
            } catch (e) {
                // ignore - worst case that one page lingers
            }
            previousPw = null;
        }

        try {
            const pw = new Zotero.ProgressWindow({ closeOnClick: false });
            pw.changeHeadline(headlineText);
            pw.show();

            for (const entry of page.items) {
                if (page.kind === 'rename') {
                    const line = new pw.ItemProgress(entry.iconType, entry.text);
                    line.setProgress(100);
                } else {
                    const line = new pw.ItemProgress(null, `Error: ${entry}`);
                    line.setError();
                }
            }

            if (isLastPage) {
                if (overflowRenamed > 0) {
                    const line = new pw.ItemProgress(null, `...and ${overflowRenamed} more renamed`);
                    line.setProgress(100);
                }
                if (overflowErrors > 0) {
                    const line = new pw.ItemProgress(null, `...and ${overflowErrors} more error(s)`);
                    line.setProgress(100);
                }
            }

            // Match this page's position (and, except on the last page,
            // size) to the shared anchor, now that all of this page's lines
            // are in and Zotero has sized the window to fit them.
            const chromeWin = await findProgressChromeWindowWithRetry(headlineText);
            if (chromeWin) {
                try {
                    if (isLastPage && pages.length > 1 && anchorRect) {
                        // Exempt from size-matching (see anchorRect's
                        // comment) - just line up its bottom-left corner
                        // with everyone else's, keeping its own height.
                        chromeWin.moveTo(anchorRect.x, anchorRect.y + anchorRect.height - chromeWin.outerHeight);
                    } else if (!anchorRect) {
                        // First page shown (which, if there's only one page
                        // total, is also the last - nothing to match it to
                        // either way, so just remember its rect and move on).
                        anchorRect = {
                            x: chromeWin.screenX,
                            y: chromeWin.screenY,
                            width: chromeWin.outerWidth,
                            height: chromeWin.outerHeight,
                        };
                    } else {
                        // A non-last page after the first - force it to
                        // exactly match the first page's rect.
                        chromeWin.resizeTo(anchorRect.width, anchorRect.height);
                        chromeWin.moveTo(anchorRect.x, anchorRect.y);
                    }
                } catch (e) {
                    // best-effort only - a misaligned/mismatched window is
                    // cosmetic, not worth failing the display over
                }
            }

            // Same close timer for every page, last one included.
            pw.startCloseTimer(PROGRESS_PAGE_DISPLAY_MS);
            previousPw = pw;
        } catch (e) {
            Zotero.logError(`Rename Attachments: showPagedResults failed on page ${pageIndex + 1}/${pages.length}: ${e}`);
            // Move on to the next page rather than aborting the whole
            // sequence over one page's display failure.
        }

        // Paces the next page's appearance to roughly coincide with this
        // one's close timer firing - and, on the last page, is what's
        // waited on before the trailing summary alert appears below.
        await sleep(PROGRESS_PAGE_DISPLAY_MS);
    }

    // Re-arm the last page's close timer too, then briefly yield so it
    // actually fires and settles before the modal alert below opens.
    if (previousPw) {
        try {
            previousPw.startCloseTimer(1);
        } catch (e) {
            // ignore
        }
        await sleep(50);
    }

    // All pages have been shown and faded - now put up the one thing that
    // actually has to be dismissed, so the final counts don't just vanish
    // along with the last page.
    Zotero.alert(null, headlineBase, finalSummary);
    // Sweep up anything of ours still open once OK is clicked - see
    // closeAllRenameProgressWindows.
    closeAllRenameProgressWindows();
}

// Asks the user whether to rename only files that actually need it, or force
// a rename of every eligible PDF/EPUB regardless (useful since Zotero often
// already auto-renames attachments on import, so "only if needed" can end up
// doing nothing) - AND, via the same dialog's checkbox, whether they want to
// see each renamed file paged through afterward or just jump straight to the
// final summary. Tries a native two-button dialog with a checkbox first,
// falls back to a plain text prompt (asking the paging question separately,
// since a plain prompt has no checkbox). Returns { mode: "onlyIfNeeded" |
// "forceAll", showPages: boolean }, or null if cancelled.
//
// confirmEx's checkMsg/checkState params always render the checkbox between
// the message text and the button row (a fixed part of the native dialog
// layout), defaulting to unchecked (checkState = { value: false }).
function promptForRenameMode(win) {
    try {
        if (typeof Services !== "undefined" && Services.prompt && Services.prompt.confirmEx) {
            // Button *position* constants (POS_0/1/2) don't map to a fixed
            // left-to-right screen order - the platform's dialog toolkit can
            // reorder them (e.g. to follow the local "primary action on the
            // right" convention), so which position ends up where is
            // empirical rather than something this script can dictate
            // directly. On this setup, POS_0 renders rightmost and POS_2
            // renders leftmost, so Force Rename goes on POS_0 (also the
            // default button, since BUTTON_POS_0_DEFAULT is the no-op/default
            // case - no extra flag needed) and Cancel goes on POS_2.
            const flags =
                Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_CANCEL;
            const checkState = { value: false };
            const choice = Services.prompt.confirmEx(
                win,
                "Rename Attachments",
                "Rename only files that need it, or force rename all eligible files?",
                flags,
                "Force Rename",
                "Only If Needed",
                null,
                "Show each renamed file before the summary",
                checkState
            );
            if (choice === 0) return { mode: "forceAll", showPages: checkState.value };
            if (choice === 1) return { mode: "onlyIfNeeded", showPages: checkState.value };
            return null;
        }
    } catch (e) {
        // fall through to the plain-prompt fallback below
    }

    const answer = win.prompt(
        'Rename Attachments\n\nType "needed" to rename only files that need it, or "force" to force rename all eligible files:'
    );
    if (answer === null) return null;
    const normalized = answer.trim().toLowerCase();
    let mode = null;
    if (normalized === "needed" || normalized === "n") mode = "onlyIfNeeded";
    if (normalized === "force" || normalized === "f") mode = "forceAll";
    if (!mode) return null;

    // The plain-prompt fallback has no checkbox to work with, so ask a
    // second, equally plain question rather than silently dropping the
    // choice. Defaults to skipping pages (same default as the checkbox
    // above) on anything other than an explicit "yes".
    const pagesAnswer = win.prompt(
        'Show each renamed file individually before the summary?\nType "yes" to page through them, or leave blank for just the summary:'
    );
    const showPages = !!(pagesAnswer && /^y/i.test(pagesAnswer.trim()));
    return { mode, showPages };
}

// Function to process renaming of each attachment. `isPrimary` indicates
// whether this is the *first* PDF/EPUB attachment on its parent item.
// Zotero's own convention: only the first PDF/EPUB has its file renamed and
// gets a simple "PDF"/"EPUB" title; any additional PDF/EPUB on the same item
// is left alone on disk and titled from its filename instead, so multiple
// PDFs on one item can still be told apart (and don't collide on the same
// generated filename). `forceAll` bypasses the "already correctly named, so
// skip it" check for the primary PDF/EPUB - it does NOT affect the
// primary/secondary distinction itself, since that's a data-safety measure
// (avoiding a filename collision), not a convenience one.
//
// On a successful rename, the returned result includes a `renameEntry` -
// { iconType, text } - describing that one line for display. It's built
// here but not shown here: renameEntry values are collected by processBatch
// and handed to showPagedResults only once every attachment has been
// processed.
async function processRenaming(attachment, processedAttachmentIds, isPrimary, forceAll) {
    if (!attachment || processedAttachmentIds.has(attachment.id)) {
        // Skip processing if attachment is undefined or already processed
        return { renamed: 0, skipped: 0, errors: 0 };
    }

    if (attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        // parentItemID may still be set even for a linked-URL attachment, so
        // try to label the error with the parent item rather than just the
        // attachment's internal ID
        let label = null;
        if (attachment.parentItemID) {
            label = getItemLabel(await Zotero.Items.getAsync(attachment.parentItemID));
        }
        label = label || `Attachment ${attachment.id}`;
        Zotero.logError(`Cannot rename linked URL attachment ${attachment.id}.`);
        return { renamed: 0, skipped: 0, errors: 1, errorLabel: label };
    }

    if (!attachment.parentItemID) {
        Zotero.logError(`Attachment ${attachment.id} does not have a parent item.`);
        return { renamed: 0, skipped: 0, errors: 1, errorLabel: `Attachment ${attachment.id}` };
    }

    const parentItem = await Zotero.Items.getAsync(attachment.parentItemID);
    if (!parentItem) {
        Zotero.logError(`No parent item found for attachment ${attachment.id}.`);
        return { renamed: 0, skipped: 0, errors: 1, errorLabel: `Attachment ${attachment.id}` };
    }

    const currentPath = await attachment.getFilePathAsync();
    if (!currentPath) {
        Zotero.logError(`No local file path available for attachment ${attachment.id}.`);
        return { renamed: 0, skipped: 0, errors: 1, errorLabel: getItemLabel(parentItem) || `Attachment ${attachment.id}` };
    }

    processedAttachmentIds.add(attachment.id);

    const newBaseName = Zotero.Attachments.getFileBaseNameFromItem(parentItem);
    const currentName = currentPath.split(/(\\|\/)/g).pop();
    const extension = currentName.includes('.') ? currentName.split('.').pop() : '';
    // compare the FULL filename (base name + extension) against the current
    // filename - comparing against just the base name (as before) would
    // almost never match, since currentName always includes the extension,
    // causing every PDF/EPUB to get "renamed" on every run even when it
    // already had the correct name
    const finalName = extension ? `${newBaseName}.${extension}` : newBaseName;
    const isRenamableType = extension.toUpperCase() === "PDF" || extension.toUpperCase() === "EPUB";

    try {
        if (isRenamableType && isPrimary) {
            // only the FIRST PDF/EPUB on an item actually gets its file
            // renamed. This matches Zotero's own default behavior ("if an
            // item already has an attachment, additional files will not be
            // automatically renamed") - a second PDF would otherwise be
            // renamed to the exact same base name as the first (since the
            // name comes from the parent item's citation info, not anything
            // attachment-specific), colliding with it on disk.
            const alreadyCorrect = finalName === currentName;
            if (alreadyCorrect && !forceAll) {
                if (attachment.getField('title') !== extension.toUpperCase()) {
                    attachment.setField('title', extension.toUpperCase());
                    await attachment.saveTx();
                }
                return { renamed: 0, skipped: 1, errors: 0 };
            }
            // Either the name genuinely needs to change, or the user chose
            // "force rename all" - in which case we (re)apply the rename
            // even if it looks already correct. That's the whole point of
            // the force option: Zotero often already auto-renames on
            // import, so "only if needed" can end up doing nothing even
            // when you actually want the operation re-applied.
            await attachment.renameAttachmentFile(finalName);
            attachment.setField('title', extension.toUpperCase());
            await attachment.saveTx();

            let iconType = null;
            try {
                if (typeof attachment.getItemTypeIconName === "function") {
                    iconType = attachment.getItemTypeIconName();
                }
            } catch (e) {
                iconType = null;
            }
            // Shows the actual before -> after transformation when the name
            // really changed; in force mode a file whose name was already
            // correct gets re-applied but doesn't visually change, so it
            // just shows the one name instead of a pointless "X -> X" line.
            const text = (currentName !== finalName) ? `${currentName} → ${finalName}` : finalName;
            return { renamed: 1, skipped: 0, errors: 0, renameEntry: { iconType, text } };
        }

        // either not a renamable type, or a non-primary PDF/EPUB - the file
        // on disk is never touched, but keep the attachment's title field in
        // sync with its actual current filename. Gated on the title actually
        // needing a change so a file that's already in sync counts as
        // skipped instead of being rewritten - and re-saved - on every run.
        // Unaffected by forceAll: force mode is specifically about
        // re-applying the primary attachment's rename, not about touching
        // files that are deliberately left alone for collision-avoidance.
        if (attachment.getField('title') !== currentName) {
            attachment.setField('title', currentName);
            await attachment.saveTx();
        }
        return { renamed: 0, skipped: 1, errors: 0 };
    } catch (error) {
        Zotero.logError(`Error renaming attachment ${attachment.id}: ${error}`);
        return { renamed: 0, skipped: 0, errors: 1, errorLabel: getItemLabel(parentItem) || `Attachment ${attachment.id}` };
    }
}

// Called on every invocation. Just accumulates this invocation's item(s)
// into the current collecting batch (creating one if none is open) and
// (re)arms the short COLLECT_WINDOW_MS timer that eventually hands the whole
// batch to finalizeBatch(). Deliberately does almost no work itself and
// contains no await, so a burst of per-item invocations for one multi-select
// trigger all land here quickly, one after another, without any of them
// waiting on the others.
function runInvocation() {
    if (!items && !item) {
        Zotero.alert(null, "No item or items array provided.");
        return;
    }

    const incomingItems = items || (item ? [item] : []);
    if (incomingItems.length === 0) {
        return;
    }

    if (Zotero.__renameAttachmentsProcessing) {
        // If a "still in progress" notice is already up from an earlier
        // extra trigger, silently ignore this one too rather than stacking
        // a second notice on top of it.
        if (Zotero.__renameAttachmentsNoticeShowing) {
            return;
        }

        // A non-modal Zotero.ProgressWindow notice, not Zotero.alert() or
        // any other real dialog: this can fire while a previous
        // invocation's showPagedResults() page-cycling loop still has
        // pending sleep()/setTimeout continuations in flight, and a modal
        // call at that moment causes a real hang. ProgressWindow is safe to
        // show concurrently with other in-flight async work from this
        // script. It's explicitly centered over the main Zotero window (see
        // centerWindowOverMain) and focused, to read as a proper "pay
        // attention to this" dialog rather than a toast easily missed off
        // to the side.
        const noticeLifetimeMs = PROGRESS_PAGE_DISPLAY_MS * 2;
        Zotero.__renameAttachmentsNoticeShowing = true;
        setTimeout(() => {
            Zotero.__renameAttachmentsNoticeShowing = false;
        }, noticeLifetimeMs);

        try {
            const pw = new Zotero.ProgressWindow({ closeOnClick: false });
            pw.changeHeadline(STILL_IN_PROGRESS_HEADLINE);
            pw.show();
            const line = new pw.ItemProgress(null, "A rename is still in progress. Wait for it to finish, then try again.");
            line.setProgress(100);
            pw.startCloseTimer(noticeLifetimeMs);
            // Fire-and-forget: best-effort centering/focus, nothing else
            // depends on either succeeding.
            findProgressChromeWindowWithRetry(STILL_IN_PROGRESS_HEADLINE)
                .then(chromeWin => {
                    if (!chromeWin) return;
                    centerWindowOverMain(chromeWin);
                    chromeWin.focus();
                    // Zotero's own window tiling (ProgressWindowSet)
                    // repositions every currently-open ProgressWindow -
                    // this notice included - whenever the set of open
                    // windows changes, which happens constantly while
                    // another invocation's page-cycling sequence is still
                    // opening/closing pages in the background. Re-assert
                    // the centered position on a short interval for as long
                    // as the notice is up, rather than a single one-time
                    // moveTo().
                    const reassertInterval = setInterval(() => {
                        try {
                            centerWindowOverMain(chromeWin);
                        } catch (e) {
                            clearInterval(reassertInterval);
                        }
                    }, 400);
                    setTimeout(() => clearInterval(reassertInterval), noticeLifetimeMs);
                })
                .catch(e => Zotero.logError(`Rename Attachments: positioning still-in-progress notice failed: ${e}`));
        } catch (e) {
            Zotero.logError(`Rename Attachments: still-in-progress notice failed: ${e}`);
        }
        return;
    }

    let batch = Zotero.__renameAttachmentsBatch;
    if (!batch) {
        batch = { items: [], firstArrivalAt: Date.now(), timer: null };
        Zotero.__renameAttachmentsBatch = batch;
    }
    batch.items.push(...incomingItems);

    clearTimeout(batch.timer);
    const elapsed = Date.now() - batch.firstArrivalAt;
    const waitMs = Math.max(0, Math.min(COLLECT_WINDOW_MS, COLLECT_WINDOW_MAX_MS - elapsed));
    batch.timer = setTimeout(() => {
        finalizeBatch(batch).catch(e => Zotero.logError(`Rename Attachments: unhandled error in finalizeBatch: ${e}`));
    }, waitMs);
}

// Runs once the collection window closes: hands the batch off to
// processBatch() under the "processing" lock, which stays engaged for the
// ENTIRE pass - prompt, renaming, paginated result windows, and the final
// summary alert - and is released the instant all of that finishes.
async function finalizeBatch(batch) {
    if (Zotero.__renameAttachmentsBatch !== batch) {
        // already handled (shouldn't normally happen - defensive only)
        return;
    }
    Zotero.__renameAttachmentsBatch = null;
    Zotero.__renameAttachmentsProcessing = true;
    try {
        await processBatch(batch.items);
    } finally {
        Zotero.__renameAttachmentsProcessing = false;
    }
}

// Does the actual rename work for one collected batch of items: prompts once
// for the mode, resolves every item down to its attachments, renames them,
// and then kicks off a paginated sequence of progress windows to report the
// result (or shows a plain alert if nothing happened at all).
async function processBatch(rawSelectionItems) {
    // Dedupe by id - a batch can end up with the same item more than once if
    // Zotero's own per-item invocations overlap in some edge case.
    const seenIds = new Set();
    const selectionItems = [];
    for (const it of rawSelectionItems) {
        if (!it || it.id === undefined || seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        selectionItems.push(it);
    }
    if (selectionItems.length === 0) {
        return;
    }

    const win = Zotero.getMainWindow();
    const modeResult = promptForRenameMode(win);
    if (!modeResult) {
        // Cancelled - nothing more to do. The processing lock (set by
        // finalizeBatch before calling this) is released as soon as this
        // function returns, so a cancel never imposes any wait at all.
        return;
    }
    const { mode, showPages } = modeResult;
    const forceAll = mode === "forceAll";

    let processedAttachmentIds = new Set();

    // resolve the selection down to the actual attachments to process
    let targetAttachments = [];
    for (const currentItem of selectionItems) {
        if (currentItem.itemType === 'attachment') {
            targetAttachments.push(currentItem);
        } else {
            const atts = await Zotero.Items.getAsync(currentItem.getAttachments());
            targetAttachments.push(...atts);
        }
    }

    if (targetAttachments.length === 0) {
        return;
    }

    // Per parent item, figure out which attachment is the "primary" (first)
    // PDF and which is the primary (first) EPUB. This is computed from ALL of
    // that parent's attachments - not just the ones you happened to select -
    // so primacy is correct even if you run this on a single attachment
    // directly rather than its parent item. Cached per parent so repeated
    // attachments under the same item don't refetch siblings redundantly.
    //
    // "Primary" = oldest by dateAdded, on the assumption that the main paper
    // PDF is always imported first. This is a fragile heuristic - it's not
    // exactly what Zotero itself uses to pick a "default" attachment (which
    // also factors in URL matching between the attachment and the parent
    // item), and it'll misfire if a later-added file ever ends up with an
    // earlier dateAdded (e.g. after a sync, restore, or manual date edit) -
    // but it matches this workflow, where the main PDF is reliably first.
    const primacyCache = new Map();
    async function getIsPrimary(attachment) {
        const parentId = attachment && attachment.parentItemID;
        if (!parentId) return false;

        if (!primacyCache.has(parentId)) {
            const parentItem = await Zotero.Items.getAsync(parentId);
            const siblings = parentItem ? await Zotero.Items.getAsync(parentItem.getAttachments()) : [];

            // gather type info for every sibling first, since we need to
            // sort by date before deciding which one "wins" per type
            const candidates = [];
            for (const sibling of siblings) {
                if (!sibling || sibling.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
                    continue;
                }
                const path = await sibling.getFilePathAsync();
                if (!path) continue;
                const name = path.split(/(\\|\/)/g).pop();
                const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
                if (ext === 'PDF' || ext === 'EPUB') {
                    candidates.push({ sibling, ext });
                }
            }

            // oldest first
            candidates.sort((a, b) => new Date(a.sibling.dateAdded + "Z") - new Date(b.sibling.dateAdded + "Z"));

            const seenTypes = new Set();
            const map = new Map();
            for (const { sibling, ext } of candidates) {
                if (!seenTypes.has(ext)) {
                    seenTypes.add(ext);
                    map.set(sibling.id, true);
                } else {
                    map.set(sibling.id, false);
                }
            }
            primacyCache.set(parentId, map);
        }

        return primacyCache.get(parentId).get(attachment.id) ?? false;
    }

    let renamed = 0;
    let skipped = 0;
    let errors = 0;
    let errorLabels = [];
    let renameEntries = [];
    for (const attachment of targetAttachments) {
        const isPrimary = attachment ? await getIsPrimary(attachment) : false;
        const result = await processRenaming(attachment, processedAttachmentIds, isPrimary, forceAll);
        renamed += result.renamed;
        skipped += result.skipped;
        errors += result.errors;
        if (result.errors && result.errorLabel) {
            errorLabels.push(result.errorLabel);
        }
        if (result.renameEntry) {
            renameEntries.push(result.renameEntry);
        }
    }

    const summary = (renamed === 0 && errors === 0)
        ? `Nothing to rename. All ${skipped} attachment(s) already up to date.`
        : `Renamed ${renamed} attachment(s). Skipped ${skipped}.${errors ? ` Errors: ${errors} (see below; also check error console for details).` : ""}`;

    // The actual rename WORK is done at this point, but everything below -
    // the paginated result windows and the final summary alert - is
    // deliberately still AWAITED before this function returns, so the
    // "processing" lock (released by finalizeBatch's `finally` the instant
    // processBatch resolves) stays held until the whole thing, alert
    // included, is done.
    const headlineBase = "Rename Attachments";

    if (renameEntries.length === 0 && errorLabels.length === 0) {
        // Nothing was renamed and nothing errored - "only if needed" with
        // truly nothing to do. A plain, consistently-sized alert is clearer
        // here than opening a progress window just to say nothing happened.
        Zotero.alert(null, headlineBase, summary);
        closeAllRenameProgressWindows();
        return;
    }

    if (!showPages) {
        // User unchecked "show each renamed file before the summary" in the
        // mode dialog - skip the paginated display and go straight to the
        // same modal summary alert showPagedResults would have shown at the
        // end anyway.
        Zotero.alert(null, headlineBase, summary);
        closeAllRenameProgressWindows();
        return;
    }

    try {
        await showPagedResults(renameEntries, errorLabels, headlineBase, summary);
    } catch (e) {
        Zotero.logError(`Rename Attachments: unhandled error in showPagedResults: ${e}`);
    }
}

// Run this invocation directly - no queue needed. runInvocation() itself is
// synchronous and side-effect-light (just batch bookkeeping and a timer), so
// there's nothing for a promise chain to serialize; the actual rename work
// only ever runs inside finalizeBatch(), which is already guarded by the
// __renameAttachmentsProcessing lock above.
runInvocation();
