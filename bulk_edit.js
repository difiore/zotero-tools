const Zotero = require("Zotero");

// This is a from-scratch rewrite of the original prompt-chain bulk_edit.js,
// switched to the same "real dialog" style as rename-attachments.js /
// clean-creator-initials.js (Zotero.getMainWindow(), Zotero.alert, careful
// defensive fallbacks) instead of the Actions & Tags `window` helper's
// chained window.prompt()/window.confirm() calls.
//
// Since none of Services.prompt.confirmEx / a plain window.prompt() can show
// several live dropdowns at once, this needs a real custom UI. Two earlier
// attempts at that (a data: URI popup, then an about:blank popup written to
// via document.write()) both failed silently - Actions & Tags scripts don't
// get a full, unrestricted window.open() the way a packaged bootstrapped
// plugin would. Rather than shipping this as a full plugin (its own
// manifest.json/bootstrap.js), the dialog is instead built as a floating
// panel injected directly into Zotero's own main window DOM
// (Zotero.getMainWindow().document) - a fixed-position overlay div appended
// right into the existing, already-open, already-guaranteed-to-render
// window, styled to look like a modal. No new window, no postMessage, no
// popup-blocking surface at all: this script already has full privileged
// access to that document, so it just wires up event listeners on the
// injected elements directly. Every element's appearance is set via an
// inline style="..." attribute (not a shared stylesheet - see the STYLE_*
// constants and buildPanel below), since that's what actually renders
// reliably in this XUL-hosted document. See buildPanel/runBulkEditDialog
// below.
//
// The dialog offers two independent actions:
//   1. Change item type - a dropdown of item types + its own Apply button.
//   2. Change a field or creator name - pick a field (including a "Creator:
//      Last Name"/"Creator: First Name" pair), pick one of the DISTINCT
//      current values actually present across the selected items from a
//      dropdown, and type/pick a replacement in a combo box (a plain
//      <input list=...> - native HTML "dropdown + editable text box").
//      Only items whose value for that field exactly matches the chosen
//      current value are changed (this replaces the old
//      wildcard/regex-substring search with an exact pick-from-what's-there
//      model, which is what makes populating current values from the actual
//      selection meaningful).
// Whichever Apply button is clicked determines what happens; the other
// section is ignored for that run.

// Field definitions (unchanged from the original script)
const fields = [
    { "field": "abstractNote", "localized": "Abstract" },
    { "field": "accessDate", "localized": "Accessed Date" },
    { "field": "applicationNumber", "localized": "Application Number" },
    { "field": "archive", "localized": "Archive" },
    { "field": "archiveID", "localized": "Archive ID" },
    { "field": "archiveLocation", "localized": "Location in Archive" },
    { "field": "artworkMedium", "localized": "Artwork Medium" },
    { "field": "artworkSize", "localized": "Artwork Size" },
    { "field": "assignee", "localized": "Assignee" },
    { "field": "audioFileType", "localized": "Audio File Type" },
    { "field": "audioRecordingFormat", "localized": "Audio Format" },
    { "field": "billNumber", "localized": "Bill Number" },
    { "field": "blogTitle", "localized": "Blog Title" },
    { "field": "bookTitle", "localized": "Book Title" },
    { "field": "callNumber", "localized": "Call Number" },
    { "field": "caseName", "localized": "Case Name" },
    { "field": "citationKey", "localized": "Citation Key" },
    { "field": "code", "localized": "Code" },
    { "field": "codeNumber", "localized": "Code Number" },
    { "field": "codePages", "localized": "Code Pages" },
    { "field": "codeVolume", "localized": "Code Volume" },
    { "field": "committee", "localized": "Committee" },
    { "field": "company", "localized": "Company" },
    { "field": "conferenceName", "localized": "Conference Name" },
    { "field": "country", "localized": "Country" },
    { "field": "court", "localized": "Court" },
    { "field": "date", "localized": "Date" },
    { "field": "dateDecided", "localized": "Date Decided" },
    { "field": "dateEnacted", "localized": "Date Enacted" },
    { "field": "dictionaryTitle", "localized": "Dictionary Title" },
    { "field": "distributor", "localized": "Distributor" },
    { "field": "docketNumber", "localized": "Docket Number" },
    { "field": "documentNumber", "localized": "Document Number" },
    { "field": "DOI", "localized": "DOI" },
    { "field": "edition", "localized": "Edition" },
    { "field": "encyclopediaTitle", "localized": "Encyclopedia Title" },
    { "field": "episodeNumber", "localized": "Episode Number" },
    { "field": "extra", "localized": "Extra" },
    { "field": "filingDate", "localized": "Filing Date" },
    { "field": "firstPage", "localized": "First Page" },
    { "field": "format", "localized": "Format" },
    { "field": "forumTitle", "localized": "Forum Title" },
    { "field": "genre", "localized": "Genre" },
    { "field": "history", "localized": "History" },
    { "field": "identifier", "localized": "Identifier" },
    { "field": "institution", "localized": "Institution" },
    { "field": "interviewMedium", "localized": "Interview Medium" },
    { "field": "ISBN", "localized": "ISBN" },
    { "field": "ISSN", "localized": "ISSN" },
    { "field": "issue", "localized": "Issue" },
    { "field": "issueDate", "localized": "Issue Date" },
    { "field": "issuingAuthority", "localized": "Issuing Authority" },
    { "field": "journalAbbreviation", "localized": "Journal Abbreviation" },
    { "field": "label", "localized": "Label" },
    { "field": "language", "localized": "Language" },
    { "field": "legalStatus", "localized": "Legal Status" },
    { "field": "legislativeBody", "localized": "Legislative Body" },
    { "field": "libraryCatalog", "localized": "Library Catalog" },
    { "field": "mapType", "localized": "Map Type" },
    { "field": "manuscriptType", "localized": "Manuscript Type" },
    { "field": "meetingName", "localized": "Meeting Name" },
    { "field": "nameOfAct", "localized": "Name of Act" },
    { "field": "network", "localized": "Network" },
    { "field": "note", "localized": "Note" },
    { "field": "numPages", "localized": "Number of Pages" },
    { "field": "number", "localized": "Number" },
    { "field": "numberOfVolumes", "localized": "Number of Volumes" },
    { "field": "organization", "localized": "Organization" },
    { "field": "pages", "localized": "Pages" },
    { "field": "patentNumber", "localized": "Patent Number" },
    { "field": "place", "localized": "Place" },
    { "field": "postType", "localized": "Post Type" },
    { "field": "presentationType", "localized": "Presentation Type" },
    { "field": "priorityNumbers", "localized": "Priority Numbers" },
    { "field": "proceedingsTitle", "localized": "Proceedings Title" },
    { "field": "programmingLanguage", "localized": "Programming Language" },
    { "field": "programTitle", "localized": "Program Title" },
    { "field": "publicLawNumber", "localized": "Public Law Number" },
    { "field": "publicationTitle", "localized": "Publication Title" },
    { "field": "publisher", "localized": "Publisher" },
    { "field": "references", "localized": "References" },
    { "field": "reportNumber", "localized": "Report Number" },
    { "field": "reportType", "localized": "Report Type" },
    { "field": "reporter", "localized": "Reporter" },
    { "field": "reporterVolume", "localized": "Reporter Volume" },
    { "field": "repository", "localized": "Repository" },
    { "field": "repositoryLocation", "localized": "Repository Location" },
    { "field": "rights", "localized": "Rights" },
    { "field": "runningTime", "localized": "Running Time" },
    { "field": "scale", "localized": "Scale" },
    { "field": "section", "localized": "Section" },
    { "field": "series", "localized": "Series" },
    { "field": "seriesNumber", "localized": "Series Number" },
    { "field": "seriesText", "localized": "Series Text" },
    { "field": "seriesTitle", "localized": "Series Title" },
    { "field": "session", "localized": "Session" },
    { "field": "shortTitle", "localized": "Short Title" },
    { "field": "status", "localized": "Status" },
    { "field": "studio", "localized": "Studio" },
    { "field": "subject", "localized": "Subject" },
    { "field": "system", "localized": "System" },
    { "field": "thesisType", "localized": "Thesis Type" },
    { "field": "title", "localized": "Title" },
    { "field": "university", "localized": "University" },
    { "field": "url", "localized": "URL" },
    { "field": "versionNumber", "localized": "Version" },
    { "field": "videoRecordingFormat", "localized": "Video Recording Format" },
    { "field": "volume", "localized": "Volume" },
    { "field": "websiteTitle", "localized": "Website Title" },
    { "field": "websiteType", "localized": "Website Type" }
];

