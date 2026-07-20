import { describe, expect, test } from "bun:test";
import {
  extractReleaseNotes,
  findPreviousTag,
  renderReleaseNotes,
} from "../scripts/render-release-notes.mjs";

const changelog = `# Changelog

## Unreleased

## 0.4.0 - 2026-07-17

### Added

- Added feature.

### Fixed

- Fixed bug.

## 0.3.0 - 2026-07-06

### Added

- Previous feature.
`;

describe("release notes rendering", () => {
  test("extracts one version and promotes changelog headings", () => {
    expect(extractReleaseNotes(changelog, "v0.4.0")).toBe(
      "## Added\n\n- Added feature.\n\n## Fixed\n\n- Fixed bug.",
    );
  });

  test("appends the previous-tag comparison link", () => {
    expect(
      renderReleaseNotes({
        changelog,
        currentTag: "v0.4.0",
        previousTag: "v0.3.0",
        repository: "hzhaoy/chat2codex",
      }),
    ).toEndWith(
      "**Full Changelog**: https://github.com/hzhaoy/chat2codex/compare/v0.3.0...v0.4.0",
    );
  });

  test("fails when the version section is missing or empty", () => {
    expect(() => extractReleaseNotes(changelog, "v9.9.9")).toThrow(
      "CHANGELOG.md has no section for 9.9.9",
    );
    expect(() =>
      extractReleaseNotes("## 1.0.0\n\n## 0.9.0\n\n- Previous", "v1.0.0"),
    ).toThrow("CHANGELOG.md section for 1.0.0 is empty");
  });

  test("selects the next older version-sorted tag", () => {
    expect(
      findPreviousTag(["v0.4.0", "v0.3.0", "v0.2.0"], "v0.4.0"),
    ).toBe("v0.3.0");
  });
});
