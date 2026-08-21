#!/usr/bin/env node
// stdio entry point (language-server.md §2). stdout is reserved for
// JSON-RPC; createConnection() with no stream arguments wires stdin/stdout
// by default. Logs go to stderr via the connection's console, never stdout.
import { createConnection } from "vscode-languageserver/node";
import { startLanguageServer } from "./server.js";

const connection = createConnection();

startLanguageServer({
  connection,
  logger: {
    error(message) {
      connection.console.error(message);
    },
  },
});