// Item type definitions (unchanged from the original script)
const itemTypes = [
    { "type": "artwork", "localized": "Artwork" },
    { "type": "audioRecording", "localized": "Audio Recording" },
    { "type": "bill", "localized": "Bill" },
    { "type": "blogPost", "localized": "Blog Post" },
    { "type": "book", "localized": "Book" },
    { "type": "bookSection", "localized": "Book Section" },
    { "type": "case", "localized": "Case" },
    { "type": "computerProgram", "localized": "Software" },
    { "type": "conferencePaper", "localized": "Conference Paper" },
    { "type": "dataset", "localized": "Dataset" },
    { "type": "dictionaryEntry", "localized": "Dictionary Entry" },
    { "type": "document", "localized": "Document" },
    { "type": "email", "localized": "Email" },
    { "type": "encyclopediaArticle", "localized": "Encyclopedia Article" },
    { "type": "film", "localized": "Film" },
    { "type": "forumPost", "localized": "Forum Post" },
    { "type": "hearing", "localized": "Hearing" },
    { "type": "instantMessage", "localized": "Instant Message" },
    { "type": "interview", "localized": "Interview" },
    { "type": "journalArticle", "localized": "Journal Article" },
    { "type": "letter", "localized": "Letter" },
    { "type": "magazineArticle", "localized": "Magazine Article" },
    { "type": "manuscript", "localized": "Manuscript" },
    { "type": "map", "localized": "Map" },
    { "type": "newspaperArticle", "localized": "Newspaper Article" },
    { "type": "patent", "localized": "Patent" },
    { "type": "podcast", "localized": "Podcast" },
    { "type": "preprint", "localized": "Preprint" },
    { "type": "presentation", "localized": "Presentation" },
    { "type": "radioBroadcast", "localized": "Radio Broadcast" },
    { "type": "report", "localized": "Report" },
    { "type": "standard", "localized": "Standard" },
    { "type": "statute", "localized": "Statute" },
    { "type": "thesis", "localized": "Thesis" },
    { "type": "tvBroadcast", "localized": "TV Broadcast" },
    { "type": "videoRecording", "localized": "Video Recording" },
    { "type": "webpage", "localized": "Web Page" }
];

fields.sort((a, b) => a.localized.localeCompare(b.localized));
itemTypes.sort((a, b) => a.localized.localeCompare(b.localized));

// Pseudo-fields spliced into the field dropdown alongside real bibliographic
// fields, per Tony's choice: Creator is edited as two separate parts (Last
// Name / First Name), matching how the original bulk_edit.js and
// clean-creator-initials.js already model it, rather than as one merged
// "Last, First" value.
const CREATOR_LAST = { field: "creatorLastName", localized: "Creator: Last Name" };
const CREATOR_FIRST = { field: "creatorFirstName", localized: "Creator: First Name" };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// blank values always sort first (shown as "(blank)" in the UI), everything
// else alphabetically
function blankFirstCompare(a, b) {
    if (a === "" && b === "") return 0;
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
}

// For a real bibliographic field: walks every selected item, collecting the
// distinct values actually present (blank counts as ""), skipping items
// where the field plain doesn't exist for that item type (getField throws -
// this is the exact same try/catch idiom the original bulk_edit.js used to
// detect an invalid field per item type). `anyValid` says whether at least
// one item had this field at all, which is what decides whether the field
// even shows up in the dropdown.
function collectDistinctFieldValues(itemsToEdit, fieldName) {
    const values = new Set();
    let anyValid = false;
    for (const it of itemsToEdit) {
        try {
            const value = it.getField(fieldName) || "";
            anyValid = true;
            values.add(value);
        } catch (e) {
            // field not valid for this item's type - just skip this item
        }
    }
    return { anyValid, values: Array.from(values) };
}

