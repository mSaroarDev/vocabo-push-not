/**
 * send-notifications.js
 *
 * 1. Connects to PostgreSQL
 * 2. Reads all device tokens from push_notification_tokens.token
 * 3. Sends a push notification to each token via Firebase Admin SDK (FCM)
 *
 * Setup:
 *   npm install pg firebase-admin dotenv
 *
 * Env vars (put these in a .env file, see .env.example):
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname
 *   FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
 *
 * Run:
 *   node send-notifications.js
 */

require("dotenv").config();
const { Client } = require("pg");
const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const path = require("path");

// ---------- Config ----------
const DB_URL = process.env.DATABASE_URL || "test_url";
const SERVICE_ACCOUNT_PATH = JSON.parse(
  process.env.GOOGLE_SERVICE_ACCOUNT
);

const NOTIFICATION = {
  title: "Vocabo-র নতুন অ্যাপ: আরও ফাস্ট, আরও সুন্দর!",
  description: "প্রযুক্তিগত জটিলতার কারণে এই অ্যাপটি শীঘ্রই বন্ধ হয়ে যাবে। তাই দ্রুত শিফট করুন নতুন অ্যাপ এ", // mapped to FCM's "body" field below
};

// ---------- Firebase init ----------
// firebase-admin v14 uses flat module exports (firebase-admin/app, firebase-admin/messaging)
// instead of the old admin.credential.cert(...) nested API.
initializeApp({
  credential: cert(require(path.resolve(SERVICE_ACCOUNT_PATH))),
});
const messaging = getMessaging();

// ---------- Main ----------
async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  let tokens = [];
  try {
    const result = await client.query(
      "SELECT token FROM push_notification_tokens WHERE token IS NOT NULL"
    );
    tokens = result.rows.map((row) => row.token).filter(Boolean);
  } finally {
    await client.end();
  }

  console.log(`Found ${tokens.length} token(s).`);

  if (tokens.length === 0) {
    console.log("No tokens to send to. Exiting.");
    return;
  }

  // Firebase's sendEachForMulticast caps at 500 tokens per call, so we batch.
  // At 20k+ tokens that's 40+ calls — a small delay between batches keeps us
  // well clear of FCM's per-project rate limits and avoids one bad batch
  // taking down the whole run.
  const BATCH_SIZE = 500;
  const DELAY_BETWEEN_BATCHES_MS = 300;
  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const batchNum = i / BATCH_SIZE + 1;
    const totalBatches = Math.ceil(tokens.length / BATCH_SIZE);

    const message = {
      notification: {
        title: NOTIFICATION.title,
        body: NOTIFICATION.description,
      },
      tokens: batch,
    };

    let response;
    try {
      response = await messaging.sendEachForMulticast(message);
    } catch (err) {
      console.error(`Batch ${batchNum}/${totalBatches} failed entirely:`, err.message);
      failureCount += batch.length;
      continue; // move on to the next batch rather than aborting the whole run
    }

    successCount += response.successCount;
    failureCount += response.failureCount;
    console.log(
      `Batch ${batchNum}/${totalBatches}: ${response.successCount} sent, ${response.failureCount} failed`
    );

    response.responses.forEach((res, idx) => {
      if (!res.success) {
        const code = res.error?.code;
        // These two error codes mean the token is dead and should be removed from your DB.
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(batch[idx]);
        }
      }
    });

    if (i + BATCH_SIZE < tokens.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`\nDone. Success: ${successCount}, Failed: ${failureCount}`);

  if (invalidTokens.length > 0) {
    console.log(
      `\n${invalidTokens.length} token(s) are invalid/unregistered and should be deleted from the DB:`
    );
    console.log(invalidTokens);

    // Uncomment to auto-clean invalid tokens from the database:
    /*
    const cleanupClient = new Client({ connectionString: DB_URL });
    await cleanupClient.connect();
    await cleanupClient.query(
      "DELETE FROM push_notification_tokens WHERE token = ANY($1)",
      [invalidTokens]
    );
    await cleanupClient.end();
    console.log("Invalid tokens removed from DB.");
    */
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
}

module.exports = { main };