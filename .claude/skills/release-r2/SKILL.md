---
name: release-r2
description: Build memotepad's macOS .dmg, publish it to Cloudflare R2 under a user-supplied version folder plus `latest`, then commit the version bump, tag it, and push. Use when the user asks to release, ship, publish, cut a version, or upload a build to R2.
---

# Release to R2

Publishes the `.dmg` to Cloudflare R2 under two keys per architecture:

```
{bucket}/memotepad/releases/{version}/memotepad-{arch}.dmg
{bucket}/memotepad/releases/latest/memotepad-{arch}.dmg
```

R2 has no real directories — writing those keys is what creates the
`releases/{version}/` "folder", so no separate mkdir step exists or is needed.

## 1. Get the version — ask if it wasn't given

**The version always comes from the user.** It is never inferred from
`tauri.conf.json`, `package.json`, or git tags, because the folder name is
permanent once published.

- If the user supplied one (`/release-r2 v0.3.0`, "release 0.3.1"), use it.
- If they did **not**, stop and ask which version this release is, before
  building or uploading anything.

Format is strictly `v{major}.{minor}.{patch}` — `v0.3.0`, `v0.3.1`. No suffixes,
no missing `v`. If the user gives `0.3.0`, normalize to `v0.3.0` and say so; if
they give something that isn't three numeric parts (`v0.3`, `v0.3.0-beta`), ask
them to restate it — the script rejects it anyway.

### Bump the version files first

The release version is also the app's own version, so **before building**, set
it in all three files — they must agree:

| File | Line |
| --- | --- |
| `src-tauri/tauri.conf.json` | `"version": "0.3.1"` |
| `package.json` | `"version": "0.3.1"` |
| `src-tauri/Cargo.toml` | `version = "0.3.1"` under `[package]` (line 3 — not the `version = "2"` dependency pins further down) |

Drop the leading `v`: the folder is `v0.3.1`, the files carry `0.3.1`. The build
rewrites `src-tauri/Cargo.lock` to match, so that file is expected to show up
modified too.

If you skip this and the version disagrees with `tauri.conf.json`, the script
prints a warning and continues — the published folder would then disagree with
the version the app reports about itself. Relay the warning and fix it rather
than shipping the mismatch.

## 2. Credentials

Read from `.env` at the repo root (git-ignored — never print the values back to
the user, never commit it). `.env.example` is the template:

| Variable | What it is |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account id — becomes `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 API token access key id (Object Read & Write) |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Target bucket name |

Optional: `R2_PREFIX` (default `memotepad/releases`) and `R2_PUBLIC_BASE_URL`
(e.g. `https://r2-dev.ribbinpo.dev`) — only used to echo the download URL after
upload. If a required variable is missing the script names it; report that
rather than guessing a value or asking for secrets in the chat.

## 3. Publish

```bash
.claude/skills/release-r2/release-r2.sh --version v0.3.0
```

The script builds, then renames the freshly built bundle
(`memotepad_0.3.0_aarch64.dmg`) to the stable published filename
`memotepad-aarch64.dmg`, then PUTs it to both keys. Uploading is a publish:
confirm the version and that `latest/` will be overwritten before the first
real run of a session, and use `--dry-run` if anything is unclear.

Options:

| Flag | Effect |
| --- | --- |
| `--version <vX.Y.Z>` | **Required.** The release folder name. |
| `--target host\|aarch64\|x64\|both` | Which arch to build (default `host`). |
| `--skip-build` | Upload the newest `.dmg` already in `src-tauri/target/`, no rebuild. |
| `--dry-run` | Print the rename and the keys, change and upload nothing. |
| `--no-latest` | Publish only the versioned key. |
| `--selftest` | Verify the SigV4 signer against AWS's test vector. |

The build is a Rust release compile — several minutes. Run it in the foreground
with a generous timeout so failures surface.

## 4. Commit, tag, push

Only after the upload succeeds — a failed build must not leave a version-bump
commit behind. The commit is what the tag points at, so the tag pins the source
that actually produced the published `.dmg`.

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v0.3.1"
git tag v0.3.1
git push origin main --follow-tags
```

Notes on each step:

- **Commit** — include `src-tauri/Cargo.lock`; the build rewrote it. If the
  working tree also holds unrelated edits, commit only these four files and tell
  the user what you left uncommitted.
- **Tag** — annotated is fine (`git tag -a v0.3.1 -m "..."`), but `--follow-tags`
  only pushes annotated tags, so with a lightweight tag push it explicitly:
  `git push origin v0.3.1`.
- **Push** — pushing and tagging are outward-facing and hard to undo once others
  fetch. Invoking this skill authorizes them for *this* release; don't carry that
  approval into a later one. If the tag already exists (a re-publish of the same
  version), say so and leave it alone rather than force-moving it — moving a tag
  others have fetched is the one step to stop and ask about.
- If the branch isn't `main`, push that branch instead and say which one.

## 5. Afterwards

- Report both keys (and the public URLs if `R2_PUBLIC_BASE_URL` is set), plus
  the commit and tag you pushed.
- Offer to update the README download table if its link or version is stale.
  (It currently points at `latest/` with no version in the URL, so usually it
  needs nothing.)

## Notes

- Uploads are hand-signed S3 `PUT`s (openssl + curl), so no `aws`, `wrangler`,
  or `rclone` install is required. On `SignatureDoesNotMatch`, run `--selftest`
  first: if it passes, the signer is fine and the credentials or account id are
  the problem.
- Re-running with the same `--version` overwrites those objects silently.
- The app is unsigned/unnotarized — no Apple secrets involved, and users get the
  Gatekeeper warning the README documents.
- Key layout mirrors `.github/workflows/backup/release.yml`; if that workflow is
  restored, keep both in sync.