// Same idea as collectDistinctFieldValues but for creator name parts, which
// live under item.getCreators() rather than item.getField(). `part` is
// "lastName" or "firstName". Single-field/organization creators
// (fieldMode === 1) store their whole name in lastName and have no first
// name, matching how clean-creator-initials.js treats fieldMode 1.
function collectDistinctCreatorValues(itemsToEdit, part) {
    const values = new Set();
    let anyValid = false;
    for (const it of itemsToEdit) {
        let creators;
        try {
            creators = it.getCreators();
        } catch (e) {
            continue;
        }
        if (!creators || !creators.length) continue;
        for (const creator of creators) {
            if (part === "lastName") {
                anyValid = true;
                values.add(creator.lastName || "");
            } else {
                if (creator.fieldMode === 1) continue;
                anyValid = true;
                values.add(creator.firstName || "");
            }
        }
    }
    return { anyValid, values: Array.from(values) };
}

// ---------------------------------------------------------------------------
// Dialog: an overlay panel injected into Zotero's own main window
// ---------------------------------------------------------------------------

const DIALOG_OVERLAY_ID = "zotero-bulk-edit-overlay";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ---------------------------------------------------------------------------
// Styling
//
// Every visual property here is applied as an inline `style="..."` attribute
// directly on each element, NOT via a shared <style>/stylesheet. Earlier
// versions used a single injected <style> tag scoped under
// #zotero-bulk-edit-overlay, which mostly worked (layout, borders, spacing
// all rendered correctly) but background-color specifically kept rendering
// as some darker/greyish tone no matter what value was used there - even
// after a full Zotero restart, which rules out any kind of stale-tag
// caching bug. Zotero's main window document is fundamentally XUL/XML, and
// apparently something about how that host applies rules from a plain
// <style> element doesn't reliably win for every property. Inline style
// attributes don't depend on stylesheet registration, cascade, or a <style>
// tag being recognized at all - they're read directly off each element -
// so this sidesteps that whole class of uncertainty. `!important` is added
// defensively in case some native/ancestor rule with higher specificity is
// what was actually fighting the old stylesheet.
// ---------------------------------------------------------------------------

const STYLE_OVERLAY =
    "position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; " +
    "background: rgba(0,0,0,0.4) !important; display: flex !important; align-items: center !important; " +
    "justify-content: center !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important; " +
    "font-size: 13px !important; font-weight: 400 !important; color: rgba(0,0,0,0.847) !important;";

const STYLE_PANEL =
    "background-color: #ffffff !important; background: #ffffff !important; border-radius: 12px !important; " +
    "box-shadow: 0 14px 44px rgba(0,0,0,0.45) !important; width: 640px !important; max-width: 90vw !important; " +
    "max-height: 85vh !important; overflow: auto !important; padding: 20px !important; box-sizing: border-box !important;";

const STYLE_H2 =
    "font-size: 14px !important; font-weight: 600 !important; margin: 0 0 12px 0 !important; color: rgba(0,0,0,0.847) !important;";

const STYLE_SECTION =
    "background-color: #ffffff !important; background: #ffffff !important; border: 1px solid #e0e0e0 !important; " +
    "border-radius: 8px !important; padding: 16px 18px !important; margin-bottom: 16px !important;";

const STYLE_ROW =
    "display: flex !important; align-items: center !important; gap: 10px !important; margin-bottom: 12px !important; min-height: 26px !important;";

const STYLE_LABEL =
    "min-width: 110px !important; font-weight: 400 !important; flex-shrink: 0 !important; color: rgba(0,0,0,0.847) !important;";

const STYLE_CONTROL =
    "flex: 1 !important; min-width: 0 !important; padding: 6px 8px !important; font-size: 13px !important; " +
    "font-weight: 400 !important; box-sizing: border-box !important; border: 1px solid #c7c7cc !important; " +
    "border-radius: 6px !important; background-color: #ffffff !important; background: #ffffff !important; color: rgba(0,0,0,0.847) !important;";

const STYLE_BUTTON_BASE =
    "-moz-appearance: none !important; appearance: none !important; display: inline-flex !important; " +
    "align-items: center !important; justify-content: center !important; text-align: center !important; " +
    "padding: 7px 18px !important; font-size: 13px !important; font-weight: 400 !important; line-height: 1.2 !important; " +
    "border-radius: 6px !important; box-sizing: border-box !important;";

const STYLE_BUTTON_NEUTRAL =
    "border: 1px solid #c7c7cc !important; background-color: #ffffff !important; background: #ffffff !important; color: rgba(0,0,0,0.847) !important;";

const STYLE_BUTTON_PRIMARY =
    "border: 1px solid #007aff !important; background-color: #007aff !important; background: #007aff !important; color: #ffffff !important;";

const STYLE_ACTIONS = "display: flex !important; justify-content: flex-end !important; margin-top: 14px !important;";
const STYLE_FOOTER = "display: flex !important; justify-content: flex-end !important; margin-top: 4px !important;";
const STYLE_HINT =
    "color: rgba(0,0,0,0.847) !important; font-size: 13px !important; font-weight: 400 !important; margin: 10px 0 0 0 !important; line-height: 1.4 !important;";

// Recomputes and re-applies a button's full inline style from its current
// `.disabled` state and whether it should read as the primary (blue)
// action. Called any time either of those things changes, since inline
// styles - unlike a `:disabled`/`.zbe-btn-primary` CSS rule - don't update
// themselves; they have to be set explicitly every time.
function styleButton(btn, primary) {
    const stateCss = btn.disabled
        ? "cursor: default !important; opacity: 0.5 !important;"
        : "cursor: pointer !important; opacity: 1 !important;";
    btn.setAttribute("style", STYLE_BUTTON_BASE + (primary ? STYLE_BUTTON_PRIMARY : STYLE_BUTTON_NEUTRAL) + stateCss);
}

// Builds a single <option>. Text is set via .textContent (a plain DOM text
// node, not markup) so there's no HTML/XML entity encoding to get right at
// all - "&", "<", quotes, em dashes, whatever's in a real title/name, all
// just work.
function buildOptionEl(doc, value, label) {
    const opt = doc.createElementNS(XHTML_NS, "option");
    opt.setAttribute("value", value);
    opt.textContent = label;
    return opt;
}

