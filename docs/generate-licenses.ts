#!/usr/bin/env bun
/**
 * Unified License Generator for MentraOS Monorepo
 *
 * Scans all JS/TS packages and Android projects to generate a comprehensive
 * third-party license file for legal compliance.
 *
 * Usage (from repo root):
 *   bun docs/generate-licenses.ts
 *
 * Output:
 *   - docs/static/third-party-licenses.json (downloadable data)
 *   - docs/third-party-licenses.mdx (Mintlify page)
 */

import { $ } from "bun";
import * as fs from "fs";
import * as path from "path";

const ROOT_DIR = path.resolve(import.meta.dir, "..");

// Directories to scan for JS/TS packages (must have package.json and node_modules)
const JS_PACKAGE_DIRS = [
  "mobile",
  "cloud",
  "cloud/packages/sdk",
  "cloud/packages/cloud",
  "cloud/packages/utils",
  "cloud/packages/types",
  "cloud/packages/cli",
  "cloud/packages/react-sdk",
  "cloud/packages/display-utils",
  "cloud/websites/console",
  "cloud/websites/store",
  "cloud/websites/account",
  "cloud/websites/debugger",
];

// Android projects to scan
const ANDROID_DIRS = [
  "asg_client",
  "mobile/android",
];

// Directories to exclude from scanning
const EXCLUDE_PATTERNS = [
  "node_modules",
  ".git",
  "local",
  "archive",
  "build",
  "dist",
  ".expo",
];

interface LicenseInfo {
  name: string;
  version: string;
  license: string;
  repository?: string;
  publisher?: string;
  description?: string;
  source: string; // which package/project uses this
}

interface LicenseSummary {
  generatedAt: string;
  totalPackages: number;
  byLicense: Record<string, number>;
  packages: LicenseInfo[];
}

async function runLicenseChecker(packageDir: string): Promise<LicenseInfo[]> {
  const fullPath = path.join(ROOT_DIR, packageDir);

  // Check if directory exists and has node_modules
  if (!fs.existsSync(fullPath) || !fs.existsSync(path.join(fullPath, "node_modules"))) {
    console.log(`  Skipping ${packageDir} (no node_modules)`);
    return [];
  }

  try {
    // Use license-checker to get all licenses
    const result = await $`cd ${fullPath} && npx license-checker --json --production 2>/dev/null`.text();
    const licenses = JSON.parse(result);

    const packages: LicenseInfo[] = [];

    for (const [pkgName, info] of Object.entries(licenses) as [string, any][]) {
      // Parse package name and version
      const lastAtIndex = pkgName.lastIndexOf("@");
      const name = lastAtIndex > 0 ? pkgName.substring(0, lastAtIndex) : pkgName;
      const version = lastAtIndex > 0 ? pkgName.substring(lastAtIndex + 1) : "unknown";

      packages.push({
        name,
        version,
        license: info.licenses || "Unknown",
        repository: info.repository || undefined,
        publisher: info.publisher || undefined,
        description: info.description || undefined,
        source: packageDir,
      });
    }

    console.log(`  Found ${packages.length} packages in ${packageDir}`);
    return packages;
  } catch (error) {
    console.error(`  Error scanning ${packageDir}:`, error);
    return [];
  }
}

