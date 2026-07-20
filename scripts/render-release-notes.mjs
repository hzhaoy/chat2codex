#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function normalizeVersion(tagOrVersion) {
  const version = tagOrVersion.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${tagOrVersion}`);
  }
  return version;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractReleaseNotes(changelog, tagOrVersion) {
  const version = normalizeVersion(tagOrVersion);
  const heading = new RegExp(
    `^##\\s+${escapeRegExp(version)}(?:\\s+-\\s+.+)?\\s*$`,
  );
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }

  const nextHeading = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line),
  );
  const end = nextHeading < 0 ? lines.length : nextHeading;
  const notes = lines.slice(start + 1, end).join("\n").trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md section for ${version} is empty`);
  }

  return notes.replace(/^(#{3,6})(?=\s)/gm, (marks) => marks.slice(1));
}

export function findPreviousTag(tags, currentTag) {
  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex < 0) {
    throw new Error(`Git tag ${currentTag} is not available in the checkout`);
  }
  return tags[currentIndex + 1];
}

export function renderReleaseNotes({
  changelog,
  currentTag,
  previousTag,
  repository,
  serverUrl = "https://github.com",
}) {
  const notes = extractReleaseNotes(changelog, currentTag);
  if (!previousTag) {
    return notes;
  }

  const baseUrl = serverUrl.replace(/\/$/, "");
  return `${notes}\n\n**Full Changelog**: ${baseUrl}/${repository}/compare/${previousTag}...${currentTag}`;
}

function repositoryFromPackageJson(path) {
  const packageJson = JSON.parse(readFileSync(path, "utf8"));
  const repository =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;
  if (!repository) {
    throw new Error("package.json has no repository URL");
  }

  const normalized = repository.replace(/^git\+/, "");
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Cannot derive GitHub repository from ${repository}`);
  }
  return match[1];
}

function listReachableReleaseTags(currentTag) {
  const output = execFileSync(
    "git",
    [
      "tag",
      "--merged",
      currentTag,
      "--sort=-version:refname",
      "--list",
      "v[0-9]*",
    ],
    { encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function main() {
  const currentTag = process.argv[2];
  const changelogPath = process.argv[3] ?? "CHANGELOG.md";
  if (!currentTag) {
    throw new Error(
      "Usage: node scripts/render-release-notes.mjs <vVERSION> [CHANGELOG.md]",
    );
  }

  const tags = listReachableReleaseTags(currentTag);
  const previousTag = findPreviousTag(tags, currentTag);
  const repository =
    process.env.GITHUB_REPOSITORY ?? repositoryFromPackageJson("package.json");
  const releaseNotes = renderReleaseNotes({
    changelog: readFileSync(changelogPath, "utf8"),
    currentTag,
    previousTag,
    repository,
    serverUrl: process.env.GITHUB_SERVER_URL,
  });
  process.stdout.write(`${releaseNotes}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
