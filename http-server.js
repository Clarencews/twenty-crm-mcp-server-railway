import express from "express";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!TWENTY_API_KEY) {
  console.error("ERROR: TWENTY_API_KEY environment variable is required");
  process.exit(1);
}

if (!MCP_AUTH_TOKEN) {
  console.error("ERROR: MCP_AUTH_TOKEN environment variable is required");
  process.exit(1);
}

// Spawn the MCP server as a child process with stdio pipes
const mcpServerPath = join(__dirname, "index.js");
const mcpProcess = spawn("node", [mcpServerPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    TWENTY_API_KEY,
    TWENTY_BASE_URL,
  },
});

mcpProcess.on("error", (err) => {
  console.error("Failed to start MCP child process:", err);
  process.exit(1);
});

mcpProcess.on("exit", (code, signal) => {
  console.error(`MCP child process exited with code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

// Buffer for incomplete lines from stdout
let stdoutBuffer = "";

// Pending requests: map of id -> { resolve, reject, timer }
const pendingRequests = new Map();

mcpProcess.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();

  // MCP stdio uses newline-delimited JSON
  const lines = stdoutBuffer.split("\n");
  // Keep the last (potentially incomplete) line in the buffer
  stdoutBuffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      console.error("Failed to parse MCP stdout line:", trimmed);
      continue;
    }

    const id = message.id;
    if (id !== undefined && pendingRequests.has(id)) {
      const { resolve, timer } = pendingRequests.get(id);
      pendingRequests.delete(id);
      clearTimeout(timer);
      resolve(message);
    }
  }
});

// Send a JSON-RPC request to the MCP process and wait for its response
function sendToMcp(request) {
  return new Promise((resolve, reject) => {
    const id = request.id;
    const TIMEOUT_MS = 30_000;

    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP request timed out after ${TIMEOUT_MS}ms (id=${id})`));
      }
    }, TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });

    const payload = JSON.stringify(request) + "\n";
    mcpProcess.stdin.write(payload, (err) => {
      if (err) {
        pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to write to MCP stdin: ${err.message}`));
      }
    });
  });
}

// Middleware: validate Bearer token from Authorization header
function validateAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token || token !== MCP_AUTH_TOKEN) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid token" },
      id: null,
    });
  }

  next();
}

// POST /mcp — accepts JSON-RPC requests and proxies them to the MCP server
app.post("/mcp", validateAuth, async (req, res) => {
  const request = req.body;

  if (!request || typeof request !== "object") {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: request body must be a JSON object" },
      id: null,
    });
  }

  // Ensure the request has an id so we can match the response
  if (request.id === undefined || request.id === null) {
    request.id = Date.now();
  }

  try {
    const response = await sendToMcp(request);
    return res.json(response);
  } catch (err) {
    console.error("MCP proxy error:", err.message);
    return res.status(504).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: err.message },
      id: request.id ?? null,
    });
  }
});

// GET /health — health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "twenty-crm-mcp-server",
    uptime: process.uptime(),
    mcpProcess: mcpProcess.exitCode === null ? "running" : "exited",
  });
});

app.listen(PORT, () => {
  console.log(`Twenty CRM MCP HTTP server listening on port ${PORT}`);
  console.log(`  POST /mcp    — JSON-RPC proxy to MCP stdio server`);
  console.log(`  GET  /health — health check`);
  console.log(`  TWENTY_BASE_URL: ${TWENTY_BASE_URL}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  mcpProcess.kill("SIGTERM");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  mcpProcess.kill("SIGTERM");
  process.exit(0);
});
