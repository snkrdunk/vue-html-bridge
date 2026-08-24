#!/usr/bin/env node
// stdio entry point (language-server.md §2): run as
// `vue-html-bridge-language-server --stdio`. stdout is reserved for
// JSON-RPC; createConnection() with no stream arguments reads the transport
// from argv itself (--stdio here; --node-ipc/--socket=<n> are the library's
// other options, unused by this binary). Logs go to stderr via the
// connection's console, never stdout.
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
