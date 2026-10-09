/**
 * A synthetic Groundrules packet for the labeling tests: the real packet's
 * shape (schemaVersion, digests, partA/partB/partC, filling) over invented
 * statute text, written into a temp ledger directory (gold-set/ beside a
 * sources/ corpus in the scorer's own layout: manifest + one USLM-style XML
 * whose units hold the rows, so a `within` can be checked in unit scope).
 * Nothing here is a roster row, a control fixture or a pair from the real
 * packet, and nothing here ever touches /Volumes/Projects/Groundrules.club.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const sha = value => createHash('sha256').update(value).digest('hex');

const ROW_1 = 'A card holder may borrow up to five items at one time, unless the holder has an overdue item, in which case no further loan shall be made.';
const ROW_2 = 'The library shall notify the holder within ten days after an item becomes overdue.';
const ROW_3 = 'a refusal to renew a card for a holder who has paid every fine within thirty days of notice';
const CONTEXT_3 = 'For purposes of this section, an unreasonable refusal includes';
/** The roster's own span for ROW_2, which (synthetically) repeats inside its unit. */
const WITHIN_2 = `(b) ${ROW_2} The library may notify by post. * NB synthetic`;
/** A span that occurs once in ROW_1's passage but three times in its unit (ROW_2, which carries it, repeats there). */
const UNIT_REPEAT = 'the holder';

const row3For = variant => (variant === 'moved' ? `${ROW_3} issued under this section` : ROW_3);
const xmlEscape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The synthetic corpus in USLM section shape: /syn/lib/s1 holds ROW_1 once
 * and ROW_2 twice (so WITHIN_2 is the only span that pins ROW_2), /syn/lib/s2
 * holds CONTEXT_3 as the chapeau of the unit /syn/lib/s2/a the row sits in.
 */
function buildSourceXml({ variant = 'base' } = {}) {
    const ns = 'http://xml.house.gov/schemas/uslm/1.0';
    return `<?xml version='1.0' encoding='utf-8'?>\n<ns0:title xmlns:ns0="${ns}" identifier="/syn/lib">`
        + `<ns0:section identifier="/syn/lib/s1"><ns0:num value="1">§ 1.</ns0:num><ns0:heading> Loans</ns0:heading>`
        + `<ns0:subsection identifier="/syn/lib/s1/a"><ns0:num value="a">(a)</ns0:num><ns0:content> ${xmlEscape(ROW_1)}</ns0:content></ns0:subsection>\n`
        + `<ns0:subsection identifier="/syn/lib/s1/b"><ns0:num value="b">(b)</ns0:num><ns0:content> ${xmlEscape(ROW_2)} The library may notify by post. * NB synthetic</ns0:content></ns0:subsection>\n`
        + `<ns0:subsection identifier="/syn/lib/s1/c"><ns0:num value="c">(c)</ns0:num><ns0:content> ${xmlEscape(ROW_2)} Notice by post suffices.</ns0:content></ns0:subsection>\n`
        + `</ns0:section>\n<ns0:section identifier="/syn/lib/s2"><ns0:num value="2">§ 2.</ns0:num><ns0:heading> Renewal</ns0:heading><ns0:chapeau> ${xmlEscape(CONTEXT_3)}</ns0:chapeau>`
        + `<ns0:subsection identifier="/syn/lib/s2/a"><ns0:num value="a">(a)</ns0:num><ns0:content> ${xmlEscape(row3For(variant))};</ns0:content></ns0:subsection>\n`
        + `<ns0:subsection identifier="/syn/lib/s2/b"><ns0:num value="b">(b)</ns0:num><ns0:content> a refusal to renew for any reason the holder was not told of.</ns0:content></ns0:subsection>\n`
        + `</ns0:section></ns0:title>\n`;
}

function buildManifest({ variant = 'base' } = {}) {
    return { sources: [{ id: 'lib', jurisdiction: 'federal', citationPath: '/syn/lib', corpusVersion: '1', format: 'uslm-section-xml', file: 'sources/lib.xml', sha256: sha(buildSourceXml({ variant })) }] };
}

