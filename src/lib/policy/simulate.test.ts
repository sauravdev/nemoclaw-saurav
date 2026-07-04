// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseTraceLines, simulate, renderSimulationReport } from "./simulate";

const SLACK_PRESET = {
  name: "slack",
  endpoints: [
    {
      host: "slack.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }, { allow: { method: "POST", path: "/**" } }],
    },
    {
      host: "*.slack.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }, { allow: { method: "POST", path: "/**" } }],
    },
  ],
};

const GITHUB_PRESET = {
  name: "github",
  endpoints: [
    {
      host: "api.github.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }],
    },
    {
      host: "raw.githubusercontent.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }],
    },
  ],
};

describe("parseTraceLines", () => {
  it("parses valid JSONL lines", () => {
    const lines = [
      '{"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}',
      '{"host":"api.github.com","port":443}',
    ];
    const result = parseTraceLines(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ host: "api.slack.com", port: 443 });
    expect(result[1]).toMatchObject({ host: "api.github.com" });
  });

  it("skips blank lines and comment lines", () => {
    const lines = ["", "# comment", '{"host":"api.slack.com"}'];
    expect(parseTraceLines(lines)).toHaveLength(1);
  });

  it("skips lines without a host field", () => {
    const lines = ['{"port":443,"method":"GET"}'];
    expect(parseTraceLines(lines)).toHaveLength(0);
  });

  it("skips invalid JSON", () => {
    const lines = ["not-json", '{"host":"api.slack.com"}'];
    expect(parseTraceLines(lines)).toHaveLength(1);
  });
});

describe("simulate", () => {
  it("allows a request matching an active preset", () => {
    const req = { host: "api.slack.com", port: 443, method: "POST", path: "/api/chat.postMessage" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].allowedBy).toBe("slack");
  });

  it("marks a request as uncovered when no preset matches the host", () => {
    const req = { host: "api.openai.com", port: 443, method: "POST" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("uncovered");
  });

  it("allows requests to wildcard subdomains", () => {
    const req = { host: "files.slack.com", port: 443, method: "GET", path: "/files/foo" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("allowed");
  });

  it("respects method restrictions", () => {
    const presetWithGetOnly = {
      name: "restricted",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
        },
      ],
    };
    const postReq = { host: "api.example.com", port: 443, method: "POST" };
    const getReq = { host: "api.example.com", port: 443, method: "GET" };
    const postSummary = simulate([postReq], [presetWithGetOnly]);
    const getSummary = simulate([getReq], [presetWithGetOnly]);
    expect(postSummary.results[0].verdict).toBe("uncovered");
    expect(getSummary.results[0].verdict).toBe("allowed");
  });

  it("counts multiple verdicts correctly", () => {
    const requests = [
      { host: "api.slack.com", port: 443, method: "POST" },
      { host: "api.github.com", port: 443, method: "GET" },
      { host: "evil.example.com", port: 80, method: "GET" },
    ];
    const summary = simulate(requests, [SLACK_PRESET, GITHUB_PRESET]);
    expect(summary.allowed).toBe(2);
    expect(summary.uncovered).toBe(1);
    expect(summary.blocked).toBe(0);
  });

  it("uses first matching preset when multiple could match", () => {
    const req = { host: "api.slack.com", port: 443, method: "GET" };
    const summary = simulate([req], [SLACK_PRESET, GITHUB_PRESET]);
    expect(summary.results[0].allowedBy).toBe("slack");
  });

  it("allows monitor-mode endpoints regardless of rules", () => {
    const monitorPreset = {
      name: "monitor",
      endpoints: [{ host: "api.example.com", port: 443, enforcement: "monitor" }],
    };
    const req = { host: "api.example.com", port: 443, method: "DELETE" };
    const summary = simulate([req], [monitorPreset]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].matchedRule).toContain("monitor");
  });
});

describe("renderSimulationReport", () => {
  it("renders JSON when json=true", () => {
    const summary = simulate(
      [{ host: "api.slack.com", port: 443 }],
      [SLACK_PRESET],
    );
    const report = renderSimulationReport(summary, true);
    const parsed = JSON.parse(report) as { totalRequests: number };
    expect(parsed.totalRequests).toBe(1);
  });

  it("renders human-readable report", () => {
    const requests = [
      { host: "api.slack.com", port: 443, method: "POST" },
      { host: "unknown.example.com", port: 443 },
    ];
    const summary = simulate(requests, [SLACK_PRESET]);
    const report = renderSimulationReport(summary, false);
    expect(report).toContain("ALLOWED");
    expect(report).toContain("UNCOVERED");
    expect(report).toContain("slack");
  });
});
