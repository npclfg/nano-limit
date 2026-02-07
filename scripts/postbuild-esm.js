#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const esmDir = path.join(__dirname, "..", "dist", "esm");
const packageJson = path.join(esmDir, "package.json");

fs.writeFileSync(packageJson, JSON.stringify({ type: "module" }, null, 2) + "\n");
