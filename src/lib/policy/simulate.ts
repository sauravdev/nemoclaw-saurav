// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy simulation engine.
 *
 * Evaluates a list of observed network requests against the active (or a
 * candidate) NemoClaw policy to determine which requests would be allowed,
 * blocked, or not covered by any preset.
 *
 * Trace file format — one JSON object per line (JSONL):
 *   {"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}
 *
 * Only `host` is required. Missing `port`, `method`, and `path` are treated
 * as wildcards (match any endpoint with that host regardless of method/path).
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { PolicyObject } from "./preset-parsing";
import { isPolicyDocument, isPolicyObject } from "./preset-parsing";

export type SimulateVerdict = "allowed" | "blocked" | "uncovered";

export interface TraceRequest {
  host: string;
  port?: number;
  method?: string;
  path?: string;
  /** Optional label for display (e.g., which agent or command produced it) */
  label?: string;
}

export interface SimulateResult {
  request: TraceRequest;
  verdict: SimulateVerdict;
  /** Preset name that allows this request, when verdict is "allowed" */
  allowedBy?: string;
  /** Rule description, when verdict is "allowed" */
  matchedRule?: string;
}

export interface SimulationSummary {
  totalRequests: number;
  allowed: number;
  blocked: number;
  uncovered: number;
  results: SimulateResult[];
}

interface PolicyEndpoint {
  host: string;
  port?: number | string;
  protocol?: string;
  enforcement?: string;
  rules?: Array<{ allow?: { method?: string; path?: string } }>;
}

interface ParsedPreset {
  name: string;
  endpoints: PolicyEndpoint[];
}

/**
 * Match a glob pattern against a string.
 * Supports `*` (any single segment) and `**` (any number of segments).
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "**" || pattern === "*") return true;
  // Escape regex special chars except * which becomes .* or [^/]*
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function hostMatches(pattern: string, host: string): boolean {
  return globMatch(pattern, host);
}

function portMatches(endpointPort: number | string | undefined, requestPort: number | undefined): boolean {
  if (endpointPort === undefined || endpointPort === "*") return true;
  if (requestPort === undefined) return true;
  return Number(endpointPort) === requestPort;
}

function ruleMatches(
  rule: { allow?: { method?: string; path?: string } } | undefined,
  method: string | undefined,
  reqPath: string | undefined,
): boolean {
  if (!rule?.allow) return false;
  const { method: ruleMethod, path: rulePath } = rule.allow;
  if (ruleMethod && method && !globMatch(ruleMethod, method)) return false;
  if (rulePath && reqPath && !globMatch(rulePath, reqPath)) return false;
  return true;
}

function endpointAllows(endpoint: PolicyEndpoint, req: TraceRequest): string | null {
  if (!hostMatches(endpoint.host, req.host)) return null;
  if (!portMatches(endpoint.port, req.port)) return null;
  if (endpoint.enforcement === "monitor") {
    // monitor-only endpoints always allow for simulation purposes
    return "monitor (allowed but observed)";
  }
  if (!endpoint.rules || endpoint.rules.length === 0) {
    return "default allow (no rules)";
  }
  for (const rule of endpoint.rules) {
    if (ruleMatches(rule, req.method, req.path)) {
      const m = rule.allow?.method ?? "*";
      const p = rule.allow?.path ?? "/**";
      return `allow ${m} ${p}`;
    }
  }
  return null;
}

function extractEndpoints(policyMap: PolicyObject): ParsedPreset[] {
  const presets: ParsedPreset[] = [];
  for (const [presetName, presetVal] of Object.entries(policyMap)) {
    if (!isPolicyObject(presetVal)) continue;
    const networkPolicies = presetVal["network_policies"];
    const topLevelEndpoints = presetVal["endpoints"];

    // Support both preset-level endpoints and nested network_policies
    const policyBlock: PolicyObject = isPolicyObject(networkPolicies)
      ? networkPolicies
      : isPolicyObject(presetVal)
        ? presetVal
        : {};

    const endpoints: PolicyEndpoint[] = [];

    if (Array.isArray(topLevelEndpoints)) {
      for (const ep of topLevelEndpoints) {
        if (isPolicyObject(ep) && typeof ep["host"] === "string") {
          endpoints.push(ep as unknown as PolicyEndpoint);
        }
      }
    }

    for (const [, policyVal] of Object.entries(policyBlock)) {
      if (!isPolicyObject(policyVal)) continue;
      const epList = policyVal["endpoints"];
      if (!Array.isArray(epList)) continue;
      for (const ep of epList) {
        if (isPolicyObject(ep) && typeof ep["host"] === "string") {
          endpoints.push(ep as unknown as PolicyEndpoint);
        }
      }
    }

    if (endpoints.length > 0) presets.push({ name: presetName, endpoints });
  }
  return presets;
}

/**
 * Load and parse a policy YAML file into a flat list of endpoint presets.
 */
export function loadPolicyFile(filePath: string): ParsedPreset[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);
  if (!isPolicyDocument(parsed)) return [];

  const networkPolicies = parsed["network_policies"];
  if (!isPolicyObject(networkPolicies)) return [];

  return extractEndpoints(networkPolicies);
}

