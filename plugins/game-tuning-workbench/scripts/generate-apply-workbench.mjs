#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateWorkbench } from "./generate-readonly-workbench.mjs";

export async function generateApplyWorkbench(modelPath, outputPath) {
  return generateWorkbench(modelPath, outputPath, { mode: "apply" });
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
  return `Usage: node scripts/generate-apply-workbench.mjs <model.json> --output <directory>\n\n`
    + `Creates a confirmation-and-apply workbench. The generated UI still needs the local server's explicit --allow-source-write gate.\n`;
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    if (args.help || !args.modelPath || !args.output) {
      console.log(helpText());
      process.exitCode = args.help ? 0 : 1;
      return;
    }
    const result = await generateApplyWorkbench(args.modelPath, args.output);
    console.error(`Apply workbench generated: ${result.outputRoot}`);
    console.error(`Image previews copied: ${result.metadata.copiedPreviews}`);
  } catch (error) {
    console.error(`Apply workbench generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
