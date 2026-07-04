// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import readline from "node:readline";

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import {
  loadPolicyFile,
  loadTraceFile,
  parseTraceLines,
  renderSimulationReport,
  simulate,
} from "../../../lib/policy/simulate";
import * as registry from "../../../lib/state/registry";
import { ROOT } from "../../../lib/runner";
import path from "node:path";

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

export default class PolicySimulateCommand extends NemoClawCommand {
  static id = "sandbox:policy:simulate";
  static strict = true;
  static summary = "Simulate a policy against a recorded execution trace";
  static description = `Evaluate which network requests in a trace file would be allowed or blocked by the active (or a candidate) sandbox policy.

Trace files are JSONL — one JSON object per line with at minimum a "host" field:
  {"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}

Use --from-file to provide a recorded trace, or pipe requests to stdin.
Use --policy-file to test a candidate policy YAML without applying it.`;

  static usage = [
    "<name> policy simulate --from-file <trace.jsonl>",
    "<name> policy simulate --policy-file <policy.yaml> --from-file <trace.jsonl>",
    "cat trace.jsonl | <name> policy simulate --from-file -",
  ];

  static examples = [
    "<%= config.bin %> alpha policy simulate --from-file ./agent-trace.jsonl",
    "<%= config.bin %> alpha policy simulate --policy-file ./slack.yaml --from-file ./trace.jsonl",
    '<%= config.bin %> alpha policy simulate --from-file - <<\'EOF\'\n{"host":"api.slack.com","port":443}\nEOF',
    "<%= config.bin %> alpha policy simulate --from-file ./trace.jsonl --json",
  ];

  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      ignoreStdin: true,
      required: true,
    }),
  };

  static flags = {
    "from-file": Flags.string({
      description:
        'Path to a JSONL trace file, or "-" to read from stdin. Each line: {"host":"...","port":443,"method":"GET","path":"/"}',
      required: true,
    }),
    "policy-file": Flags.string({
      description:
        "Path to a candidate policy YAML file to test instead of the active sandbox policy. Useful for previewing a policy before applying it.",
      required: false,
    }),
    "preset-name": Flags.string({
      description:
        "Name to assign to the candidate preset when --policy-file is used. Defaults to the file basename.",
      required: false,
    }),
    json: Flags.boolean({
      description: "Output simulation results as JSON",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicySimulateCommand);
    const { sandboxName } = args;

    // Load the trace
    let requests;
    if (flags["from-file"] === "-") {
      const lines = await readStdin();
      requests = parseTraceLines(lines);
    } else {
      if (!fs.existsSync(flags["from-file"])) {
        this.failWithLines([`Trace file not found: ${flags["from-file"]}`]);
        return;
      }
      requests = loadTraceFile(flags["from-file"]);
    }

    if (requests.length === 0) {
      this.failWithLines([
        "No valid trace requests found. Check that the file is JSONL with a \"host\" field per line.",
      ]);
      return;
    }

    // Load presets: candidate policy OR all active built-in presets for the sandbox
    let presets;
    if (flags["policy-file"]) {
      if (!fs.existsSync(flags["policy-file"])) {
        this.failWithLines([`Policy file not found: ${flags["policy-file"]}`]);
        return;
      }
      presets = loadPolicyFile(flags["policy-file"]);
      if (presets.length === 0) {
        this.failWithLines([
          `No parseable endpoints found in policy file: ${flags["policy-file"]}`,
        ]);
        return;
      }
      if (flags["preset-name"]) {
        presets = presets.map((p) => ({ ...p, name: flags["preset-name"]! }));
      }
    } else {
      presets = loadActivePresetsForSandbox(sandboxName);
      if (presets.length === 0) {
        this.failWithLines([
          `No active policy presets found for sandbox "${sandboxName}".`,
          `Add a preset first: nemoclaw ${sandboxName} policy-add <preset>`,
        ]);
        return;
      }
    }

    const summary = simulate(requests, presets);
    const report = renderSimulationReport(summary, flags.json);
    process.stdout.write(report + (report.endsWith("\n") ? "" : "\n"));

    // Exit with code 1 if any requests are blocked or uncovered
    if (summary.blocked > 0 || summary.uncovered > 0) {
      this.setExitCode(1);
    }
  }
}

function loadActivePresetsForSandbox(sandboxName: string) {
  const sandboxPresets = registry.getPresets(sandboxName) as string[] | undefined;
  if (!sandboxPresets || sandboxPresets.length === 0) return [];

  const { loadPolicyFile } = require("../../../lib/policy/simulate") as typeof import("../../../lib/policy/simulate");
  const presets = [];
  for (const presetName of sandboxPresets) {
    const presetFile = path.join(PRESETS_DIR, `${presetName}.yaml`);
    if (fs.existsSync(presetFile)) {
      try {
        const loaded = loadPolicyFile(presetFile);
        presets.push(...loaded);
      } catch {
        // skip unreadable presets
      }
    }
  }
  return presets;
}

async function readStdin(): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    if (process.stdin.isTTY) {
      resolve([]);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
  });
}