/**
 * Parse a JSONL trace file into an array of TraceRequests.
 * Lines that are not valid JSON or lack a `host` field are silently skipped.
 */
export function loadTraceFile(filePath: string): TraceRequest[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseTraceLines(raw.split("\n"));
}

export function parseTraceLines(lines: string[]): TraceRequest[] {
  const requests: TraceRequest[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.host !== "string") continue;
      requests.push({
        host: obj.host,
        port: typeof obj.port === "number" ? obj.port : undefined,
        method: typeof obj.method === "string" ? obj.method : undefined,
        path: typeof obj.path === "string" ? obj.path : undefined,
        label: typeof obj.label === "string" ? obj.label : undefined,
      });
    } catch {
      // skip malformed lines
    }
  }
  return requests;
}

/**
 * Evaluate a list of trace requests against the given presets.
 */
export function simulate(requests: TraceRequest[], presets: ParsedPreset[]): SimulationSummary {
  const results: SimulateResult[] = [];

  for (const req of requests) {
    let verdict: SimulateVerdict = "uncovered";
    let allowedBy: string | undefined;
    let matchedRule: string | undefined;

    for (const preset of presets) {
      for (const endpoint of preset.endpoints) {
        const rule = endpointAllows(endpoint, req);
        if (rule !== null) {
          verdict = "allowed";
          allowedBy = preset.name;
          matchedRule = rule;
          break;
        }
      }
      if (verdict === "allowed") break;
    }

    results.push({ request: req, verdict, allowedBy, matchedRule });
  }

  const allowed = results.filter((r) => r.verdict === "allowed").length;
  const blocked = results.filter((r) => r.verdict === "blocked").length;
  const uncovered = results.filter((r) => r.verdict === "uncovered").length;

  return { totalRequests: results.length, allowed, blocked, uncovered, results };
}

/**
 * Render a simulation summary as a human-readable report.
 */
export function renderSimulationReport(summary: SimulationSummary, json: boolean): string {
  if (json) return JSON.stringify(summary, null, 2);

  const lines: string[] = [];
  lines.push(`Policy Simulation — ${summary.totalRequests} requests evaluated`);
  lines.push(
    `  Allowed: ${summary.allowed}  Blocked: ${summary.blocked}  Uncovered: ${summary.uncovered}`,
  );
  lines.push("");

  const groups: Record<SimulateVerdict, SimulateResult[]> = {
    allowed: [],
    blocked: [],
    uncovered: [],
  };
  for (const r of summary.results) groups[r.verdict].push(r);

  if (groups.allowed.length > 0) {
    lines.push("ALLOWED");
    for (const r of groups.allowed) {
      const req = formatReq(r.request);
      lines.push(`  ✓ ${req}  → ${r.allowedBy} (${r.matchedRule})`);
    }
    lines.push("");
  }

  if (groups.blocked.length > 0) {
    lines.push("BLOCKED");
    for (const r of groups.blocked) {
      lines.push(`  ✗ ${formatReq(r.request)}`);
    }
    lines.push("");
  }

  if (groups.uncovered.length > 0) {
    lines.push("UNCOVERED (no preset rule matches)");
    for (const r of groups.uncovered) {
      lines.push(`  ? ${formatReq(r.request)}`);
    }
    lines.push("");
    lines.push(
      `  ${summary.uncovered} request(s) are not covered by any active preset.` +
        ` The sandbox will block them unless you add a matching preset.`,
    );
  }

  return lines.join("\n");
}

function formatReq(req: TraceRequest): string {
  const port = req.port ? `:${req.port}` : "";
  const method = req.method ? `${req.method} ` : "";
  const reqPath = req.path ?? "";
  const label = req.label ? ` [${req.label}]` : "";
  return `${method}${req.host}${port}${reqPath}${label}`;
}
