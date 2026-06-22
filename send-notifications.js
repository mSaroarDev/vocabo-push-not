/**
 * send-notifications.js
 */

require("dotenv").config();
const { Client } = require("pg");
const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

// ---------- Config ----------
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  throw new Error("DATABASE_URL is missing");
}

// ---------- Firebase Init ----------
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
} catch (err) {
  throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT JSON");
}

initializeApp({
  credential: cert(serviceAccount),
});

const messaging = getMessaging();

// ---------- Notification ----------
const NOTIFICATION = {
  title: "Vocabo-র নতুন অ্যাপ: আরও ফাস্ট, আরও সুন্দর!",
  description:
    "প্রযুক্তিগত জটিলতার কারণে এই অ্যাপটি শীঘ্রই বন্ধ হয়ে যাবে। তাই দ্রুত শিফট করুন নতুন অ্যাপ এ",
};

// ---------- Helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const BATCH_SIZE = 500;
  const DELAY_BETWEEN_BATCHES_MS = 300;

  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = [];

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
      console.error(
        `Batch ${batchNum}/${totalBatches} failed:`,
        err.message
      );
      failureCount += batch.length;
      continue;
    }

    successCount += response.successCount;
    failureCount += response.failureCount;

    console.log(
      `Batch ${batchNum}/${totalBatches}: ${response.successCount} sent, ${response.failureCount} failed`
    );

    response.responses.forEach((res, idx) => {
      if (!res.success) {
        const code = res.error?.code;

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
    console.log(`\nInvalid tokens:`, invalidTokens);

    // Optional cleanup
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

// ---------- Run ----------
if (require.main === module) {
  main().catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
}

module.exports = { main };