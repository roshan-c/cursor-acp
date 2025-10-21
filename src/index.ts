#!/usr/bin/env node

import { runAcp } from "./internal/acp-entry.js";

// Redirect console logs to stderr to not break ACP stdout
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

runAcp();

process.stdin.resume();
