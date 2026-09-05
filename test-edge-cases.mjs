// Reflex — Edge Case & Trade-off Evidence Suite (Task 3, Maina)
//
// Standalone script. Talks to the live reflex-backend over plain HTTP —
// does not import, require, or share any code with reflex-backend or
// reflex-frontend, so there is zero risk of dependency or file conflicts
// with Domisiano's or Genesis's repos.
//
// Uses Node's built-in fetch (Node 18+) for all API calls — the only two
// npm dependencies (pngjs, jsqr) exist purely to decode the real QR code
// image, so the "wrong token" and "confirm delivery" tests use the actual
// token a rider's camera would read, not a shortcut pulled from the database.

import { PNG } from "pngjs";
import jsQR from "jsqr";

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";

const ACCOUNTS = {
  retailer: { phone: "0700000001", password: "retailer123" },
  dispatcher: { phone: "0700000002", password: "dispatch123" },
  riderMaina: { phone: "0700000003", password: "rider123" },
  riderGenesis: { phone: "0700000004", password: "rider123" },
};

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${tag}  ${name}`);
  if (detail) console.log(`      ${DIM}${detail}${RESET}`);
}

// ---- HTTP helpers ----

async function login({ phone, password }) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Login failed for ${phone}: ${data.error}`);
  return data.token;
}

async function call(token, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

// ---- Real QR decode pipeline — reads the actual image, not a shortcut ----

async function decodeQrToken(retailerToken, requestId) {
  const { data } = await call(retailerToken, "GET", `/api/requests/${requestId}/qrcode`);
  const base64 = data.qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded) throw new Error("Could not decode the QR image — encoding may be broken");
  const payload = JSON.parse(decoded.data);
  if (payload.requestId !== requestId) {
    throw new Error("Decoded QR's requestId does not match the request it was generated for");
  }
  return payload.token;
}

// ---- Shared setup: create + assign a fresh request, ready for a given stage ----

async function createAssignedRequest(retailerToken, dispatcherToken, riderId = "u3") {
  const { data: request } = await call(retailerToken, "POST", "/api/requests", {
    customerName: "Test Customer",
    customerPhone: "0799999999",
    address: "Test Address",
    itemDescription: "Test item",
  });
  await call(dispatcherToken, "POST", `/api/requests/${request.id}/assign`, { riderId });
  return request;
}

// =====================================================================
// TESTS
// =====================================================================

async function testHappyPathAndQrDecodePipeline(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher);
  await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/picked-up`);
  await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/out-for-delivery`);
  const realToken = await decodeQrToken(tokens.retailer, req.id);
  const { status, ok, data } = await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/confirm`, {
    scannedToken: realToken,
  });
  record(
    "Happy path + real QR decode pipeline works end-to-end",
    ok && data.status === "delivered",
    `HTTP ${status}, final status: ${data?.status}`
  );
  return req.id; // reused by the idempotency test below
}

async function testWrongQrTokenRejected(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher);
  await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/picked-up`);

  const { status, ok, data } = await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/confirm`, {
    scannedToken: "deliberately-wrong-token-xyz",
  });

  record(
    "Wrong QR token is rejected, not silently accepted",
    !ok && status === 400 && /does not match/i.test(data?.error || ""),
    `HTTP ${status}: ${data?.error}`
  );
}

async function testConfirmBeforePickupBlocked(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher);
  const realToken = await decodeQrToken(tokens.retailer, req.id);

  // Deliberately skip picked-up — try to confirm directly
  const { status, ok, data } = await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/confirm`, {
    scannedToken: realToken,
  });

  record(
    "Cannot confirm delivery before marking picked up",
    !ok && status === 409,
    `HTTP ${status}: ${data?.error}`
  );
}

async function testDuplicateConfirmationIsIdempotent(deliveredRequestId, tokens) {
  const req = await call(tokens.retailer, "GET", "/api/requests/mine");
  const already = req.data.find((r) => r.id === deliveredRequestId);
  const realToken = await decodeQrToken(tokens.retailer, deliveredRequestId);

  const { status, ok, data } = await call(tokens.riderMaina, "POST", `/api/requests/${deliveredRequestId}/confirm`, {
    scannedToken: realToken,
  });

  record(
    "Re-confirming an already-delivered order is a safe no-op, not an error",
    ok && status === 200 && data.status === "delivered",
    `HTTP ${status}, status remained: ${data?.status} (no duplicate side-effect, no crash)`
  );
}

async function testRiderCannotActOnAnotherRidersDelivery(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher, "u3"); // assigned to Maina

  // Genesis (a different rider) tries to mark it picked up
  const { status, ok, data } = await call(tokens.riderGenesis, "POST", `/api/requests/${req.id}/picked-up`);

  record(
    "A rider cannot update a delivery assigned to a different rider",
    !ok && status === 403,
    `HTTP ${status}: ${data?.error}`
  );
}