// An Apply button is neutral (same as Cancel/Done) until it would actually
// do something on click, at which point it turns blue - same idea as the
// enabled/disabled state, just also reflected in color instead of only
// opacity, so "this is now the thing to click" reads at a glance.
function setApplyButtonState(btn, enabled) {
    btn.disabled = !enabled;
    styleButton(btn, enabled);
}

function buildRow(doc, labelText, forId, controlEls) {
    const row = doc.createElementNS(XHTML_NS, "div");
    row.setAttribute("style", STYLE_ROW);
    const label = doc.createElementNS(XHTML_NS, "label");
    label.setAttribute("for", forId);
    label.setAttribute("style", STYLE_LABEL);
    label.textContent = labelText;
    row.appendChild(label);
    for (const el of controlEls) row.appendChild(el);
    return row;
}

// Builds the panel's whole DOM tree via createElementNS/appendChild calls -
// deliberately NOT via innerHTML/a markup string. Zotero's main window is a
// XUL (XML) document under the hood, and setting innerHTML there parses the
// string as strict XML, not HTML - an unclosed <input> or an HTML-only
// entity like "&mdash;" (both totally normal in HTML, both invalid in XML)
// throws a parser error and silently kills the whole dialog. Building nodes
// one at a time via the DOM API sidesteps that class of bug entirely: no
// markup, no parser, no well-formedness rules to satisfy.
//
// Returns the assembled panel element plus direct references to every
// control openBulkEditDialog needs to wire up and read from, so it doesn't
// need to go back through selectors/ids to find them again either.
function buildPanel(doc, dialogData) {
    const panel = doc.createElementNS(XHTML_NS, "div");
    panel.setAttribute("style", STYLE_PANEL);

    // --- item type section ---
    const typeSection = doc.createElementNS(XHTML_NS, "section");
    typeSection.setAttribute("style", STYLE_SECTION);
    const typeHeading = doc.createElementNS(XHTML_NS, "h2");
    typeHeading.setAttribute("style", STYLE_H2);
    typeHeading.textContent = "Change Item Type";
    typeSection.appendChild(typeHeading);

    const itemTypeSelect = doc.createElementNS(XHTML_NS, "select");
    itemTypeSelect.id = "zbeItemTypeSelect";
    itemTypeSelect.setAttribute("style", STYLE_CONTROL);
    itemTypeSelect.appendChild(buildOptionEl(doc, "", "— Select item type —"));
    for (const t of dialogData.itemTypes) {
        itemTypeSelect.appendChild(buildOptionEl(doc, t.type, t.localized));
    }
    typeSection.appendChild(buildRow(doc, "New type", "zbeItemTypeSelect", [itemTypeSelect]));

    const typeActions = doc.createElementNS(XHTML_NS, "div");
    typeActions.setAttribute("style", STYLE_ACTIONS);
    const applyItemTypeBtn = doc.createElementNS(XHTML_NS, "button");
    applyItemTypeBtn.id = "zbeApplyItemTypeBtn";
    applyItemTypeBtn.textContent = "Apply";
    applyItemTypeBtn.disabled = true;
    styleButton(applyItemTypeBtn, false);
    typeActions.appendChild(applyItemTypeBtn);
    typeSection.appendChild(typeActions);

    panel.appendChild(typeSection);

    // --- field/creator section ---
    const fieldSection = doc.createElementNS(XHTML_NS, "section");
    fieldSection.setAttribute("style", STYLE_SECTION + " margin-bottom: 0 !important;");
    const fieldHeading = doc.createElementNS(XHTML_NS, "h2");
    fieldHeading.setAttribute("style", STYLE_H2);
    fieldHeading.textContent = "Change a Field or Creator Name";
    fieldSection.appendChild(fieldHeading);

    const fieldSelect = doc.createElementNS(XHTML_NS, "select");
    fieldSelect.id = "zbeFieldSelect";
    fieldSelect.setAttribute("style", STYLE_CONTROL);
    fieldSelect.appendChild(buildOptionEl(doc, "", "— Select field —"));
    for (const f of dialogData.fieldOptions) {
        fieldSelect.appendChild(buildOptionEl(doc, f.field, f.localized));
    }
    fieldSection.appendChild(buildRow(doc, "Field", "zbeFieldSelect", [fieldSelect]));

    const currentValueSelect = doc.createElementNS(XHTML_NS, "select");
    currentValueSelect.id = "zbeCurrentValueSelect";
    currentValueSelect.disabled = true;
    currentValueSelect.setAttribute("style", STYLE_CONTROL);
    currentValueSelect.appendChild(buildOptionEl(doc, "", "— Select current value —"));
    fieldSection.appendChild(buildRow(doc, "Current value", "zbeCurrentValueSelect", [currentValueSelect]));

    // "New value" is two controls that share one slot: a dropdown (built
    // exactly like Current value, same element/same values) for picking an
    // existing value, and a plain text box below it for typing something
    // new. Only one is ever "live" at a time - picking a dropdown value
    // clears the text box, and typing in the text box resets the dropdown
    // to its placeholder (see the change/input listeners in
    // runBulkEditDialog) - so there's never ambiguity about which one Apply
    // should read from.
    const newValueSelect = doc.createElementNS(XHTML_NS, "select");
    newValueSelect.id = "zbeNewValueSelect";
    newValueSelect.disabled = true;
    newValueSelect.setAttribute("style", STYLE_CONTROL);
    newValueSelect.appendChild(buildOptionEl(doc, "", "— Select existing value —"));
    fieldSection.appendChild(buildRow(doc, "New value", "zbeNewValueSelect", [newValueSelect]));

    const newValueInput = doc.createElementNS(XHTML_NS, "input");
    newValueInput.setAttribute("type", "text");
    newValueInput.id = "zbeNewValueInput";
    newValueInput.setAttribute("style", STYLE_CONTROL);
    newValueInput.setAttribute("placeholder", "...or type a new value (leave blank to clear)");
    fieldSection.appendChild(buildRow(doc, "", "zbeNewValueInput", [newValueInput]));

    const hint = doc.createElementNS(XHTML_NS, "p");
    hint.setAttribute("style", STYLE_HINT);
    hint.textContent = "Only items whose current value exactly matches the one selected above will be changed.";
    fieldSection.appendChild(hint);

    const fieldActions = doc.createElementNS(XHTML_NS, "div");
    fieldActions.setAttribute("style", STYLE_ACTIONS);
    const applyFieldBtn = doc.createElementNS(XHTML_NS, "button");
    applyFieldBtn.id = "zbeApplyFieldBtn";
    applyFieldBtn.textContent = "Apply";
    applyFieldBtn.disabled = true;
    styleButton(applyFieldBtn, false);
    fieldActions.appendChild(applyFieldBtn);
    fieldSection.appendChild(fieldActions);

    panel.appendChild(fieldSection);

    // --- footer ---
    const footer = doc.createElementNS(XHTML_NS, "div");
    footer.setAttribute("style", STYLE_FOOTER);
    const cancelBtn = doc.createElementNS(XHTML_NS, "button");
    cancelBtn.id = "zbeCancelBtn";
    cancelBtn.textContent = "Cancel";
    styleButton(cancelBtn, false);
    footer.appendChild(cancelBtn);
    panel.appendChild(footer);

    return {
        panel,
        itemTypeSelect, applyItemTypeBtn,
        fieldSelect, currentValueSelect, newValueSelect, newValueInput, applyFieldBtn,
        cancelBtn,
    };
}

