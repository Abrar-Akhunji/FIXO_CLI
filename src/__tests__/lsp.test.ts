import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LspClient, filePathToUri } from "../lsp/lsp-client.js";
import { LspManager } from "../lsp/lsp-manager.js";

test("LspClient lifecycle, synchronization and queries with a mock LSP server", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-lsp-test-"));
  const mockServerPath = path.join(tempDir, "mock-lsp.js");

  const mockServerCode = `
import { Buffer } from 'buffer';

let buffer = '';
process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const contentLengthMatch = buffer.match(/Content-Length:\\s*(\\d+)/i);
    if (!contentLengthMatch) break;
    const length = parseInt(contentLengthMatch[1], 10);
    const headerEndIndex = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEndIndex === -1) break;

    const bodyStartIndex = headerEndIndex + 4;
    if (buffer.length < bodyStartIndex + length) break;

    const rawBody = buffer.slice(bodyStartIndex, bodyStartIndex + length);
    buffer = buffer.slice(bodyStartIndex + length);

    try {
      const request = JSON.parse(rawBody);
      handleMessage(request);
    } catch (err) {
      // ignore parse errors
    }
  }
});

function sendResponse(id, result) {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  });
  const payload = \`Content-Length: \${Buffer.byteLength(response, 'utf-8')}\\r\\n\\r\\n\${response}\`;
  process.stdout.write(payload);
}

function sendNotification(method, params) {
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params
  });
  const payload = \`Content-Length: \${Buffer.byteLength(notification, 'utf-8')}\\r\\n\\r\\n\${notification}\`;
  process.stdout.write(payload);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendResponse(msg.id, { capabilities: {} });
  } else if (msg.method === 'textDocument/didOpen') {
    // Send diagnostics on open
    sendNotification('textDocument/publishDiagnostics', {
      uri: msg.params.textDocument.uri,
      diagnostics: [
        {
          range: {
            start: { line: 2, character: 1 },
            end: { line: 2, character: 10 }
          },
          severity: 1,
          message: 'Mock compile warning/error'
        }
      ]
    });
  } else if (msg.method === 'textDocument/definition') {
    sendResponse(msg.id, {
      uri: msg.params.textDocument.uri,
      range: {
        start: { line: 10, character: 5 },
        end: { line: 10, character: 15 }
      }
    });
  } else if (msg.method === 'textDocument/references') {
    sendResponse(msg.id, [
      {
        uri: msg.params.textDocument.uri,
        range: {
          start: { line: 12, character: 2 },
          end: { line: 12, character: 8 }
        }
      }
    ]);
  } else if (msg.method === 'textDocument/hover') {
    sendResponse(msg.id, {
      contents: {
        kind: 'markdown',
        value: '### Mock Hover'
      }
    });
  } else if (msg.method === 'shutdown') {
    sendResponse(msg.id, null);
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}
`;

  fs.writeFileSync(mockServerPath, mockServerCode, "utf-8");

  // Instantiate and run LspClient against the mock server script
  const client = new LspClient("node", [mockServerPath], tempDir);
  await client.start();

  const testFile = path.join(tempDir, "test.ts");
  fs.writeFileSync(testFile, "const x = 42;", "utf-8");

  // Test didOpen and diagnostics receiving
  client.syncFile(testFile, "const x = 42;");

  // Wait a short moment for notification to arrive
  await new Promise((resolve) => setTimeout(resolve, 100));

  const diagnostics = client.getDiagnostics(testFile);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "Mock compile warning/error");
  assert.equal(diagnostics[0].severity, 1);

  // Test gotoDefinition
  const def = await client.gotoDefinition(testFile, 0, 6);
  assert.ok(def);
  assert.equal(def.range.start.line, 10);

  // Test findReferences
  const refs = await client.findReferences(testFile, 0, 6);
  assert.ok(Array.isArray(refs));
  assert.equal(refs[0].range.start.line, 12);

  // Test hover
  const hoverVal = await client.hover(testFile, 0, 6);
  assert.ok(hoverVal);
  assert.equal(hoverVal.contents.value, "### Mock Hover");

  // Stop client
  await client.stop();

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("LspManager gracefully degrades for unsupported extensions and missing binaries", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixo-lsp-manager-test-"),
  );
  const manager = new LspManager(tempDir);

  // Unsupported file extension should degrade gracefully (return null/empty diagnostics)
  const def = await manager.gotoDefinition("test.xyz", 0, 0);
  assert.equal(def, null);

  const refs = await manager.findReferences("test.xyz", 0, 0);
  assert.equal(refs, null);

  const hoverVal = await manager.hover("test.xyz", 0, 0);
  assert.equal(hoverVal, null);

  const diagnostics = await manager.getDiagnostics("test.xyz");
  assert.deepEqual(diagnostics, []);

  // Cleanup
  await manager.stopAll();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
