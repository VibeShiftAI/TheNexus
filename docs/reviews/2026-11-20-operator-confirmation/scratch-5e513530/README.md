# Scratch evidence of task 5e513530, moved here

Task 5e513530 ("Close executor-via-browser path to local operator authority and prove live
decisions"; board status completed, last updated 2026-11-21T00:59:36Z) kept these nine files in `/Volumes/Projects/.scratch-5e513530`,
outside every repository. Its reports cite them there, and no other copy existed. On 2026-11-26
(UTC) task e1f0168d moved them into this folder, unchanged, so the evidence stays with the review it
supports. The scratch folder was then removed.

Where the reports cite them. The reports still name the old scratch paths, which no longer exist; the files
they name are the ones in this folder:

| File | Cited by |
| --- | --- |
| `round2-recheck.cjs` | `../qa-round-2-ruling.txt` line 22 ("Run through .../round2-recheck.cjs"); the task walkthrough's read-only recheck |
| `round2-recheck.txt` | the task walkthrough (listed among the files the run wrote); it is the raw output behind sections A to D of `../qa-round-2-ruling.txt`, written at 2026-11-21T00:45:42Z, the run time line 22 names |
| `round2-confirmation.txt` | raw output of the confirmation suite run in `../qa-round-2-ruling.txt` section E (00:45:49Z, 26 tests passed); the walkthrough's "the recheck and scan scripts and their logs" |
| `encoding-scan.cjs` | `../qa-round-2-ruling.txt` line 123 (section F); the task walkthrough's encoding check |
| `server-full.txt`, `server-affected.txt`, `server-confirmation.txt`, `dashboard-full.txt`, `dashboard-tsc.txt` | `../recovery-recheck.txt` lines 28 to 31 (the scratch folder, then "The full logs stay there") |

The `tmp` and `jest-cache` directories those reports also name were deleted by task 5e513530
itself, as its walkthrough says; there was nothing of them to move.

Bytes, checked before the move and against the committed copies after it:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| dashboard-full.txt | 140096 | 762ce6875f4e8bdaea0ac75e1b89b4eac78135ba485cc10feba654f0662adec6 |
| dashboard-tsc.txt | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| encoding-scan.cjs | 1349 | a9058ae3efa4c93e1aa264c18ad7b84d393ac85e129135a6e91db54d2f49df69 |
| round2-confirmation.txt | 7754 | 8b66bbe14f7a96dfbabbbd996a4ebc12916316fe882e066c17866f936a777992 |
| round2-recheck.cjs | 3509 | 7e5fb8fcf389409d51e83698af422d6f214624eaaa10c5068bd5c775d1efdf1f |
| round2-recheck.txt | 4114 | 32cb1ea7a8cdc65bae1b7875930dcc07421acca902af0baa65ea080984a22610 |
| server-affected.txt | 123821 | 01cae302d7faee613b8818571ab340d1f7d8f271d3509f7110e1aa088cdb1e25 |
| server-confirmation.txt | 7771 | d38005d7b8ca6c96deb1dbea7055468f5ab4d67e477fb6128a4013354c7c48ae |
| server-full.txt | 1078604 | 94492cb88ed77ebc9a39fc067be913b5b21e76a876abc3186962b7514c79d3ac |

The two scripts are kept as evidence of how the ruling was produced. They read absolute paths
from the time of the review and are not meant to be run from here.
