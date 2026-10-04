#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateWorkbench } from "./generate-readonly-workbench.mjs";

export async function generateDraftWorkbench(modelPath, outputPath) {
  return generateWorkbench(modelPath, outputPath, { mode: "draft" });
}

function parseCli(argv) {
  const positional = [];
  let output = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") output = argv[++index];
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  return { modelPath: positional[0], output, help };
}

function helpText() {
  return `Usage: node scripts/generate-draft-workbench.mjs <model.json> --output <directory>\n\n`
    + `Creates a dependency-free workbench with browser-local draft tuning. Game source files remain untouched.\n`;
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.help || !args.modelPath || !args.output) {
      console.log(helpText());
      process.exitCode = args.help ? 0 : 1;
      return;
    }
    const result = await generateDraftWorkbench(args.modelPath, args.output);
    console.error(`Draft workbench generated: ${result.outputRoot}`);
    console.error(`Image previews copied: ${result.metadata.copiedPreviews}`);
  } catch (error) {
    console.error(`Draft workbench generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