// Recomputes the field/creator distinct-value map and the filtered field
// list for the CURRENT state of itemsToEdit - called once before the dialog
// first opens, and again after every Apply, since an applied change can
// itself change what shows up here (e.g. replacing "Am J Primatol" with
// "American Journal of Primatology" means that's now the only distinct
// value left to pick for a follow-up edit).
function computeDialogData(itemsToEdit) {
    const valueMap = {};
    for (const f of fields) {
        valueMap[f.field] = collectDistinctFieldValues(itemsToEdit, f.field);
    }
    valueMap[CREATOR_LAST.field] = collectDistinctCreatorValues(itemsToEdit, "lastName");
    valueMap[CREATOR_FIRST.field] = collectDistinctCreatorValues(itemsToEdit, "firstName");

    let fieldOptions = fields.filter(f => valueMap[f.field].anyValid);
    if (valueMap[CREATOR_LAST.field].anyValid) fieldOptions.push(CREATOR_LAST);
    if (valueMap[CREATOR_FIRST.field].anyValid) fieldOptions.push(CREATOR_FIRST);
    fieldOptions.sort((a, b) => a.localized.localeCompare(b.localized));

    const slimValueMap = {};
    for (const f of fieldOptions) {
        const entry = valueMap[f.field];
        entry.values.sort(blankFirstCompare);
        slimValueMap[f.field] = { values: entry.values };
    }

    return { itemTypes: itemTypes, fieldOptions: fieldOptions, valueMap: slimValueMap };
}

