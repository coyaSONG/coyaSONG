#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const START_MARKER = "<!-- OSS-ACTIVITY:START -->";
const END_MARKER = "<!-- OSS-ACTIVITY:END -->";
const PROJECT_START_MARKER = "<!-- PROJECT-PULSE:START -->";
const PROJECT_END_MARKER = "<!-- PROJECT-PULSE:END -->";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_RESULTS = 1_000;
const RECENT_LIMIT = 5;
const FEATURED_PROJECTS = [
  { repository: "coyaSONG/youtube-mcp-server", label: "YouTube Research MCP" },
  { repository: "coyaSONG/ralph-research", label: "ralph-research" },
  { repository: "coyaSONG/tmuxicate", label: "tmuxicate" },
];

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

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": `${username}-profile-readme`,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function githubRequest(path, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders() });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${path}: ${body}`);
  }
  return response.json();
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
  return githubRequest(`/search/issues?${parameters}`);
}

async function loadProjectPulse() {
  return Promise.all(FEATURED_PROJECTS.map(async (project) => {
    const encodedRepository = project.repository.split("/").map(encodeURIComponent).join("/");
    const [repository, release] = await Promise.all([
      githubRequest(`/repos/${encodedRepository}`),
      githubRequest(`/repos/${encodedRepository}/releases/latest`, { allowNotFound: true }),
    ]);

    return {
      ...project,
      stars: repository.stargazers_count,
      repositoryUrl: repository.html_url,
      release: release ? {
        name: release.name || release.tag_name,
        url: release.html_url,
      } : null,
    };
  }));
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

function renderProjectPulse(projects) {
  const rows = projects.map((project) => {
    const release = project.release
      ? `[${escapeMarkdown(project.release.name)}](${project.release.url})`
      : "No tagged release yet";
    return `| [${escapeMarkdown(project.label)}](${project.repositoryUrl}) | ${project.stars.toLocaleString("en-US")} | ${release} |`;
  });
  const updatedDate = new Date().toISOString().slice(0, 10);

  return [
    PROJECT_START_MARKER,
    "| Project | Stars | Latest release |",
    "| --- | ---: | --- |",
    ...rows,
    "",
    `_Last updated ${updatedDate} via GitHub Actions._`,
    PROJECT_END_MARKER,
  ].join("\n");
}

function replaceSection(readme, startMarker, endMarker, replacement) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`README markers are missing or out of order: ${startMarker}`);
  }

  return `${readme.slice(0, start)}${replacement}${readme.slice(end + endMarker.length)}`;
}

async function main() {
  const readme = await readFile(readmePath, "utf8");
  const [items, projects] = await Promise.all([
    loadMergedPullRequests(),
    loadProjectPulse(),
  ]);
  const withActivity = replaceSection(readme, START_MARKER, END_MARKER, renderActivity(items));
  const updated = replaceSection(
    withActivity,
    PROJECT_START_MARKER,
    PROJECT_END_MARKER,
    renderProjectPulse(projects),
  );

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
