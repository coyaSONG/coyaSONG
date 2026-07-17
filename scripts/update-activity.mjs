#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const START_MARKER = "<!-- OSS-ACTIVITY:START -->";
const END_MARKER = "<!-- OSS-ACTIVITY:END -->";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_RESULTS = 1_000;
const RECENT_LIMIT = 5;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const readmePath = resolve(repositoryRoot, "README.md");
const username = process.env.PROFILE_USERNAME || "coyaSONG";
const token = process.env.GITHUB_TOKEN;

function escapeMarkdown(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function repositoryName(item) {
  return item.repository_url.replace("https://api.github.com/repos/", "");
}

async function searchMergedPullRequests(page) {
  const query = `is:pr author:${username} is:merged -user:${username}`;
  const parameters = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(PAGE_SIZE),
    page: String(page),
  });
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": `${username}-profile-readme`,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com/search/issues?${parameters}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function loadMergedPullRequests() {
  const firstPage = await searchMergedPullRequests(1);
  const cappedTotal = Math.min(firstPage.total_count, MAX_RESULTS);
  const pageCount = Math.ceil(cappedTotal / PAGE_SIZE);
  const items = [...firstPage.items];

  for (let page = 2; page <= pageCount; page += 1) {
    const result = await searchMergedPullRequests(page);
    items.push(...result.items);
  }

  return items
    .filter((item) => item.pull_request?.merged_at)
    .sort((left, right) => right.pull_request.merged_at.localeCompare(left.pull_request.merged_at));
}

function renderActivity(items) {
  const repositories = new Set(items.map(repositoryName));
  const summary = `**${items.length} merged pull requests across ${repositories.size} public projects.**`;
  const recent = items.slice(0, RECENT_LIMIT).map((item) => {
    const repository = repositoryName(item);
    const mergedDate = item.pull_request.merged_at.slice(0, 10);
    return `- [${escapeMarkdown(repository)}](${item.html_url}) — ${escapeMarkdown(item.title)} (${mergedDate})`;
  });
  const updatedDate = new Date().toISOString().slice(0, 10);

  return [
    START_MARKER,
    summary,
    "",
    "Latest upstream merges:",
    "",
    ...recent,
    "",
    `_Last updated ${updatedDate} via GitHub Actions._`,
    END_MARKER,
  ].join("\n");
}

async function main() {
  const readme = await readFile(readmePath, "utf8");
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("README activity markers are missing or out of order");
  }

  const items = await loadMergedPullRequests();
  const replacement = renderActivity(items);
  const updated = `${readme.slice(0, start)}${replacement}${readme.slice(end + END_MARKER.length)}`;

  if (process.argv.includes("--check")) {
    if (updated !== readme) {
      throw new Error("README activity section is out of date");
    }
    return;
  }

  if (updated !== readme) {
    await writeFile(readmePath, updated, "utf8");
  }
}

await main();
