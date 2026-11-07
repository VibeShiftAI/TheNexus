/**
 * Phone and tablet tap targets on the document review surface (task 3f8d291a, QA round 1).
 *
 * Below the lg breakpoint every control inside the element carrying these classes is at least 44px in both
 * dimensions: buttons, links that are laid out as boxes, selects, summaries, tabs and text inputs. The review page
 * root carries them, which covers the header, the brief, every viewer's toolbar and tabs, the phone bar, the
 * navigator and review drawers, the confirmation panels, the composer sheet and the evidence drawer; the portaled
 * lightbox carries them itself.
 *
 * Left out on purpose:
 *  - links inside running text: min sizes do not apply to inline boxes, and WCAG 2.5.8 exempts them;
 *  - image pins, prototype point pins and video time markers ([data-image-pin], [data-point-pin], [data-time-marker]):
 *    their box is the commented region, spot or moment drawn over the content, so they get a 44px hit square of their
 *    own ([data-tap-area]) rather than a bigger box;
 *  - checkboxes and radios: their label is the target and carries min-h-11 where it is rendered;
 *  - the line-number gutter of a text, code or JSON file ([data-line-gutter]): each number is sized by the line it
 *    numbers (WCAG 2.5.8's line-height exception), 48px wide and taller when the line wraps; a 44px row per line
 *    spread a code file to about twice its length on a phone.
 *
 * The width floor is !important (trailing "!"): below 768px globals.css sets `.flex > * { min-width: 0 }` outside any
 * cascade layer, which outranks every utility, and without it a flex child icon button shrank back to 21px on a phone.
 * Explicit width floors on review controls use the same "!" for the same reason.
 *
 * Tailwind finds classes by scanning source text, so both strings are written out in full, not assembled.
 * Kept in lib/ (not exported from a component module) so a save of the page does not force a full reload.
 */
export const REVIEW_TAP_TARGETS =
    "max-lg:[&_:is(button,a[href],select,summary,[role=tab],input:not([type=hidden],[type=checkbox],[type=radio],[type=range])):not([data-image-pin],[data-point-pin],[data-time-marker],[data-line-gutter])]:min-h-11 " +
    "max-lg:[&_:is(button,a[href],select,summary,[role=tab],input:not([type=hidden],[type=checkbox],[type=radio],[type=range])):not([data-image-pin],[data-point-pin],[data-time-marker],[data-line-gutter])]:min-w-11!";

/** An invisible 44px square centred on a pin's badge, below lg only; the browser probe measures it via data-tap-area. */
export const REVIEW_PIN_HIT_AREA = "absolute size-11 -translate-x-1/2 -translate-y-1/2 lg:hidden";