async function scanAndroidLicenses(androidDir: string): Promise<LicenseInfo[]> {
  const fullPath = path.join(ROOT_DIR, androidDir);

  if (!fs.existsSync(fullPath)) {
    console.log(`  Skipping ${androidDir} (not found)`);
    return [];
  }

  // For Android, we'll parse build.gradle files to extract dependencies
  // This is a simplified version - for full accuracy you'd use a Gradle plugin
  const packages: LicenseInfo[] = [];

  try {
    const gradleFiles = await $`find ${fullPath} -name "build.gradle" -o -name "build.gradle.kts" 2>/dev/null`.text();

    for (const gradleFile of gradleFiles.split("\n").filter(Boolean)) {
      if (gradleFile.includes("node_modules")) continue;

      const content = fs.readFileSync(gradleFile, "utf-8");

      // Extract implementation/api dependencies
      const depRegex = /(?:implementation|api|compileOnly)\s*[\(\s]["']([^"']+):([^"']+):([^"']+)["']/g;
      let match;

      while ((match = depRegex.exec(content)) !== null) {
        const [, group, artifact, version] = match;
        packages.push({
          name: `${group}:${artifact}`,
          version,
          license: "See package", // Would need to look up license from Maven Central
          source: androidDir,
        });
      }
    }

    // Dedupe
    const seen = new Set<string>();
    const deduped = packages.filter(pkg => {
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  Found ${deduped.length} Android dependencies in ${androidDir}`);
    return deduped;
  } catch (error) {
    console.error(`  Error scanning ${androidDir}:`, error);
    return [];
  }
}

function deduplicatePackages(packages: LicenseInfo[]): LicenseInfo[] {
  const packageMap = new Map<string, LicenseInfo>();

  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const existing = packageMap.get(key);

    if (existing) {
      // Merge sources
      if (!existing.source.includes(pkg.source)) {
        existing.source = `${existing.source}, ${pkg.source}`;
      }
    } else {
      packageMap.set(key, { ...pkg });
    }
  }

  return Array.from(packageMap.values()).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

function generateMarkdown(summary: LicenseSummary): string {
  let md = `# Third-Party Licenses

*Generated: ${summary.generatedAt}*

This document lists all third-party open-source components used in MentraOS and the Mentra App, along with their respective licenses.

## Summary

- **Total Packages:** ${summary.totalPackages}
- **License Distribution:**
${Object.entries(summary.byLicense)
  .sort((a, b) => b[1] - a[1])
  .map(([license, count]) => `  - ${license}: ${count}`)
  .join("\n")}

## Packages

| Package | Version | License | Source |
|---------|---------|---------|--------|
${summary.packages.map(pkg =>
  `| ${pkg.name} | ${pkg.version} | ${pkg.license} | ${pkg.source} |`
).join("\n")}

## Full License Texts

The full text of each license can be found in the respective package's repository or in the \`node_modules\` directory of each project.

### Common Licenses

#### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

#### Apache License 2.0

Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

#### BSD Licenses

Various BSD licenses (2-clause, 3-clause) permit redistribution with attribution. See individual package repositories for specific terms.

---

*This file is auto-generated. Do not edit manually.*
`;

  return md;
}

function generateMintlifyMDX(summary: LicenseSummary): string {
  const topLicenses = Object.entries(summary.byLicense)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return `---
title: "Third-Party Licenses"
description: "Open source components used in MentraOS and the Mentra App"
---

MentraOS and the Mentra App incorporate third-party open-source components, each governed by its respective license.

**Last Updated:** ${new Date(summary.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

## Summary

- **Total Packages:** ${summary.totalPackages.toLocaleString()}
${topLicenses.map(([license, count]) => `- **${license}:** ${count} packages`).join("\n")}

## License Distribution

| License | Count | Percentage |
|---------|------:|------------|
${Object.entries(summary.byLicense)
  .sort((a, b) => b[1] - a[1])
  .map(([license, count]) => {
    const pct = ((count / summary.totalPackages) * 100).toFixed(1);
    return `| ${license} | ${count} | ${pct}% |`;
  })
  .join("\n")}

## Full Package List

The complete list of all ${summary.totalPackages.toLocaleString()} packages with their licenses is available in the source repository at \`docs/third-party-licenses.json\`.

## Common License Texts

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

### Apache License 2.0

Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at [apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

### ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

### BSD Licenses

Various BSD licenses (2-clause, 3-clause) permit redistribution and use in source and binary forms, with or without modification. See individual package repositories for specific terms.
`;
}

function generateHTML(summary: LicenseSummary): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Third-Party Licenses - MentraOS</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --text: #e5e5e5;
      --muted: #a3a3a3;
      --border: #262626;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 { margin-bottom: 0.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 2rem; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: var(--border);
      padding: 1rem;
      border-radius: 8px;
    }
    .stat-value { font-size: 2rem; font-weight: bold; color: var(--accent); }
    .stat-label { color: var(--muted); font-size: 0.875rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
    }
    th, td {
      text-align: left;
      padding: 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--muted); font-weight: 500; }
    tr:hover { background: rgba(255,255,255,0.02); }
    .license-badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      background: rgba(59, 130, 246, 0.1);
      color: var(--accent);
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .search {
      width: 100%;
      padding: 0.75rem;
      background: var(--border);
      border: none;
      border-radius: 8px;
      color: var(--text);
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    .search:focus { outline: 2px solid var(--accent); }
  </style>
</head>
<body>
  <h1>Third-Party Licenses</h1>
  <p class="subtitle">Generated: ${summary.generatedAt}</p>

  <div class="summary">
    <div class="stat">
      <div class="stat-value">${summary.totalPackages}</div>
      <div class="stat-label">Total Packages</div>
    </div>
    ${Object.entries(summary.byLicense)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([license, count]) => `
    <div class="stat">
      <div class="stat-value">${count}</div>
      <div class="stat-label">${license}</div>
    </div>`).join("")}
  </div>

  <input type="text" class="search" placeholder="Search packages..." id="search">

  <table>
    <thead>
      <tr>
        <th>Package</th>
        <th>Version</th>
        <th>License</th>
        <th>Used In</th>
      </tr>
    </thead>
    <tbody id="packages">
      ${summary.packages.map(pkg => `
      <tr>
        <td>${pkg.name}</td>
        <td>${pkg.version}</td>
        <td><span class="license-badge">${pkg.license}</span></td>
        <td>${pkg.source}</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <script>
    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      document.querySelectorAll('#packages tr').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
      });
    });
  </script>
</body>
</html>`;
}

async function main() {
  console.log("🔍 MentraOS License Generator\n");

  const args = process.argv.slice(2);
  const formatArg = args.find(a => a.startsWith("--format="));
  const formats = formatArg
    ? [formatArg.split("=")[1]]
    : ["mdx", "json"]; // MDX for Mintlify docs + JSON for full package list

  let allPackages: LicenseInfo[] = [];

  // Scan JS/TS packages
  console.log("📦 Scanning JavaScript/TypeScript packages...");
  for (const dir of JS_PACKAGE_DIRS) {
    const packages = await runLicenseChecker(dir);
    allPackages.push(...packages);
  }

  // Scan Android projects
  console.log("\n🤖 Scanning Android projects...");
  for (const dir of ANDROID_DIRS) {
    const packages = await scanAndroidLicenses(dir);
    allPackages.push(...packages);
  }

  // Deduplicate
  console.log("\n🔄 Deduplicating packages...");
  const deduped = deduplicatePackages(allPackages);

  // Calculate license distribution
  const byLicense: Record<string, number> = {};
  for (const pkg of deduped) {
    const license = pkg.license.toString();
    byLicense[license] = (byLicense[license] || 0) + 1;
  }

  const summary: LicenseSummary = {
    generatedAt: new Date().toISOString(),
    totalPackages: deduped.length,
    byLicense,
    packages: deduped,
  };

  // Ensure output directory exists
  const docsDir = path.join(ROOT_DIR, "docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Generate outputs
  console.log("\n📝 Generating output files...");

  if (formats.includes("json")) {
    // Put JSON in docs root - Mintlify serves files from root
    const jsonPath = path.join(docsDir, "third-party-licenses.json");
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`  ✓ ${jsonPath}`);
  }

  if (formats.includes("markdown")) {
    const mdPath = path.join(docsDir, "third-party-licenses.md");
    fs.writeFileSync(mdPath, generateMarkdown(summary));
    console.log(`  ✓ ${mdPath}`);
  }

  if (formats.includes("html")) {
    const htmlPath = path.join(docsDir, "third-party-licenses.html");
    fs.writeFileSync(htmlPath, generateHTML(summary));
    console.log(`  ✓ ${htmlPath}`);
  }

  if (formats.includes("mdx")) {
    const mdxPath = path.join(docsDir, "third-party-licenses.mdx");
    fs.writeFileSync(mdxPath, generateMintlifyMDX(summary));
    console.log(`  ✓ ${mdxPath}`);
  }

  console.log(`
✅ Done! Generated license files for ${summary.totalPackages} packages.

Top licenses:
${Object.entries(byLicense)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([license, count]) => `  - ${license}: ${count}`)
  .join("\n")}
`);
}

main().catch(console.error);