// Shows the panel as a fixed-position overlay appended directly into
// Zotero's own main window document, and resolves once the user is done -
// Cancel/Done clicked, Escape pressed, or the dark backdrop clicked -
// always removing the overlay again before resolving. No new window, no
// window.open(), no postMessage: this script is already running with full
// access to that document, so event listeners are wired up on the injected
// elements directly, same as any other DOM manipulation this script does.
//
// Unlike a typical OK/Cancel dialog, clicking either Apply button does NOT
// close this - it applies that one change immediately (via
// applyItemTypeChange/applyFieldChange) and then rebuilds the panel in
// place from freshly recomputed data, so the same set of items can be
// bulk-edited again right away (e.g. fix the item type, then fix
// publicationTitle, then fix a creator name, all in one sitting). Once
// anything has been applied, the footer button relabels from "Cancel" to
// "Done" to reflect that closing now means "finish up", not "discard".
async function runBulkEditDialog(win, itemsToEdit) {
    const doc = win.document;

    // defensive: if a previous run somehow left its overlay behind (e.g. it
    // threw between creating and removing it), clear that one first so they
    // never stack
    const stale = doc.getElementById(DIALOG_OVERLAY_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    const overlay = doc.createElementNS(XHTML_NS, "div");
    overlay.id = DIALOG_OVERLAY_ID;
    overlay.setAttribute("style", STYLE_OVERLAY);
    (doc.body || doc.documentElement).appendChild(overlay);

    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    return new Promise((resolve) => {
        let settled = false;
        let hasApplied = false;
        let dialogData = null;
        let currentFieldValues = [];
        let refs = null;

        function onKeydown(event) {
            if (event.key === "Escape") finish();
        }
        doc.addEventListener("keydown", onKeydown, true);

        // clicking the dimmed backdrop (outside the panel itself) closes,
        // same as most modal overlay conventions - attached once, since
        // `overlay` itself (unlike its contents) persists across rebuilds
        overlay.addEventListener("click", function (event) {
            if (event.target === overlay) finish();
        });

        function cleanup() {
            try { doc.removeEventListener("keydown", onKeydown, true); } catch (e) {}
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }

        function finish() {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        }

        // Current value and New value are both populated from the exact
        // same distinct-values list, so they're built together here. Both
        // selects use the same index-based option values (see
        // buildOptionEl calls below) into the shared currentFieldValues
        // array, so "0"/"1"/etc. always mean the same thing in either one.
        function renderValueControls(fieldName) {
            clearChildren(refs.currentValueSelect);
            refs.currentValueSelect.appendChild(buildOptionEl(doc, "", "— Select current value —"));
            clearChildren(refs.newValueSelect);
            refs.newValueSelect.appendChild(buildOptionEl(doc, "", "— Select existing value —"));

            const entry = dialogData.valueMap[fieldName];
            currentFieldValues = (entry && entry.values) || [];
            currentFieldValues.forEach((v, i) => {
                const label = v === "" ? "(blank)" : v;
                refs.currentValueSelect.appendChild(buildOptionEl(doc, String(i), label));
                refs.newValueSelect.appendChild(buildOptionEl(doc, String(i), label));
            });
            refs.currentValueSelect.disabled = currentFieldValues.length === 0;
            refs.newValueSelect.disabled = currentFieldValues.length === 0;
        }

        // Rebuilds the panel's DOM from scratch against freshly recomputed
        // dialogData - used both for the very first render and again after
        // every successful Apply. `preserveField` re-selects whatever field
        // was chosen before the rebuild (handy right after a field/creator
        // Apply, so the just-edited field's now-current values are right
        // there for a follow-up tweak) rather than resetting to blank.
        function rebuild(preserveField) {
            dialogData = computeDialogData(itemsToEdit);
            const previousField = preserveField && refs ? refs.fieldSelect.value : "";

            clearChildren(overlay);
            refs = buildPanel(doc, dialogData);
            overlay.appendChild(refs.panel);
            refs.cancelBtn.textContent = hasApplied ? "Done" : "Cancel";
            styleButton(refs.cancelBtn, hasApplied);

            refs.itemTypeSelect.addEventListener("change", function () {
                setApplyButtonState(refs.applyItemTypeBtn, !!this.value);
            });

            refs.fieldSelect.addEventListener("change", function () {
                refs.newValueInput.value = "";
                setApplyButtonState(refs.applyFieldBtn, false);
                renderValueControls(this.value);
            });

            refs.currentValueSelect.addEventListener("change", function () {
                setApplyButtonState(refs.applyFieldBtn, !!refs.fieldSelect.value && this.value !== "");
            });

            // New value's dropdown and text box share one "slot" - only one
            // is ever the live source for Apply. Picking a dropdown value
            // clears the text box; typing in the text box resets the
            // dropdown back to its placeholder. Never both at once.
            refs.newValueSelect.addEventListener("change", function () {
                if (this.value !== "") {
                    refs.newValueInput.value = "";
                }
            });

            refs.newValueInput.addEventListener("input", function () {
                if (this.value !== "") {
                    refs.newValueSelect.value = "";
                }
            });

            refs.applyItemTypeBtn.addEventListener("click", async function () {
                const typeKey = refs.itemTypeSelect.value;
                if (!typeKey) return;
                setApplyButtonState(refs.applyItemTypeBtn, false);
                refs.itemTypeSelect.disabled = true;
                try {
                    await applyItemTypeChange(itemsToEdit, typeKey);
                } catch (e) {
                    Zotero.logError(`Bulk Edit: applyItemTypeChange failed: ${e}`);
                }
                hasApplied = true;
                rebuild(false);
            });

            refs.applyFieldBtn.addEventListener("click", async function () {
                const fieldName = refs.fieldSelect.value;
                const idx = refs.currentValueSelect.value;
                if (!fieldName || idx === "") return;
                const oldValue = currentFieldValues[parseInt(idx, 10)];
                // whichever of the two "new value" controls actually has
                // something live in it wins - the change/input listeners
                // above guarantee at most one of them does at any given time
                const newValueIdx = refs.newValueSelect.value;
                const newValue = newValueIdx !== "" ? currentFieldValues[parseInt(newValueIdx, 10)] : refs.newValueInput.value;
                setApplyButtonState(refs.applyFieldBtn, false);
                refs.fieldSelect.disabled = true;
                refs.currentValueSelect.disabled = true;
                refs.newValueSelect.disabled = true;
                refs.newValueInput.disabled = true;
                try {
                    await applyFieldChange(itemsToEdit, fieldName, oldValue, newValue);
                } catch (e) {
                    Zotero.logError(`Bulk Edit: applyFieldChange failed: ${e}`);
                }
                hasApplied = true;
                rebuild(true);
            });

            refs.cancelBtn.addEventListener("click", function () {
                finish();
            });

            if (previousField && dialogData.valueMap[previousField]) {
                refs.fieldSelect.value = previousField;
                renderValueControls(previousField);
            }

            // deliberately no .focus() call anywhere here - nothing in the
            // dialog should start (or end up, after a rebuild) focused
        }

        rebuild(false);
    });
}

// Degraded fallback used only if injecting the overlay panel itself throws
// for some unforeseen reason (e.g. no accessible document) - a plain
// sequential window.prompt()/window.confirm() flow using the same
// exact-match model as the real dialog, in the spirit of the plain-prompt
// fallbacks the other three scripts fall back to when their preferred
// native dialog API isn't available. Loops (offering "make another change?"
// after each applied edit) for the same reason the real dialog stays open
// after Apply now - so a degraded run isn't limited to a single edit.
async function runFallbackFlow(win, itemsToEdit) {
    let keepGoing = true;
    while (keepGoing) {
        const dialogData = computeDialogData(itemsToEdit);
        const applied = await runFallbackFlowOnce(win, itemsToEdit, dialogData);
        if (!applied) return;
        keepGoing = win.confirm("Change applied. Make another change to the same set of items?");
    }
}

// Runs one type-or-field choice through plain prompts. Returns true if a
// change was actually applied, false if the user backed out at any point.
async function runFallbackFlowOnce(win, itemsToEdit, dialogData) {
    const choice = win.prompt('Bulk Edit\n\nType "type" to change item type, or "field" to change a field/creator value:');
    if (choice === null) return false;
    const normalized = choice.trim().toLowerCase();

    if (normalized === "type" || normalized === "t") {
        const typeChoice = win.prompt("Enter the new item type exactly as shown:\n\n" + dialogData.itemTypes.map(t => t.localized).join(", "));
        if (!typeChoice) return false;
        const match = dialogData.itemTypes.find(t => t.localized.toLowerCase() === typeChoice.trim().toLowerCase());
        if (!match) {
            win.alert(`No exact match for "${typeChoice}".`);
            return false;
        }
        if (!win.confirm(`Change item type to "${match.localized}" for ${itemsToEdit.length} item(s)?`)) return false;
        await applyItemTypeChange(itemsToEdit, match.type);
        return true;
    }

    if (normalized === "field" || normalized === "f") {
        const fieldChoice = win.prompt("Enter the field name exactly as shown:\n\n" + dialogData.fieldOptions.map(f => f.localized).join(", "));
        if (!fieldChoice) return false;
        const fieldMatch = dialogData.fieldOptions.find(f => f.localized.toLowerCase() === fieldChoice.trim().toLowerCase());
        if (!fieldMatch) {
            win.alert(`No exact match for "${fieldChoice}".`);
            return false;
        }

        const values = (dialogData.valueMap[fieldMatch.field] && dialogData.valueMap[fieldMatch.field].values) || [];
        const valueChoice = win.prompt(`Enter the exact current value to replace in "${fieldMatch.localized}" (or "(blank)"):\n\n` +
            values.map(v => v === "" ? "(blank)" : v).join("\n"));
        if (valueChoice === null) return false;
        const oldValue = valueChoice.trim() === "(blank)" ? "" : valueChoice;
        if (!values.includes(oldValue)) {
            win.alert(`"${valueChoice}" is not one of the current values for this field.`);
            return false;
        }

        const newValue = win.prompt("Enter the new value (leave blank to clear):", oldValue);
        if (newValue === null) return false;
        if (!win.confirm(`Change "${fieldMatch.localized}" from "${oldValue || "(blank)"}" to "${newValue || "(blank)"}"?`)) return false;
        await applyFieldChange(itemsToEdit, fieldMatch.field, oldValue, newValue);
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Applying the change
// ---------------------------------------------------------------------------

async function applyItemTypeChange(itemsToEdit, typeKey) {
    const typeDef = itemTypes.find(t => t.type === typeKey);
    const typeLabel = typeDef ? typeDef.localized : typeKey;
    const typeID = Zotero.ItemTypes.getID(typeKey);
    if (!typeID) {
        Zotero.alert(null, "Bulk Edit", `Invalid item type: ${typeLabel}`);
        return;
    }

    let updated = 0;
    let skipped = 0;
    await Zotero.DB.executeTransaction(async function () {
        for (const it of itemsToEdit) {
            if (!it.isAttachment() || it.getField("parentItemID")) {
                it.setType(typeID);
                await it.save();
                updated++;
            } else {
                skipped++;
            }
        }
    });

    Zotero.alert(null, "Bulk Edit", `Item type changed to "${typeLabel}" for ${updated} item(s). Skipped ${skipped}.`);
}

async function applyFieldChange(itemsToEdit, fieldName, oldValue, newValue) {
    if (fieldName === CREATOR_LAST.field || fieldName === CREATOR_FIRST.field) {
        await applyCreatorChange(itemsToEdit, fieldName, oldValue, newValue);
        return;
    }

    const fieldDef = fields.find(f => f.field === fieldName);
    const fieldLabel = fieldDef ? fieldDef.localized : fieldName;

    let idsToUpdate = [];
    for (const it of itemsToEdit) {
        try {
            const current = it.getField(fieldName) || "";
            if (current === oldValue) idsToUpdate.push(it.id);
        } catch (e) {
            // field not valid for this item's type - skip it
        }
    }

    if (!idsToUpdate.length) {
        Zotero.alert(null, "Bulk Edit", `No items currently have "${oldValue || "(blank)"}" in the "${fieldLabel}" field.`);
        return;
    }

    let updated = 0;
    let errors = 0;
    await Zotero.DB.executeTransaction(async function () {
        for (const id of idsToUpdate) {
            const it = await Zotero.Items.getAsync(id);
            try {
                it.setField(fieldName, newValue);
                await it.save();
                updated++;
            } catch (e) {
                Zotero.logError(`Bulk Edit error setting "${fieldName}" on item ${id}: ${e}`);
                errors++;
            }
        }
    });

    Zotero.alert(null, "Bulk Edit",
        `Updated "${fieldLabel}" from "${oldValue || "(blank)"}" to "${newValue || "(blank)"}" on ${updated} item(s).${errors ? ` Errors: ${errors} (check error console).` : ""}`);
}

async function applyCreatorChange(itemsToEdit, fieldName, oldValue, newValue) {
    const part = fieldName === CREATOR_LAST.field ? "lastName" : "firstName";
    const fieldLabel = part === "lastName" ? CREATOR_LAST.localized : CREATOR_FIRST.localized;

    let updated = 0;
    let toBeBlankedItems = [];
    let originalCreatorsMap = new Map();

    await Zotero.DB.executeTransaction(async function () {
        for (const it of itemsToEdit) {
            let creators;
            try {
                creators = it.getCreators();
            } catch (e) {
                continue;
            }
            if (!creators || !creators.length) continue;

            let changed = false;
            let leftBlank = false;
            for (const creator of creators) {
                let matches;
                if (part === "lastName") {
                    matches = creator.lastName === oldValue;
                } else {
                    matches = creator.fieldMode !== 1 && creator.firstName === oldValue;
                }
                if (!matches) continue;

                changed = true;
                if (part === "lastName") {
                    creator.lastName = newValue;
                } else {
                    creator.firstName = newValue;
                }
                if (!creator.firstName && !creator.lastName) {
                    leftBlank = true;
                }
            }

            if (changed) {
                originalCreatorsMap.set(it.id, JSON.parse(JSON.stringify(creators)));
                it.setCreators(creators);
                await it.save();
                updated++;
                if (leftBlank) toBeBlankedItems.push(it);
            }
        }
    });

    if (updated === 0) {
        Zotero.alert(null, "Bulk Edit", `No creators currently have "${oldValue || "(blank)"}" as their ${part === "lastName" ? "last" : "first"} name.`);
        return;
    }

    if (toBeBlankedItems.length) {
        const win = Zotero.getMainWindow();
        let removeBlankOnes = false;
        try {
            if (typeof Services !== "undefined" && Services.prompt && typeof Services.prompt.confirm === "function") {
                removeBlankOnes = Services.prompt.confirm(win, "Bulk Edit",
                    `${toBeBlankedItems.length} creator(s) will be left with no name after this update. Remove those blank creator entries? (Choosing No restores their original name instead.)`);
            } else {
                removeBlankOnes = win.confirm(`${toBeBlankedItems.length} creator(s) will be left with no name after this update. Remove those blank entries? (Cancel restores their original name.)`);
            }
        } catch (e) {
            removeBlankOnes = false;
        }

        await Zotero.DB.executeTransaction(async function () {
            for (const it of toBeBlankedItems) {
                if (removeBlankOnes) {
                    const remaining = it.getCreators().filter(c => c.fieldMode === 1 || c.firstName || c.lastName);
                    it.setCreators(remaining);
                } else {
                    const original = originalCreatorsMap.get(it.id);
                    if (original) it.setCreators(original);
                }
                await it.save();
            }
        });
    }

    Zotero.alert(null, "Bulk Edit",
        `Updated "${fieldLabel}" from "${oldValue || "(blank)"}" to "${newValue || "(blank)"}" on ${updated} item(s).`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
//
// Actions & Tags fires this script once PER SELECTED ITEM on a multi-select
// trigger, not once for the whole selection (the same behavior
// rename-attachments.js documents and handles) - without batching that,
// opening the dialog once per item would mean it pops up (or "already in
// progress" alerts) once per item in the selection. Invocations are
// collected into a short-lived batch (see runInvocation), and only once
// nothing new has arrived for COLLECT_WINDOW_MS does the whole batch get
// handed to processBatch() for a single dialog + single apply pass.

const COLLECT_WINDOW_MS = 150;
const COLLECT_WINDOW_MAX_MS = 2000;
const STILL_IN_PROGRESS_HEADLINE = "Bulk Edit — Please Wait";

// Non-modal "still busy" notice for the rare case a new invocation arrives
// while a previous batch's dialog/apply pass is still in flight (e.g. the
// user re-triggers the action while the panel from a previous run is still
// open). Uses Zotero.ProgressWindow rather than Zotero.alert() /
// Zotero.confirm() on purpose: those are modal, and showing one while an
// earlier invocation still has pending async work in flight is exactly the
// kind of thing that can wedge Zotero's UI - ProgressWindow is safe to show
// concurrently with other in-flight work.
function showStillInProgressNotice() {
    if (Zotero.__bulkEditNoticeShowing) return;
    Zotero.__bulkEditNoticeShowing = true;
    const noticeLifetimeMs = 3000;
    setTimeout(() => { Zotero.__bulkEditNoticeShowing = false; }, noticeLifetimeMs);
    try {
        const pw = new Zotero.ProgressWindow({ closeOnClick: false });
        pw.changeHeadline(STILL_IN_PROGRESS_HEADLINE);
        pw.show();
        const line = new pw.ItemProgress(null, "A bulk edit is still in progress (dialog open or applying changes). Finish that first, then try again.");
        line.setProgress(100);
        pw.startCloseTimer(noticeLifetimeMs);
    } catch (e) {
        Zotero.logError(`Bulk Edit: still-in-progress notice failed: ${e}`);
    }
}

// Called on every invocation. Deliberately does almost no work itself and
// contains no await, so a burst of per-item invocations for one
// multi-select trigger all land here quickly, one after another, without
// any of them waiting on the others - mirrors rename-attachments.js's
// runInvocation exactly.
function runInvocation() {
    if (!items && !item) {
        Zotero.alert(null, "Bulk Edit", "No item or items array provided.");
        return;
    }
    const incoming = items || (item ? [item] : []);
    if (incoming.length === 0) return;

    if (Zotero.__bulkEditProcessing) {
        // A previous run that hung (e.g. an unforeseen bug leaves the
        // dialog promise never resolving) would otherwise leave this lock
        // stuck forever, permanently blocking every future run until
        // Zotero is restarted. Treat a lock older than STALE_LOCK_MS as
        // abandoned and clear it instead of trusting it indefinitely.
        const STALE_LOCK_MS = 30 * 1000;
        const runningSince = Zotero.__bulkEditRunningSince || 0;
        if (Date.now() - runningSince < STALE_LOCK_MS) {
            showStillInProgressNotice();
            return;
        }
        Zotero.logError("Bulk Edit: clearing a stale processing lock left over from a previous run.");
        Zotero.__bulkEditProcessing = false;
    }

    let batch = Zotero.__bulkEditBatch;
    if (!batch) {
        batch = { items: [], firstArrivalAt: Date.now(), timer: null };
        Zotero.__bulkEditBatch = batch;
    }
    batch.items.push(...incoming);

    clearTimeout(batch.timer);
    const elapsed = Date.now() - batch.firstArrivalAt;
    const waitMs = Math.max(0, Math.min(COLLECT_WINDOW_MS, COLLECT_WINDOW_MAX_MS - elapsed));
    batch.timer = setTimeout(() => {
        finalizeBatch(batch).catch(e => Zotero.logError(`Bulk Edit: unhandled error in finalizeBatch: ${e}`));
    }, waitMs);
}

// Runs once the collection window closes: hands the batch off to
// processBatch() under the "processing" lock, held for the entire pass
// (dialog shown through to the final Zotero.alert()) and released the
// instant that finishes.
async function finalizeBatch(batch) {
    if (Zotero.__bulkEditBatch !== batch) {
        // already handled - shouldn't normally happen, defensive only
        return;
    }
    Zotero.__bulkEditBatch = null;
    Zotero.__bulkEditProcessing = true;
    Zotero.__bulkEditRunningSince = Date.now();
    try {
        await processBatch(batch.items);
    } finally {
        Zotero.__bulkEditProcessing = false;
    }
}

// Does the actual work for one collected batch: dedupes items, shows the
// dialog, and applies whichever action the user picked.
async function processBatch(rawItems) {
    try {
        // dedupe by id - a batch can end up with the same item more than
        // once if per-item invocations overlap in some edge case
        const seenIds = new Set();
        const itemsToEdit = [];
        for (const it of rawItems) {
            if (!it || it.id === undefined || seenIds.has(it.id)) continue;
            seenIds.add(it.id);
            itemsToEdit.push(it);
        }
        if (!itemsToEdit.length) return;

        const win = Zotero.getMainWindow();
        if (!win) {
            Zotero.logError("Bulk Edit: no main window available.");
            return;
        }

        // runBulkEditDialog handles everything from here: building the
        // panel, applying whichever change(s) the user picks (without
        // closing in between), and cleaning up once they click Done/Cancel.
        try {
            await runBulkEditDialog(win, itemsToEdit);
        } catch (e) {
            Zotero.logError(`Bulk Edit: failed to show the in-window dialog, falling back to prompts: ${e}`);
            await runFallbackFlow(win, itemsToEdit);
        }
    } catch (error) {
        Zotero.logError(`Error in bulk edit script: ${error.message}`);
    }
}

// Run this invocation directly - no queue needed. runInvocation() itself is
// synchronous and side-effect-light (just batch bookkeeping and a timer),
// so there's nothing for a promise chain to serialize; the actual work only
// ever runs inside finalizeBatch(), which is already guarded by the
// __bulkEditProcessing lock above.
runInvocation();
