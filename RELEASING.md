# Releasing

This checklist is for maintainers publishing Chat2Codex to npm and GitHub.

Publishing is triggered by pushing a `v*` git tag. The GitHub Actions workflow
verifies that the tag name matches `package.json` exactly, requires a matching
non-empty `CHANGELOG.md` version section, publishes the npm package, and then
creates the corresponding GitHub Release as the latest release. Release notes
use the changelog's Added, Changed, and Fixed sections and retain a full compare
link to the previous version.

## Prepare the release

1. Start from an up-to-date `main` branch with a clean working tree.

   ```sh
   git checkout main
   git pull --ff-only
   git status --short
   ```

2. Choose the next semantic version, for example `0.4.0`.

3. Bump `package.json` without creating a commit or tag.

   ```sh
   bun pm version <version> --no-git-tag-version
   ```

   Use the plain semantic version here, such as `0.4.0`, not `v0.4.0`. The
   leading `v` is only used for git tags.

   Do not use the default `bun pm version` behavior here. By default, Bun can
   create git release metadata before the changelog and release checks are done.

4. Move the relevant `CHANGELOG.md` entries from `Unreleased` to the new version
   heading. This version section becomes the GitHub Release body, so keep it
   non-empty and organize the user-visible changes under headings such as
   `Added`, `Changed`, and `Fixed`.

   ```md
   ## Unreleased

   ## <version> - YYYY-MM-DD
   ```

5. Run the release checks.

   ```sh
   bun run release:check
   ```

## Commit the release prep

1. Review the release diff.

   ```sh
   git diff -- package.json CHANGELOG.md
   ```

2. Commit the version and changelog update.

   ```sh
   git add package.json CHANGELOG.md
   git commit -m "chore(release): prepare v<version>"
   ```

3. Push `main` and wait for CI to pass.

   ```sh
   git push origin main
   ```

## Publish

1. Create and push an annotated release tag.

   ```sh
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

2. Watch the `Publish to npm` workflow. It publishes the npm package first and
   then creates the GitHub Release from the same verified tag and matching
   changelog section.

   ```sh
   gh run list --limit 5
   ```

3. Verify both GitHub Releases and npm show the new version.

   ```sh
   gh release view v<version>
   npm view chat2codex version
   ```

## Recovery notes

- Before the tag is pushed, the release can be abandoned by reverting the local
  version and changelog changes.
- After the tag is pushed, inspect the publish workflow before retrying. If npm
  accepted the version but GitHub Release creation failed, do not republish or
  reuse the version. Create the missing release from the existing tag instead:

  ```sh
  node scripts/render-release-notes.mjs v<version> > /tmp/chat2codex-release-notes.md
  gh release create v<version> --verify-tag --title v<version> \
    --notes-file /tmp/chat2codex-release-notes.md --latest
  ```

- If npm publication itself failed before the version was accepted, fix the
  cause and rerun the existing tag workflow. Never move or replace a published
  release tag.