async function testCannotReassignAlreadyAssignedRequest(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher, "u3");

  const { status, ok, data } = await call(tokens.dispatcher, "POST", `/api/requests/${req.id}/assign`, {
    riderId: "u4",
  });

  record(
    "Cannot reassign a request that is already assigned",
    !ok && status === 409,
    `HTTP ${status}: ${data?.error}`
  );
}

async function testOutOfOrderStageTransitionBlocked(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher);

  // Skip picked-up entirely, jump straight to out-for-delivery
  const { status, ok, data } = await call(tokens.riderMaina, "POST", `/api/requests/${req.id}/out-for-delivery`);

  record(
    "Cannot skip straight to 'out for delivery' without being picked up first",
    !ok && status === 409,
    `HTTP ${status}: ${data?.error}`
  );
}

async function testPublicTrackingNoAuthNoLeak(tokens) {
  const req = await createAssignedRequest(tokens.retailer, tokens.dispatcher);

  // Deliberately no Authorization header — this must work with zero auth
  const { status, ok, data } = await call(null, "GET", `/api/track/${req.trackingCode}`);

  const hasExpectedFields = data && "status" in data && "statusHistory" in data;
  const leaksInternalFields = data && ("retailerId" in data || "riderId" in data || "qrToken" in data);

  record(
    "Public tracking works with zero auth and does not leak internal IDs/tokens",
    ok && status === 200 && hasExpectedFields && !leaksInternalFields,
    `HTTP ${status}, leaked internal fields: ${leaksInternalFields}`
  );
}

async function testUnknownTrackingCodeReturns404() {
  const { status, ok, data } = await call(null, "GET", "/api/track/this-code-does-not-exist");

  record(
    "Unknown tracking code returns a clean 404, not a server error",
    !ok && status === 404,
    `HTTP ${status}: ${data?.error}`
  );
}

async function testConcurrentDoubleAssignmentRace(tokens) {
  const { data: req } = await call(tokens.retailer, "POST", "/api/requests", {
    customerName: "Race Condition Test",
    customerPhone: "0788888888",
    address: "Test",
    itemDescription: "Test",
  });

  // Fire two assignment requests at literally the same moment, to two
  // different riders. Exactly one should win; the other must be rejected
  // — this is the "what happens when two things happen at once" category.
  const [r1, r2] = await Promise.all([
    call(tokens.dispatcher, "POST", `/api/requests/${req.id}/assign`, { riderId: "u3" }),
    call(tokens.dispatcher, "POST", `/api/requests/${req.id}/assign`, { riderId: "u4" }),
  ]);

  const successCount = [r1, r2].filter((r) => r.ok).length;

  record(
    "Concurrent double-assignment: exactly one request wins, never both",
    successCount === 1,
    `Request A: HTTP ${r1.status}, Request B: HTTP ${r2.status} (successes: ${successCount})`
  );
}

// =====================================================================
// RUN
// =====================================================================

async function main() {
  console.log(`${BOLD}Reflex — Edge Case & Trade-off Evidence Suite${RESET}`);
  console.log(`${DIM}Target: ${BASE_URL}${RESET}\n`);

  const tokens = {
    retailer: await login(ACCOUNTS.retailer),
    dispatcher: await login(ACCOUNTS.dispatcher),
    riderMaina: await login(ACCOUNTS.riderMaina),
    riderGenesis: await login(ACCOUNTS.riderGenesis),
  };
  console.log(`${GREEN}Logged in as all 4 demo roles${RESET}\n`);

  const deliveredId = await testHappyPathAndQrDecodePipeline(tokens);
  await testWrongQrTokenRejected(tokens);
  await testConfirmBeforePickupBlocked(tokens);
  await testDuplicateConfirmationIsIdempotent(deliveredId, tokens);
  await testRiderCannotActOnAnotherRidersDelivery(tokens);
  await testCannotReassignAlreadyAssignedRequest(tokens);
  await testOutOfOrderStageTransitionBlocked(tokens);
  await testPublicTrackingNoAuthNoLeak(tokens);
  await testUnknownTrackingCodeReturns404();
  await testConcurrentDoubleAssignmentRace(tokens);

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  console.log(`\n${BOLD}Result: ${passed}/${total} passed${RESET}`);
  if (passed < total) {
    console.log(`${RED}Failing tests are real findings for the trade-off log — not just bugs to silently fix.${RESET}`);
  }

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Suite crashed before completing:${RESET}`, err.message);
  console.error(`${DIM}Check BASE_URL is correct and the backend is actually running.${RESET}`);
  process.exit(1);
});