function buildPacket({ variant = 'base' } = {}) {
    const row3 = row3For(variant);
    return {
        schemaVersion: '1.0.0',
        purpose: 'Synthetic blind labelling packet for tests.',
        status: 'NEEDS_EVIDENCE: synthetic',
        protocol: ['Part A is labelled blind.', 'Part B is judged after Part A is complete.', 'Part C is annotated after Part B.'],
        filling: ['Copy the templates.', 'Score with: python3 -m src.ledger goldset --labels data/ledger/gold-set/labels'],
        rosterSha256: sha(`roster-${variant}`),
        thresholdsSha256: sha('thresholds'),
        controlsSha256: sha('controls'),
        vpuSha256: sha('vpu'),
        alignmentMinJaccard: 0.5,
        guideline: { source: 'docs/gold-set-design.md, section 2', sha256: sha('guideline'), text: '## 2. The unit of labelling\n\nSynthetic guideline text.' },
        sources: [{ id: 'lib', jurisdiction: 'federal', corpusVersion: '1', sha256: sha(buildSourceXml({ variant })) }],
        partA: {
            title: 'Part A: blind labels',
            provisions: [
                { id: 'lib-loans', citation: 'Synthetic Library Act §1', topic: 'Books', jurisdiction: 'federal', sourceId: 'lib', rows: [
                    { id: 'lib-loans.limit', label: '§1(a)', contexts: [], text: ROW_1 },
                    { id: 'lib-loans.notice', label: '§1(b)', contexts: [], text: ROW_2 },
                ] },
                { id: 'lib-renewal', citation: 'Synthetic Library Act §2, with chapeau', topic: 'Books', jurisdiction: 'federal', sourceId: 'lib', rows: [
                    { id: 'lib-renewal.rule', label: '§2(a)', contexts: [CONTEXT_3], text: row3 },
                ] },
            ],
            rowCount: 3,
        },
        partB: {
            title: 'Part B: control judgments (after Part A)',
            items: [
                { id: 'ctl-s1', rowId: 'lib-loans.notice', form: 'single', ask: 'accept or reject', proposed: { category: 'condition', quote: 'within ten days after an item becomes overdue', numeric: { value: 10, unit: 'day', operator: '<=' } } },
                { id: 'ctl-p1', rowId: 'lib-loans.limit', form: 'pair', ask: 'equivalent or different', proposed: [{ category: 'exception', quote: 'unless the holder has an overdue item' }, { category: 'condition', quote: 'unless the holder has an overdue item' }] },
            ],
        },
        partC: {
            title: 'Part C: same outcome, different meaning? (after Part B)',
            items: [
                { id: 'vpu-s1', rowId: 'lib-other.rule', citation: 'Synthetic Library Act §9', label: 'exception-removed', removedText: 'unless the fine is waived', alsoReworded: [], sourceText: 'A holder shall pay the posted fine, unless the fine is waived.', versions: { original: ['Who: A holder', 'Rule (shall): pay the posted fine', 'Exception: The fine may be waived.'], mutant: ['Who: A holder', 'Rule (shall): pay the posted fine'] }, example: { description: 'A holder returns a book late and no waiver is requested.', original: 'required', mutant: 'required' }, ask: 'exampleOutcomeSame yes or no; meaning same or different; if different, a case where they part' },
            ],
        },
    };
}

function buildRoster() {
    return {
        schemaVersion: '1.0.0',
        purpose: 'synthetic roster',
        provisions: [
            { id: 'lib-loans', role: 'hard', sourceId: 'lib', sourceUnit: '/syn/lib/s1', rows: [{ id: 'lib-loans.limit', contexts: [] }, { id: 'lib-loans.notice', contexts: [], within: WITHIN_2 }] },
            { id: 'lib-renewal', role: 'hard', sourceId: 'lib', sourceUnit: '/syn/lib/s2/a', rationale: 'NEVER SHOWN', traits: ['nested-exception'], rows: [{ id: 'lib-renewal.rule', contexts: [{ sourceUnit: '/syn/lib/s2', quote: CONTEXT_3 }] }] },
        ],
    };
}

/**
 * Write packet + roster + corpus into a fresh temp ledger dir
 * (<ledgerDir>/gold-set, <ledgerDir>/sources); returns { ledgerDir, goldDir,
 * packetDir, sourcesDir, write(variant) }. Remove `ledgerDir` afterwards.
 */
function writePacketFixture({ variant = 'base' } = {}) {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-groundrules-ledger-'));
    const goldDir = path.join(ledgerDir, 'gold-set');
    const packetDir = path.join(goldDir, 'packet');
    const sourcesDir = path.join(ledgerDir, 'sources');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(sourcesDir, { recursive: true });
    const write = v => {
        const packet = buildPacket({ variant: v });
        fs.writeFileSync(path.join(packetDir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
        fs.writeFileSync(path.join(goldDir, 'roster.json'), `${JSON.stringify(buildRoster(), null, 2)}\n`);
        fs.writeFileSync(path.join(sourcesDir, 'lib.xml'), buildSourceXml({ variant: v }));
        fs.writeFileSync(path.join(sourcesDir, 'manifest.json'), `${JSON.stringify(buildManifest({ variant: v }), null, 2)}\n`);
        return packet;
    };
    const packet = write(variant);
    return { ledgerDir, goldDir, packetDir, sourcesDir, packet, write, rows: { ROW_1, ROW_2, ROW_3, CONTEXT_3, WITHIN_2, UNIT_REPEAT } };
}

module.exports = { buildPacket, buildRoster, buildSourceXml, buildManifest, writePacketFixture, ROW_1, ROW_2, ROW_3, CONTEXT_3, WITHIN_2, UNIT_REPEAT };
