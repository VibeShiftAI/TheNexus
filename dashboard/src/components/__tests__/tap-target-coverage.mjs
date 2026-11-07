// Shared by the review-surface tap-target tests (task 3f8d291a, QA round 1). Not a test file itself.
//
// covered(el) answers "is this control at least 44x44 below lg?" from the classes that make it so, evaluating the
// review-surface rule's own selector in jsdom rather than restating it:
//  - it sits under an element carrying REVIEW_TAP_TARGETS and matches that rule's selector; or
//  - it carries explicit max-lg:min-h-11 and either max-lg:min-w-11! or a box that is wide by construction; or
//  - it is a checkbox or radio whose label carries max-lg:min-h-11 (the label is the target); or
//  - it is an image pin, prototype point pin or time marker with a 44px [data-tap-area] square.
import { REVIEW_TAP_TARGETS } from '../../lib/review-tap-targets.ts';

/** The selector inside `max-lg:[&_<selector>]:<utility>` for one utility, with Tailwind's "_" read back as a space. */
export function ruleSelector(utility) {
  const cls = REVIEW_TAP_TARGETS.split(/\s+/).find((c) => c.endsWith(`]:${utility}`));
  if (!cls) throw new Error(`REVIEW_TAP_TARGETS has no ${utility} part`);
  return cls.slice('max-lg:[&_'.length, -`]:${utility}`.length).replaceAll('_', ' ');
}

const CONTROLS = 'button, a[href], select, summary, [role=tab], input:not([type=hidden]), textarea';
const ruleHost = (el) => [...(el.ownerDocument.querySelectorAll('[class]'))].find((host) => host !== el && host.contains(el) && REVIEW_TAP_TARGETS.split(/\s+/).every((c) => host.classList.contains(c)));

export function covered(el) {
  if (el.matches('textarea')) return true; // h-16 and taller, full width
  if (el.matches('input[type=checkbox], input[type=radio]')) {
    const label = el.closest('label');
    return !!label && label.classList.contains('max-lg:min-h-11');
  }
  if (el.matches('[data-image-pin], [data-point-pin], [data-time-marker]')) {
    const area = el.querySelector(':scope > [data-tap-area]');
    return !!area && area.classList.contains('size-11') && area.classList.contains('lg:hidden');
  }
  if (ruleHost(el) && el.matches(ruleSelector('min-h-11')) && el.matches(ruleSelector('min-w-11!'))) return true;
  return el.classList.contains('max-lg:min-h-11') && (el.classList.contains('max-lg:min-w-11!') || el.classList.contains('w-full') || el.classList.contains('flex-1'));
}

/** Every control under root that is not covered, as readable labels (an empty list passes). */
export function uncovered(root) {
  return [...root.querySelectorAll(CONTROLS)]
    // A line-number gutter is sized by its line (WCAG 2.5.8's line-height exception); lib/review-tap-targets leaves it out.
    .filter((el) => !el.matches('[data-line-gutter]'))
    .filter((el) => !covered(el))
    .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`);
}
