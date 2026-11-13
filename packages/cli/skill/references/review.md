# Reading a report and a review

`archipel deploy`, `report` and `promote` return the same version, with its report.

## Useful fields

| Field | Meaning |
| --- | --- |
| `id` | Version id (`rel…`), to pass to `report`, `logs` and `promote` |
| `status` | Where the version stands, see below |
| `next` | What to do now |
| `summary` | One line: the reason for the failure, or "Ready for review" |
| `reviewUrl` | Page where a person decides. Give it to the person. |
| `previewUrl` | The app in preview, on empty tables. A signed-in person opens it. |
| `flags` | What draws the reviewer's attention: `permissions`, `exposure`, `destructive`, `findings` |
| `decision_comment` | The reviewer's comment, after their decision |
| `decided_by`, `decided_at` | Who decided, and when |
| `logs` | Pipeline and preview logs, `level` set to `info`, `warn` or `error` |
| `report.stages` | Stages run, with their `status` and `detail` |

## Statuses

| `status` | Meaning | To do |
| --- | --- | --- |
| `processing` | Pipeline running | `archipel report <id>` a little later |
| `failed` | A stage failed: nothing waits for a decision | Read the failed stage, fix, deploy again |
| `in_review` | Tests passed, a person must decide | Give `reviewUrl` and `previewUrl`, summarise, then `promote --wait` if asked |
| `changes_requested` | The reviewer asks for changes | Handle `decision_comment` point by point, deploy again |
| `rejected` | Version rejected | Stop, explain, wait for the person's agreement |
| `live` | Live | Done |
| `superseded` | Replaced by a more recent submission | Follow the most recent one |

## Pipeline stages

The last entry of `report.stages` is the one that failed. The detail is in the matching section.

1. **`validate`**: `report.validation.errors`. Each error has `path`, `message` and `hint`, often `received` and `expected`. Apply the `hint`. An error on `id` saying "This token is not allowed" means the token is limited to other apps.
2. **`scan`**: `report.scan.findings`, each with `id`, `severity`, `title`, `hint`, `file` and `line`. `severity: block` stops everything, without running any code: remove what is reported. `warn` is shown to the reviewer: fix it if it is a real problem, otherwise explain it to the person.
3. **`diff`**: `report.diff` compares with the live version. `schema` lists table changes, each with `destructive` and `reason`. `permissions` and `exposure` list what is added (`added`) and removed (`removed`). `firstRelease` is true for a first version.
4. **`preview`**: the app starts on its own empty tables. A failure here often comes from a controller that does not load: read `archipel logs <id> --level error`.
5. **`checks`**: `report.checks.health` gives the status and body of `health`. `report.checks.smoke` lists each test with `name`, `ok`, `status`, `expected` and `message` (the body received). `generated: true` marks a test the platform created from the manifest.

A failing generated test usually reveals an inconsistent manifest: a required column that cannot be filled, `rbac` too broad or too narrow, an invalid `default`.

## The human decision

The reviewer sees the manifest, the files, the diff, the scan, the tests and the preview. They can:

- **approve**: the migration is applied and the version goes live. A destructive or permission change requires an explicit confirmation from them;
- **request changes**: `decision_comment` says what. Your next submission must answer it, and your message to the person must say how each point was handled;
- **reject**: the version can never go live.

After an approval, `report.liveHealth` gives the result of `health` on the live version. If it fails, an alert warns the administrators: suggest a fix, or `archipel rollback <app> --reason "<reason>"`, which only asks a person to roll back.

## Summarising for the person

When a version reaches `in_review`, write a few lines:

- what the version does;
- what the reviewer must look at: added permissions and exposed data, schema changes (destructive or not), scan findings, with the reason for each;
- how to test the preview, which starts from empty tables;
- the `reviewUrl` and `previewUrl` links.
